#!/usr/bin/env node
// Runs one contestant harness over the pinned playbook tasks, inside that contestant's container
// (or on the host for a dry run). Per trial: build the task's fixture, run the harness headless in
// the fixture's work tree, grade the sandbox with the playbook's own deterministic grader, and
// append one row to trials.jsonl. LLM-judged tasks are finished by the orchestrator, outside this
// container, so the maker never holds its own grader.
//
//   node harness/arena/contestant.mjs --contestant claude-code --pack <dir of playbooks/multi-agent-ops> \
//     --tasks T01,T09 --out DIR [--mock good|bad|noop] [--trials N] [--arena-id ID] [--contestants-started N] [--keep]
//
// Exit: 0 ran (or recorded a blocker), 2 usage, 3 contract mismatch, 4 refused before any spend.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADAPTERS, priceCost } from './adapters.mjs';
import { EXIT, OUT_OF_CREDIT, aggregate, lightEvents, openrouterPreflight, outOfCreditInStream, paidRunRefusals, passOf, readCaps, redactCredentials, sha256, shareOf } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const config = JSON.parse(readFileSync(path.resolve(opt('config', path.join(HERE, 'arena.config.json'))), 'utf8'));
const contestant = config.contestants.find((c) => c.id === opt('contestant'));
const pack = opt('pack') && path.resolve(opt('pack'));
const outDir = opt('out') && path.resolve(opt('out'));
const mock = opt('mock') ?? null;
if (!contestant?.harness || !pack || !outDir || (mock && !['good', 'bad', 'noop'].includes(mock))) {
  console.error('usage: contestant.mjs --contestant ID --pack DIR --out DIR [--tasks T01,T02] [--mock good|bad|noop]');
  process.exit(EXIT.usage);
}
const adapter = ADAPTERS[contestant.harness];
const EVALS = path.join(pack, 'evals');
const contractBytes = readFileSync(path.join(EVALS, 'contract.json'));
const contractSha = sha256(contractBytes);
const contract = JSON.parse(contractBytes);
const arenaId = opt('arena-id', new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z');
const trials = +opt('trials', config.trials ?? 1);
const contestantsStarted = +opt('contestants-started', 1);
const wanted = opt('tasks') ? opt('tasks').split(',').map((s) => s.trim()) : null;
const tasks = contract.tasks.filter((t) => !wanted || wanted.includes(t.id));
const caps = readCaps(config);
const share = shareOf(config, contestantsStarted);

// A destination that already holds trials would mix two arenas in one bundle.
if (existsSync(path.join(outDir, 'trials.jsonl'))) { console.error(`${outDir} already holds trials.jsonl; use a fresh --out`); process.exit(EXIT.usage); }
mkdirSync(outDir, { recursive: true });
const status = { arenaId, contestant: contestant.id, harness: contestant.harness, mock, contractSha256: contractSha, preregistered: (config.contract.preregistrations ?? []).some((p) => p.sha256 === contractSha), startedAt: new Date().toISOString() };
const finish = (code, extra) => { writeFileSync(path.join(outDir, 'contestant.json'), JSON.stringify({ ...status, ...extra, endedAt: new Date().toISOString() }, null, 2) + '\n'); process.exit(code); };

// In a container this supervisor is root and every agent runs as ARENA_AGENT_USER, so the agent can
// write neither /out, the pack, the grader nor this process's memory. An agent never runs as root.
let agentUser = null;
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const name = process.env.ARENA_AGENT_USER;
  const id = (flag) => Number((spawnSync('id', [flag, String(name)], { encoding: 'utf8' }).stdout || '').trim());
  agentUser = name ? { name, uid: id('-u'), gid: id('-g') } : null;
  if (!agentUser || !Number.isInteger(agentUser.uid) || agentUser.uid === 0) finish(EXIT.refused, { status: 'refused', refusals: ['running as root needs ARENA_AGENT_USER naming an unprivileged user for the agent'] });
}

if (contractSha !== config.contract.sha256) finish(EXIT.contract, { status: 'refused', refusals: [`contract.json is ${contractSha}, config pins ${config.contract.sha256}`] });
if (wanted && tasks.length !== wanted.length) finish(EXIT.usage, { status: 'refused', refusals: [`unknown task in ${wanted.join(',')}`] });
if ((config.contract.dataClass ?? 1) > (contestant.maxDataClass ?? 1)) finish(EXIT.refused, { status: 'refused', refusals: [`task data class ${config.contract.dataClass} exceeds this contestant's limit ${contestant.maxDataClass}`] });

// A paid run must clear every admission rule before anything is built or called.
if (!mock) {
  // ARENA_RUNTIME is set by the contestant images; a host process stays "local" and is refused.
  const refusals = paidRunRefusals(config, contestant, { env: process.env, contractSha, contestantsStarted, runtime: process.env.ARENA_RUNTIME === 'container' ? 'container' : 'local' });
  if (refusals.length) finish(EXIT.refused, { status: 'refused', refusals });
  if (contestant.credentials?.some((c) => c.env === 'OPENROUTER_API_KEY')) {
    const pre = await openrouterPreflight(process.env.OPENROUTER_API_KEY);
    if (!pre.ok) finish(EXIT.ok, { status: 'blocked', blockers: [{ id: pre.blocker, detail: pre.detail }] });
    // OpenRouter's key limit is the one hard cap the arena can read back; it must exist and fit the share.
    if (pre.limit === null || pre.limit > share) finish(EXIT.refused, { status: 'refused', refusals: [`the OpenRouter key's limit (${pre.limit ?? 'none'}) must be set and at or under this contestant's share (${share})`] });
  }
}

// The pack ships its own Windows adapter for its bash fixtures (LF copies, jq and mkdir shims); on
// Linux, which is where containers run, it returns the pack unchanged.
const { prepare, shellPath } = await import(pathToFileURL(path.join(EVALS, 'selftest', 'platform.mjs')).href);
const root = mkdtempSync(path.join(tmpdir(), `arena-${contestant.id}-`));
const runtime = prepare(EVALS, root);
const E = runtime.evals;

// Only the names a harness needs reach it: its own credential, a toolchain PATH, and the git and
// pager settings the playbook's own runner uses. Nothing else from this process's environment.
const PASS_THROUGH = ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'windir', 'LANG', 'TZ', 'XDG_CACHE_HOME'];
function agentEnv(sb) {
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k]) env[k] = process.env[k];
  for (const c of contestant.credentials ?? []) if (process.env[c.env]) env[c.env] = process.env[c.env];
  // codex exec reads CODEX_API_KEY in headless mode; which name 0.163 honors is checked on the first live run.
  if (contestant.harness === 'codex' && env.OPENAI_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
  if (contestant.harness === 'opencode-omo') env.OPENCODE_CONFIG = path.join(sb, 'home', '.config', 'opencode', 'opencode.json');
  return { ...env, PATH: [path.join(sb, 'bin'), runtime.env.PATH ?? process.env.PATH].join(path.delimiter), HOME: shellPath(path.join(sb, 'home')), TMPDIR: shellPath(path.join(sb, 'home')), GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', TERM: 'dumb', SB: shellPath(sb) };
}

// omo 2.5.1 reads ~/.config/opencode/oh-my-opencode.json; OpenCode reads OPENCODE_CONFIG. Both are
// written into the trial's own HOME so no host or image config leaks in.
function prepareHarnessHome(sb) {
  if (contestant.harness !== 'opencode-omo') return;
  const dir = path.join(sb, 'home', '.config', 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [`oh-my-opencode@${contestant.pins['oh-my-opencode']}`], model: contestant.model, permission: { edit: 'allow', bash: 'allow', webfetch: 'deny' }, autoupdate: false }, null, 2));
  const sub = { model: contestant.subagentModel ?? contestant.model };
  writeFileSync(path.join(dir, 'oh-my-opencode.json'), JSON.stringify({ agents: { Sisyphus: { model: contestant.model }, 'Planner-Sisyphus': { model: contestant.model }, oracle: sub, librarian: sub, explore: sub }, disabled_agents: ['frontend-ui-ux-engineer', 'multimodal-looker'] }, null, 2));
}

// Unknown stays unknown: an incomplete usage report is never priced as zero.
const costOf = (parsed) => (!parsed.usageComplete ? null : contestant.costSource === 'pricing' ? priceCost(config.pricing, contestant.model, parsed.tokens) : parsed.costUsd);

function runAgent(task, sb, budgetUsd) {
  const timeoutMs = contract.harness.limits.wallClockSecondsPerTrial * 1000;
  const spec = mock
    ? { cmd: process.execPath, args: [path.join(HERE, 'mock-agent.mjs'), '--harness', contestant.harness, '--reference', mock === 'noop' ? 'noop' : shellPath(path.join(E, 'reference', `${task.id}.${mock}.sh`))], stdin: null }
    : adapter.command({ model: contestant.model, systemPrompt: contract.harness.systemPrompt, prompt: task.prompt, perRunUsd: budgetUsd });
  return new Promise((resolve) => {
    // Its own process group on Linux, so a kill takes the harness's workers and subagents with it.
    // In a container the supervisor is root and the agent runs as the unprivileged arena user.
    const group = process.platform !== 'win32';
    const p = spawn(spec.cmd, spec.args, { cwd: path.join(sb, 'work'), env: agentEnv(sb), stdio: ['pipe', 'pipe', 'pipe'], detached: group, ...(agentUser ? { uid: agentUser.uid, gid: agentUser.gid } : {}) });
    let out = ''; let err = ''; let finished = 'done';
    // Credit errors are matched on whole lines, so a message split across two reads is still seen.
    let outLine = ''; let errLine = '';
    const kill = (why) => {
      if (finished === 'done') finished = why;
      try { if (group) process.kill(-p.pid, 'SIGKILL'); else p.kill('SIGKILL'); } catch { p.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const check = () => {
      const parsed = adapter.parse(out);
      // The contract's step limit binds every harness the same way, and it bounds spend for a CLI
      // that reports usage only when a turn ends (Codex), where the cost check below sees nothing
      // until the turn is over.
      if (parsed.toolCalls > contract.harness.limits.maxSteps) return kill('max_steps');
      const c = costOf(parsed);
      if (budgetUsd !== null && c !== null && c > budgetUsd) kill('cap');
    };
    p.stdout.on('data', (d) => {
      out += d;
      if (mock) return;
      const parts = (outLine + d).split(/\r?\n/);
      outLine = parts.pop();
      if (parts.length && outOfCreditInStream(parts.join('\n'))) return kill('blocked');
      if (parts.length) check();
    });
    p.stderr.on('data', (d) => {
      if (err.length < 200000) err += d;
      if (mock) return;
      const parts = (errLine + d).split(/\r?\n/);
      errLine = parts.pop();
      if (parts.some((l) => OUT_OF_CREDIT.test(l))) kill('blocked');
    });
    p.on('error', (e) => { err += String(e.message); finished = 'error'; });
    p.on('close', (code) => {
      clearTimeout(timer);
      // Whatever is left at the end, trailing fragments included, is checked before the queue moves on.
      if (!mock && (outOfCreditInStream(out) || OUT_OF_CREDIT.test(err))) finished = 'blocked';
      resolve({ code, out, err, finished: finished === 'done' && code !== 0 ? 'error' : finished });
    });
    if (spec.stdin) p.stdin.write(spec.stdin);
    p.stdin.end();
  });
}

const rawFile = path.join(outDir, 'trials.jsonl');
const credNames = (contestant.credentials ?? []).map((c) => c.env);
const persist = (text) => redactCredentials(text, process.env, credNames);
// Grading runs as root over a tree the agent owns; git refuses that without an explicit safe.directory.
const graderEnv = agentUser ? { ...runtime.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } : runtime.env;
const rows = [];
// Once any charge is unknown the running total is unknown too, and stays so.
let spent = 0;
let stop = null;
for (const task of tasks) {
  for (let trial = 1; trial <= trials; trial++) {
    const trialId = `${arenaId}.${contestant.id}.${task.id}.${trial}`;
    if (stop) { console.log(`${trialId} not started: ${stop.id}`); continue; }
    let budget = caps.perRunUsd;
    if (!mock && share !== null && spent !== null) budget = Math.min(budget, share - spent);
    if (!mock && budget <= 0) { console.log(`${trialId} skipped: arena share spent`); continue; }
    const sb = path.join(root, `${task.id}-${trial}`);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let row; let run = null; let parsed = null; let costUsd = null;
    try {
      const b = spawnSync('bash', [shellPath(path.join(E, 'fixtures', 'scenarios', `${task.id}.sh`)), shellPath(sb), contestant.fixtureVendor], { encoding: 'utf8', timeout: 120000, env: runtime.env });
      if (b.status !== 0) throw new Error(`fixture ${task.id}: ${(b.stderr || String(b.error)).slice(-400)}`);
      prepareHarnessHome(sb);
      // The agent owns its sandbox and the simulator state it writes through gh; the pack, the
      // grader and /out stay root's.
      if (agentUser) for (const p of [sb, `${sb}.sim`]) spawnSync('chown', ['-R', `${agentUser.uid}:${agentUser.gid}`, p]);
      run = await runAgent(task, sb, budget);
      const wallMs = Date.now() - t0;
      parsed = adapter.parse(run.out);
      costUsd = costOf(parsed);
      // Spend is settled before grading, so a grader failure can never drop a charge.
      spent = spent === null || (costUsd === null && !mock) ? null : spent + (costUsd ?? 0);
      // Transcripts keep the raw stream. Fixture secrets are fake, but redacting them keeps
      // published transcripts clear of secret scanners, as the playbook's own runner does; live
      // credentials are redacted by name from everything persisted.
      const secrets = JSON.parse(readFileSync(`${sb}.sim/baseline.json`, 'utf8')).secrets || [];
      let text = persist(run.out + (run.err ? `\n${JSON.stringify({ arenaStderrTail: run.err.slice(-4000) })}\n` : ''));
      for (const s of secrets) text = text.split(s).join('<FIXTURE-SECRET>');
      mkdirSync(path.join(outDir, 'transcripts', task.id), { recursive: true });
      const transcript = `transcripts/${task.id}/${trialId}.jsonl`;
      writeFileSync(path.join(outDir, transcript), text);
      const g = spawnSync(process.execPath, [path.join(E, 'graders', 'grade.mjs'), task.id, sb], { encoding: 'utf8', env: graderEnv, timeout: 120000 });
      if (g.status !== 0) throw new Error(`grade ${task.id}: ${(g.stderr || String(g.error)).slice(-400)}`);
      const grade = JSON.parse(g.stdout);
      const scores = { collision: grade.collision, bad_merge: grade.bad_merge, recovery: grade.recovery, task_success: grade.task_success };
      const llmGraded = !!grade.llm;
      row = {
        schema: 'arena-trial.v0', arenaId, trialId, contestant: contestant.id, harness: contestant.harness, harnessVersion: parsed.harnessVersion ?? contestant.pins?.[Object.keys(contestant.pins)[0]] ?? null,
        model: mock ? 'mock' : (parsed.model ?? contestant.model), vendor: contestant.vendor, fixtureVendor: contestant.fixtureVendor, pack: config.contract.pack, contractSha256: contractSha,
        task: task.id, kind: task.kind, primaryMetric: task.primaryMetric, trial, mock,
        startedAt, endedAt: new Date().toISOString(), wallMs, finished: run.finished, exitCode: run.code,
        tokens: parsed.tokens, costUsd, costSource: contestant.costSource, toolCalls: parsed.toolCalls, tools: parsed.tools,
        scores, taskDeterministic: grade.taskDeterministic, tampered: grade.tampered,
        llm: llmGraded ? { verdict: null, note: grade.llm.note, evidence: grade.llm.evidence } : null,
        // One rule everywhere: a run that did not finish normally is not a pass, whatever the sandbox shows.
        pass: run.finished === 'done' ? passOf(scores, { llmGraded, llmVerdict: null }) : false,
        events: lightEvents({ commands: parsed.commands, finalText: parsed.finalText, primaryMetric: task.primaryMetric, scores }),
        grader: { deterministic: 'playbook evals/graders/grade.mjs', llm: llmGraded ? 'pending: finished by the orchestrator with a grader from another vendor' : null },
        systemPromptDelivery: adapter.systemPromptDelivery, transcript, details: grade.details,
      };
    } catch (e) {
      // The model call may already have happened: its tokens and cost are kept, never dropped.
      row = { schema: 'arena-trial.v0', arenaId, trialId, contestant: contestant.id, harness: contestant.harness, model: mock ? 'mock' : (parsed?.model ?? contestant.model), vendor: contestant.vendor, pack: config.contract.pack, contractSha256: contractSha, task: task.id, kind: task.kind, primaryMetric: task.primaryMetric, trial, mock, startedAt, endedAt: new Date().toISOString(), wallMs: Date.now() - t0, finished: run?.finished === 'blocked' ? 'blocked' : 'error', error: persist(String(e.message)).slice(0, 1000), tokens: parsed?.tokens ?? null, costUsd, costSource: contestant.costSource, toolCalls: parsed?.toolCalls ?? 0, tools: parsed?.tools ?? [], scores: { collision: 1, bad_merge: 1, recovery: 0, task_success: 0 }, pass: false, events: null, llm: null, grader: null };
    }
    // Paid work stops for this contestant once spend is no longer known, or the provider is out of
    // credit. Neither is retried.
    if (!mock && run) {
      if (run.finished === 'blocked') stop = { id: 'provider-out-of-credit', detail: 'the provider reported no credit (402 or equivalent) during a run; not retried' };
      else if (costUsd === null) stop = { id: 'cost-unknown', detail: `${trialId} spent an unknown amount, so the cap can no longer be enforced` };
    }
    if (!flag('keep')) for (const p of [sb, `${sb}.sim`]) rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    appendFileSync(rawFile, JSON.stringify(row) + '\n');
    rows.push(row);
    console.log(`${row.trialId} ${row.finished} pass=${row.pass} c=${row.scores.collision} b=${row.scores.bad_merge} r=${row.scores.recovery} s=${row.scores.task_success} tools=${row.toolCalls} cost=${row.costUsd}`);
  }
}
if (!flag('keep') && existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
finish(EXIT.ok, { status: stop ? 'blocked' : 'ran', ...(stop ? { blockers: [stop] } : {}), spentUsd: mock ? 0 : spent, aggregate: aggregate(rows) });
