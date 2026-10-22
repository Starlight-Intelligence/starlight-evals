#!/usr/bin/env node
// Harness arena orchestrator. Starts N contestant harnesses on the same pinned playbook tasks,
// each in its own container, collects their trial rows, finishes LLM-judged tasks with a grader
// from another vendor, asks Starlight Kernel for one signed receipt per contestant, and writes the
// results table plus Team Card team-run rows.
//
//   node harness/arena/run-arena.mjs --pack <dir of playbooks/multi-agent-ops> --tasks T01,T09 --out DIR \
//     [--runtime local|docker|railway-plan] [--contestants a,b] [--mock good|bad|noop] [--trials N] \
//     [--kernel <starlight-kernel/bin/starlight.mjs>] [--container-cli docker|podman]
//
// runtime local runs each contestant as a host process (dry runs). docker runs each in its own
// container from harness/arena/containers. railway-plan writes the Railway services to create and
// starts nothing: deploys and spend are Frank's.
// Exit: 0 done, 2 usage, 4 a paid run refused before any spend.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, aggregate, paidRunRefusals, passOf, readCaps, sha256, toTeamRun } from './lib.mjs';
import { issueArenaReceipt } from './kernel/receipt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const configPath = path.resolve(opt('config', path.join(HERE, 'arena.config.json')));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const runtime = opt('runtime', 'local');
const mock = opt('mock') ?? null;
const pack = opt('pack') && path.resolve(opt('pack'));
const outDir = path.resolve(opt('out', path.join(REPO, 'harness', 'arena', 'runs', new Date().toISOString().slice(0, 10))));
const arenaId = opt('arena-id', new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z');
const wanted = opt('contestants') ? opt('contestants').split(',') : null;
const kernelBin = opt('kernel', process.env.STARLIGHT_KERNEL_BIN) && path.resolve(opt('kernel', process.env.STARLIGHT_KERNEL_BIN));
const contestants = config.contestants.filter((c) => c.harness && (!wanted || wanted.includes(c.id)));
const notRunnable = config.contestants.filter((c) => !c.harness);

if (!['local', 'docker', 'railway-plan'].includes(runtime) || (!pack && runtime !== 'railway-plan' && !argv.includes('--collect-only')) || !contestants.length) {
  console.error('usage: run-arena.mjs --pack DIR [--runtime local|docker|railway-plan] [--tasks T01,T09] [--mock good|bad|noop] [--out DIR]');
  process.exit(EXIT.usage);
}
mkdirSync(outDir, { recursive: true });

// Refuse a paid arena here as well as in each container, so nothing is built or deployed for it.
if (!mock) {
  const contractSha = pack ? sha256(readFileSync(path.join(pack, 'evals', 'contract.json'))) : config.contract.sha256;
  const refusals = contestants.flatMap((c) => paidRunRefusals(config, c, { env: runtime === 'railway-plan' ? Object.fromEntries((c.credentials ?? []).map((x) => [x.env, 'set in Railway'])) : process.env, contractSha, contestantsStarted: contestants.length }).map((r) => `${c.id}: ${r}`));
  if (refusals.length) {
    writeFileSync(path.join(outDir, 'refused.json'), JSON.stringify({ arenaId, refusals }, null, 2) + '\n');
    console.error(`paid arena refused before any spend:\n  ${refusals.join('\n  ')}`);
    process.exit(EXIT.refused);
  }
}

const contestantArgs = (c, packArg, outArg) => ['--contestant', c.id, '--pack', packArg, '--out', outArg, '--arena-id', arenaId, '--contestants-started', String(contestants.length),
  ...(opt('tasks') ? ['--tasks', opt('tasks')] : []), ...(opt('trials') ? ['--trials', opt('trials')] : []), ...(mock ? ['--mock', mock] : [])];

function runLocal(c) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 'contestant.mjs'), '--config', configPath, ...contestantArgs(c, pack, path.join(outDir, c.id))], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    p.stdout.on('data', (d) => process.stdout.write(`[${c.id}] ${d}`));
    p.stderr.on('data', (d) => process.stderr.write(`[${c.id}] ${d}`));
    p.on('close', (code) => resolve(code));
  });
}

// Each contestant gets its own container; only that contestant's credential names cross in, as
// -e NAME with the value taken from this environment, never written into argv.
function runDocker(c) {
  const cli = opt('container-cli', 'docker');
  const image = `starlight-arena/${c.id}:${arenaId.toLowerCase()}`;
  const build = spawnSync(cli, ['build', '-f', path.join(REPO, c.image), '-t', image, REPO], { stdio: 'inherit' });
  if (build.status !== 0) return Promise.resolve(build.status ?? 1);
  return new Promise((resolve) => {
    const args = ['run', '--rm', '--name', `arena-${c.id}-${arenaId.toLowerCase()}`, '--memory', '6g', '--pids-limit', '1000',
      ...(c.credentials ?? []).flatMap((x) => ['-e', x.env]),
      '-v', `${pack}:/pack:ro`, '-v', `${path.join(outDir, c.id)}:/out`, image, ...contestantArgs(c, '/pack', '/out')];
    const p = spawn(cli, args, { stdio: 'inherit' });
    p.on('close', (code) => resolve(code));
  });
}

function railwayPlan() {
  const services = contestants.map((c) => ({
    service: `arena-${c.id}`,
    dockerfilePath: c.image,
    railwayJson: path.join(path.dirname(c.image), 'railway.json').replace(/\\/g, '/'),
    variables: [...(c.credentials ?? []).map((x) => ({ name: x.env, source: x.infisical })), { name: 'PLAYBOOKS_READ_TOKEN', source: '[OPEN] a fine-grained read-only token on Starlight-Intelligence/starlight-playbooks, in Infisical' }, { name: 'PLAYBOOKS_COMMIT', value: config.contract.commit }, { name: 'ARENA_UPLOAD_URL', source: 'a presigned PUT URL per run, minted by the orchestrator ([OPEN]: bucket not chosen)' }],
    startCommand: `node /arena/harness/arena/contestant.mjs ${contestantArgs(c, '/pack', '/out').join(' ')}`,
  }));
  const plan = {
    arenaId, createdAt: new Date().toISOString(), status: 'plan only: nothing deployed',
    gate: 'Creating these services and deploying them is spend. Frank sets caps.perRunUsd and caps.perArenaUsd, approves the deploy, and the orchestrator refuses a paid run until both caps are set.',
    project: '[OPEN] a separate Railway project from the CI-runners pilot (railway-ci-runners), so arena jobs never share its runner host or its App key',
    services,
    steps: ['railway link (the arena project)', ...services.map((s) => `railway up --service ${s.service} --detach   # from the starlight-evals root; builds ${s.dockerfilePath}`), 'download each contestant bundle into <out>/<contestant>/, then: node harness/arena/run-arena.mjs --collect-only --out <out> --kernel <starlight-kernel/bin/starlight.mjs>'],
  };
  writeFileSync(path.join(outDir, 'railway-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  console.log(`railway plan written to ${path.join(outDir, 'railway-plan.json')}; nothing deployed`);
}

if (runtime === 'railway-plan') { railwayPlan(); process.exit(EXIT.ok); }

// --collect-only reads bundles that containers already wrote into --out (Railway uploads, say).
if (!argv.includes('--collect-only')) {
  console.log(`arena ${arenaId}: ${contestants.map((c) => c.id).join(', ')} on ${opt('tasks') ?? 'all tasks'} (${runtime}${mock ? `, mock ${mock}` : ''})`);
  await Promise.all(contestants.map((c) => (runtime === 'docker' ? runDocker(c) : runLocal(c))));
}

// ---- collect -------------------------------------------------------------------------------
const readRows = (dir) => (existsSync(path.join(dir, 'trials.jsonl')) ? readFileSync(path.join(dir, 'trials.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readStatus = (dir) => (existsSync(path.join(dir, 'contestant.json')) ? JSON.parse(readFileSync(path.join(dir, 'contestant.json'), 'utf8')) : { status: 'missing' });

// LLM-judged tasks (T29) are finished here, outside the contestant's container, by a grader whose
// vendor is neither the pack's maker (anthropic) nor the contestant's. A dry run leaves them
// ungraded rather than inventing a verdict.
function finishLlm(row) {
  if (!row.llm) return row;
  const reason = mock ? 'not graded: pipeline test' : 'not graded: the LLM grader step needs caps and an OpenRouter key on the orchestrator ([OPEN], not wired in v0.1)';
  return { ...row, llm: { ...row.llm, verdict: null, reason }, pass: passOf(row.scores, { llmGraded: true, llmVerdict: null }) };
}

function manifest(dir) {
  const t = path.join(dir, 'transcripts');
  const lines = [];
  if (existsSync(t)) for (const d of readdirSync(t).sort()) for (const f of readdirSync(path.join(t, d)).sort()) lines.push(`${sha256(readFileSync(path.join(t, d, f)))}  transcripts/${d}/${f}`);
  writeFileSync(path.join(dir, 'transcripts.sha256'), lines.join('\n') + '\n');
  return lines.length;
}

const results = { schema: 'arena-results.v0', arenaId, createdAt: new Date().toISOString(), pipelineTest: mock !== null, mock, runtime, contract: { ...config.contract, preregistered: false }, caps: readCaps(config), contestants: [], notRun: notRunnable.map((c) => ({ id: c.id, status: c.status, note: c.note })), trials: [] };
for (const c of contestants) {
  const dir = path.join(outDir, c.id);
  const status = readStatus(dir);
  const rows = readRows(dir).map(finishLlm);
  results.contract.preregistered ||= !!status.preregistered;
  const entry = { id: c.id, harness: c.harness, vendor: c.vendor, model: rows[0]?.model ?? c.model, pins: c.pins, status: status.status, refusals: status.refusals ?? [], blockers: status.blockers ?? [], knownBlockers: c.knownBlockers ?? [], aggregate: aggregate(rows), receipt: null, kernelGap: null };
  if (rows.length) writeFileSync(path.join(dir, 'trials.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (rows.length && manifest(dir)) {
    const grader = mock ? `shell:${path.join(HERE, 'kernel', 'pipeline-grader.mjs')}` : config.kernel.graders[c.vendor];
    if (!kernelBin || !existsSync(kernelBin)) entry.kernelGap = 'starlight-kernel not available on this machine (pass --kernel or STARLIGHT_KERNEL_BIN)';
    else if (!grader) entry.kernelGap = `no kernel grader is routed for vendor ${c.vendor}; the kernel's vendor list is anthropic, openai, google, xai, local`;
    else {
      const compact = rows.map(({ details, ...r }) => r);
      const bundle = { schema: 'arena-bundle.v0', arenaId, contestant: c.id, contractSha256: rows[0].contractSha256, pipelineTest: mock !== null, aggregate: entry.aggregate };
      const r = issueArenaReceipt({ kernelBin, workDir: path.join(outDir, '_kernel'), contestant: c, bundle, rows: compact, evidenceDir: dir, grader });
      if (r.gap) entry.kernelGap = r.gap;
      else {
        // The receipt and the issuer's public key travel with the results; the kernel home, which
        // holds the private signing key, stays in _kernel and is never published.
        mkdirSync(path.join(outDir, 'receipts'), { recursive: true });
        const rel = path.join('receipts', `${c.id}.receipt.json`);
        copyFileSync(r.receipt.file, path.join(outDir, rel));
        copyFileSync(path.join(outDir, '_kernel', 'issuer-public.pem'), path.join(outDir, 'receipts', 'issuer-public.pem'));
        entry.receipt = { ...r.receipt, file: rel.replace(/\\/g, '/'), grader: r.receipt.grader.startsWith('shell:') ? `shell:${path.basename(r.receipt.grader)}` : r.receipt.grader };
        entry.receiptVerify = r.verify;
      }
    }
  }
  results.contestants.push(entry);
  results.trials.push(...rows.map(({ details, ...r }) => r));
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
writeFileSync(path.join(outDir, 'team-run.jsonl'), results.trials.map((t) => JSON.stringify(toTeamRun(t))).join('\n') + (results.trials.length ? '\n' : ''));

// ---- table -----------------------------------------------------------------------------------
const money = (v) => (v === null || v === undefined ? 'unknown' : `$${v.toFixed(4)}`);
const md = [
  `# Harness arena ${arenaId}${mock ? ` (pipeline test, mock model: ${mock})` : ''}`, '',
  `Contract ${config.contract.pack} ${config.contract.version}, sha256 \`${config.contract.sha256.slice(0, 16)}…\`, pre-registered: ${results.contract.preregistered ? 'yes' : 'no'}. Caps: per run ${results.caps.perRunUsd ?? 'unset'}, per arena ${results.caps.perArenaUsd ?? 'unset'}.`, '',
  '| Contestant | Status | Pass | Wall time | Tokens in / out | Cost | Cost per pass | Tool calls | Refused / escalated / held gate | Kernel receipt |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...results.contestants.map((e) => { const a = e.aggregate; return `| ${e.id} | ${e.status}${e.blockers.length ? ` (${e.blockers.map((b) => b.id).join(', ')})` : ''} | ${a.passes}/${a.graded} | ${(a.wallMs / 1000).toFixed(1)} s | ${a.tokens.input} / ${a.tokens.output} | ${money(a.costUsd)} | ${money(a.costPerPassUsd)} | ${a.toolCalls} | ${a.events.refusedUnsafe} / ${a.events.escalated} / ${a.events.heldGate} | ${e.receipt ? `${e.receipt.verdict}, verify exit ${e.receiptVerify.exit}` : e.kernelGap ? `gap: ${e.kernelGap}` : 'none'} |`; }),
  ...results.notRun.map((n) => `| ${n.id} | ${n.status} | | | | | | | | |`),
  '', '| Trial | Pass | collision / bad_merge / recovery / task_success | Wall | Tool calls | Cost | Events |', '|---|---|---|---|---|---|---|',
  ...results.trials.map((t) => `| ${t.trialId} | ${t.pass} | ${t.scores.collision} / ${t.scores.bad_merge} / ${t.scores.recovery} / ${t.scores.task_success} | ${(t.wallMs / 1000).toFixed(1)} s | ${t.toolCalls} | ${money(t.costUsd)} | ${t.events ? Object.entries(t.events).filter(([k, v]) => k !== 'method' && v).map(([k]) => k).join(', ') || '-' : '-'} |`),
  '', mock ? 'Pipeline test: the mock model replays the playbook reference scripts. Token counts are synthetic and costs are 0 or unknown; nothing here measures a harness.' : '', '',
];
writeFileSync(path.join(outDir, 'RESULTS.md'), md.join('\n'));
console.log(md.slice(4, 5 + results.contestants.length + results.notRun.length).join('\n'));
console.log(`\nresults: ${path.join(outDir, 'results.json')}`);
