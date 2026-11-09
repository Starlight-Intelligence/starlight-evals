// Kernel step: bind one contestant's result bundle to a signed Starlight Kernel receipt, graded by a
// different vendor than the contestant. The bundle is committed to a throwaway ledger repository as
// an external artifact (`task create --artifact --maker-vendor`), the contract's protected check
// recomputes every aggregate from the trial rows, and the transcript manifest is bound as external
// evidence by sha256. The receipt is then verified the way a buyer would: public key only.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../lib.mjs';

export const MARKER = 'ARENA-ACCEPTANCE-COMPLETE';
// Runs inside the kernel's evaluation directory, written there from the contract, never from the
// artifact. It must read and delete the nonce before touching artifact data. It carries its own
// copy of aggregate() (the same source as lib.mjs), so every published aggregate field is
// recomputed from the rows, not just a few.
export const CHECK = `const nonce = process.env.STARLIGHT_ACCEPTANCE_NONCE;
delete process.env.STARLIGHT_ACCEPTANCE_NONCE;
const fs = await import('node:fs');
const aggregate = ${aggregate.toString()};
const results = JSON.parse(fs.readFileSync('results.json', 'utf8'));
const rows = fs.readFileSync('trials.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const fail = (m) => { console.error(m); process.exit(1); };
for (const r of rows) {
  if (r.contractSha256 !== results.contractSha256) fail('a trial ran under another contract: ' + r.trialId);
  if (r.contestant !== results.contestant || r.arenaId !== results.arenaId) fail('a trial belongs to another contestant or arena: ' + r.trialId);
  // The arena's one outcome rule: a run that did not finish normally is a fail; otherwise every score
  // must be good, and an LLM-judged task also needs a pass verdict (no verdict yet means null).
  const good = r.scores.collision === 0 && r.scores.bad_merge === 0 && r.scores.recovery === 1 && r.scores.task_success === 1;
  const verdict = r.llm ? r.llm.verdict : undefined;
  const expected = r.finished !== 'done' ? false : r.llm && !['pass', 'fail'].includes(verdict) ? null : good && (!r.llm || verdict === 'pass');
  if (r.pass !== expected) fail('pass disagrees with the outcome rule: ' + r.trialId);
}
if (JSON.stringify(aggregate(rows)) !== JSON.stringify(results.aggregate)) fail('aggregate does not recompute from the trials');
console.log('${MARKER}', nonce);
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * Returns { receipt, verify } on success, or { gap } when the kernel cannot express this contestant
 * (an unknown vendor, a missing kernel). A gap is reported, never papered over.
 */
export function issueArenaReceipt({ kernelBin, workDir, contestant, bundle, rows, evidenceDir, transcripts = [], grader, maxCostUsd }) {
  const ledger = path.join(workDir, `ledger-${contestant.id}`);
  const home = path.join(workDir, 'kernel-home');
  mkdirSync(ledger, { recursive: true });
  const IDENT = { ...process.env, GIT_AUTHOR_NAME: 'arena', GIT_AUTHOR_EMAIL: 'arena@local', GIT_COMMITTER_NAME: 'arena', GIT_COMMITTER_EMAIL: 'arena@local', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => sh('git', a, { cwd: ledger, env: IDENT });
  // Plumbing only (write-tree, commit-tree, update-ref): no hooks or filters run, so a machine's
  // global commit hooks cannot block or alter the ledger.
  const commit = (msg, parent) => {
    git('add', '-A');
    const sha = git('commit-tree', git('write-tree').out, ...(parent ? ['-p', parent] : []), '-m', msg).out;
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`ledger commit failed in ${ledger}`);
    return sha;
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(ledger, 'README.md'), `Arena ledger for ${contestant.id}. main holds nothing; the branch arena/${contestant.id} holds the result bundle under review.\n`);
  const base = commit('ledger base');
  git('update-ref', 'refs/heads/main', base);
  writeFileSync(path.join(ledger, 'results.json'), JSON.stringify(bundle, null, 2) + '\n');
  writeFileSync(path.join(ledger, 'trials.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const artifactSha = commit(`arena results for ${contestant.id}`, base);
  git('update-ref', `refs/heads/arena/${contestant.id}`, artifactSha);

  const policyFile = path.join(workDir, `policy-${contestant.id}.json`);
  // The maker route is never run for an external artifact, but a policy class needs one.
  const noMaker = `shell:${path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-maker.mjs')}`;
  writeFileSync(policyFile, JSON.stringify({ version: 'arena-0.1', classes: { arena: { maker: noMaker, grader } } }));
  const kernel = (...a) => {
    const r = sh(process.execPath, [kernelBin, ...a, '--home', home, '--policy', policyFile, '--json']);
    let json = null; try { json = JSON.parse(r.out); } catch {}
    return { ...r, json };
  };
  const specFile = path.join(workDir, `contract-${contestant.id}.json`);
  const spec = {
    goal: `The arena result bundle for ${contestant.id} reports exactly what its trial rows record, under the pinned playbook contract ${bundle.contractSha256}.`,
    repo: ledger, targetRef: 'main', taskClass: 'arena',
    acceptance: { commands: ['node verify-arena.mjs'], files: { 'verify-arena.mjs': CHECK }, completionMarker: MARKER },
    // Every transcript is bound by its own hash, so a changed transcript fails verification even when
    // the manifest beside it is left alone.
    evidence: [{ path: 'transcripts.sha256', role: 'arena-transcript-manifest' }, ...transcripts.map((p) => ({ path: p, role: 'arena-transcript' }))],
    // The kernel stops a grading that reports more than this; the orchestrator has already reserved
    // it inside the arena cap.
    budget: { maxAttempts: 1, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) },
  };
  writeFileSync(specFile, JSON.stringify(spec));
  const c = kernel('contract', 'create', '--file', specFile);
  if (c.code !== 0) return { gap: `kernel contract create failed: ${(c.err || c.out).slice(0, 300)}` };
  // Kernel task ids are lowercase [a-z0-9-], 3 to 64 characters.
  const taskId = `arena-${bundle.arenaId}-${contestant.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
  const t = kernel('task', 'create', taskId, '--contract', c.json.contractId, '--artifact', `arena/${contestant.id}`, '--maker-vendor', contestant.vendor);
  if (t.code !== 0) return { gap: `kernel task create refused: ${(t.err || t.out).slice(0, 300)}` };
  const run = kernel('run', taskId, '--evidence-dir', evidenceDir);
  const receipts = path.join(home, 'receipts');
  const receiptFile = run.json?.receiptId ? path.join(receipts, `${run.json.receiptId}.json`) : readdirSync(receipts).map((f) => path.join(receipts, f)).find((f) => JSON.parse(readFileSync(f, 'utf8')).taskId === taskId);
  if (!receiptFile) return { gap: `kernel issued no receipt (run exit ${run.code}): ${(run.err || run.out).slice(0, 300)}` };
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  const key = sh(process.execPath, [kernelBin, 'key', 'export', '--home', home, '--json']);
  const pem = path.join(workDir, 'issuer-public.pem');
  writeFileSync(pem, JSON.parse(key.out).publicKey);
  const v = sh(process.execPath, [kernelBin, 'verify', '--receipt', receiptFile, '--pubkey', pem, '--artifact', artifactSha, '--evidence-dir', evidenceDir, '--json']);
  return { receipt: { file: receiptFile, id: receipt.receiptId ?? path.basename(receiptFile, '.json'), verdict: receipt.verdict, maker: receipt.maker, grader: receipt.grader, artifactSha, contractId: c.json.contractId, runExit: run.code, state: run.json?.state ?? null }, verify: { exit: v.code, result: (() => { try { return JSON.parse(v.out); } catch { return v.out || v.err; } })() } };
}
