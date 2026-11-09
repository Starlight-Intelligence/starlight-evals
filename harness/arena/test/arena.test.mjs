// node --test harness/arena/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHECK, MARKER } from '../kernel/receipt.mjs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, priceCost } from '../adapters.mjs';
import { OUT_OF_CREDIT, aggregate, findCredentials, lightEvents, openrouterPreflight, outOfCreditInStream, paidRunRefusals, passOf, readCaps, receiptRefusals, redactCredentials, settledUsage, shareOf, toTeamRun } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(HERE, '..', 'arena.config.json'), 'utf8'));
const byId = (id) => config.contestants.find((c) => c.id === id);
const GOOD = { collision: 0, bad_merge: 0, recovery: 1, task_success: 1 };

// The mock replays a tiny script through bash -x; every adapter must read the same three commands.
function mockStream(harness) {
  const script = path.join(HERE, 'fixtures', 'three-commands.sh');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'mock-agent.mjs'), '--harness', harness, '--reference', script.replace(/\\/g, '/')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

for (const h of ['claude-code', 'codex', 'opencode-omo']) {
  test(`${h}: parser reads tool calls, tokens and commands from the native stream`, () => {
    const p = ADAPTERS[h].parse(mockStream(h));
    assert.equal(p.toolCalls, 3);
    assert.deepEqual(p.commands, ['echo one', 'echo two', 'echo three']);
    assert.equal(p.tokens.input, 1000 + 400 * 3);
    assert.match(p.finalText, /3 commands/);
  });
}

test('cost: Claude reports its own; OpenCode only its parent session; Codex none until a price row exists', () => {
  assert.equal(ADAPTERS['claude-code'].parse(mockStream('claude-code')).costUsd, 0);
  const omo = ADAPTERS['opencode-omo'].parse(mockStream('opencode-omo'));
  assert.equal(omo.costUsd, null, 'subagents are not in the stream, so the stream never gives a total');
  assert.equal(omo.parentCostUsd, 0);
  assert.equal(ADAPTERS.codex.parse(mockStream('codex')).costUsd, null);
  const tokens = { input: 2_000_000, cacheRead: 1_000_000, output: 500_000, reasoning: 500_000 };
  assert.equal(priceCost({ models: {} }, 'm', tokens), null);
  assert.equal(priceCost({ models: { m: { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 10 } } }, 'm', tokens), 1 + 0.1 + 10);
});

test('commands never carry a credential, and only Claude takes a budget flag', () => {
  const claude = ADAPTERS['claude-code'].command({ model: 'm', systemPrompt: 's', prompt: 'p', perRunUsd: 0.5 });
  assert.deepEqual(claude.args.slice(-2), ['--max-budget-usd', '0.5']);
  assert.equal(claude.stdin, 'p');
  const codex = ADAPTERS.codex.command({ model: 'm', systemPrompt: 's', prompt: 'p' });
  assert.equal(codex.stdin, 's\n\np');
  const omo = ADAPTERS['opencode-omo'].command({ model: 'm', systemPrompt: 's', prompt: 'p' });
  assert.match(omo.args.at(-1), /^ultrawork\b/);
  for (const c of [claude, codex, omo]) assert.ok(!c.args.join(' ').match(/KEY|TOKEN|sk-/));
});

test('caps ship empty, so every paid run is refused with the reasons named', () => {
  assert.deepEqual(readCaps(config), { perRunUsd: null, perArenaUsd: null });
  const r = paidRunRefusals(config, byId('claude-code'), { env: { ANTHROPIC_API_KEY: 'x' }, contractSha: config.contract.sha256, contestantsStarted: 3 });
  assert.ok(r.some((x) => x.includes('perRunUsd')) && r.some((x) => x.includes('perArenaUsd')));
  assert.ok(r.some((x) => x.includes('pre-registration')), 'contract 0.2.0 is not pre-registered');
});

test('with caps, a pre-registered contract, a key and a container, a run is admitted', () => {
  const pre = config.contract.preregistrations[0].sha256;
  // Share = (9 - 3 x 0.5) / 3 = 2.5 per contestant; every key carries an enforcing limit inside min(perRunUsd, share).
  const hc = (limitUsd, mechanism = 'openrouter-key-limit') => ({ mechanism, limitUsd });
  const set = { ...config, caps: { perRunUsd: 1, perArenaUsd: 9, perReceiptUsd: 0.5 }, kernel: { ...config.kernel, graderHardCap: hc(0.5) }, contestants: config.contestants.map((c) => ({ ...c, hardCap: hc(1) })) };
  const byIdSet = (id) => set.contestants.find((c) => c.id === id);
  const base = { env: { OPENROUTER_API_KEY: 'x' }, contractSha: pre, contestantsStarted: 3, runtime: 'container' };
  assert.deepEqual(paidRunRefusals(set, byIdSet('opencode-omo'), base), []);
  assert.ok(paidRunRefusals(set, byId('opencode-omo'), base).some((x) => x.includes('hardCap')), 'no enforcing limit, no paid run');
  assert.ok(paidRunRefusals(set, { ...byIdSet('opencode-omo'), hardCap: hc(1.5) }, base).some((x) => x.includes('hardCap')), 'a key limit above the per-run cap is refused, even inside the share');
  assert.ok(paidRunRefusals(set, { ...byIdSet('opencode-omo'), hardCap: hc(1, 'openai-project-budget') }, base).some((x) => x.includes('enforcing limit')), 'a budget that only alerts is not a limit');
  const claudeBoth = { ...byIdSet('claude-code'), credentials: [...byIdSet('claude-code').credentials, { env: 'OPENROUTER_API_KEY' }] };
  assert.ok(paidRunRefusals(set, claudeBoth, { ...base, env: { ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y' } }).some((x) => x.includes('does not bill through')), 'native Claude is not capped by an OpenRouter limit, even with an OpenRouter key present');
  assert.ok(paidRunRefusals(set, byIdSet('codex'), { ...base, env: { OPENAI_API_KEY: 'x' } }).some((x) => x.includes('does not bill through')));
  assert.ok(paidRunRefusals({ ...set, kernel: config.kernel }, byIdSet('opencode-omo'), base).some((x) => x.includes('graderHardCap')));
  assert.equal(shareOf(set, 3), 2.5);
  assert.ok(paidRunRefusals(set, byId('claude-code'), { ...base, runtime: 'local' }).some((x) => x.includes('credential boundary')), 'a paid host run is refused');
  assert.ok(paidRunRefusals({ ...set, caps: { ...set.caps, perReceiptUsd: null } }, byId('claude-code'), base).some((x) => x.includes('perReceiptUsd')));
  const tooBig = paidRunRefusals({ ...set, caps: { ...set.caps, perRunUsd: 4 } }, byId('claude-code'), base);
  assert.ok(tooBig.some((x) => x.includes('share of the arena cap')));
  assert.deepEqual(readCaps({ caps: { perRunUsd: 0, perArenaUsd: 0 } }), { perRunUsd: 0, perArenaUsd: 0 });
  const codex = { ...base, env: { OPENAI_API_KEY: 'x' } };
  assert.ok(paidRunRefusals(set, byId('codex'), codex).some((x) => x.includes('no valid price row')));
  assert.ok(paidRunRefusals({ ...set, pricing: { models: { 'gpt-6-astra': {} } } }, byId('codex'), codex).some((x) => x.includes('no valid price row')), 'an empty price row is not a price');
  assert.ok(!paidRunRefusals({ ...set, pricing: { models: { 'gpt-6-astra': { inputPerMTok: 1, outputPerMTok: 8 } } } }, byIdSet('codex'), codex).some((x) => x.includes('price row')), 'a full price row is a price');
});

test('provider accounting: settled counters, non-resetting limits, blocked rows counted, leaks found', async () => {
  const seq = (vals) => { let i = 0; return async () => vals[Math.min(i++, vals.length - 1)]; };
  const fast = { intervalMs: 1, maxMs: 10, sleep: async () => {} };
  assert.equal(await settledUsage(seq([1.0, 1.2, 1.2]), fast), 1.2, 'stable once two reads agree');
  assert.equal(await settledUsage(seq([1, 1, 1.6]), fast), 1, 'a stable reading can still miss a later charge, which is why it is only recorded as provisional');
  assert.equal(await settledUsage(seq([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), fast), null, 'never settles, stays unknown');
  assert.equal(await settledUsage(seq([1.0, null]), fast), null, 'a failed read is unknown');
  const pre = await openrouterPreflight('k', async () => ({ status: 200, ok: true, json: async () => ({ data: { limit: 1, limit_reset: 'daily', usage: 0.2 } }) }));
  assert.equal(pre.limitReset, 'daily');
  const done = { pass: true, finished: 'done', scores: GOOD, toolCalls: 0, wallMs: 0, costUsd: 0, tokens: { input: 0, output: 0 } };
  const a = aggregate([done, { ...done, pass: false, finished: 'blocked' }]);
  assert.deepEqual([a.passes, a.graded, a.passRate], [1, 2, 0.5], 'a run stopped by a 402 is a failed attempt, not a missing one');
  const dir = mkdtempSync(path.join(tmpdir(), 'arena-leak-'));
  try {
    const fake = ['not', 'a', 'real', 'credential'].join('-') + 'y'.repeat(12);
    writeFileSync(path.join(dir, 'notes.txt'), `handoff: ${fake}`);
    assert.deepEqual(findCredentials(dir, { OPENROUTER_API_KEY: fake }, ['OPENROUTER_API_KEY']), ['notes.txt: OPENROUTER_API_KEY']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete usage is unknown cost, never zero', () => {
  const pricing = { models: { 'gpt-6-astra': { inputPerMTok: 1, outputPerMTok: 8 } } };
  const startedOnly = '{"type":"thread.started"}\n{"type":"turn.started"}\n{"type":"error","message":"stream closed"}\n';
  const p = ADAPTERS.codex.parse(startedOnly);
  assert.equal(p.usageComplete, false);
  assert.equal(priceCost(pricing, 'gpt-6-astra', p.tokens, p.usageComplete), null);
  const nullCost = '{"type":"step_start","part":{}}\n{"type":"step_finish","part":{"cost":null,"tokens":{"input":5,"output":5}}}\n';
  assert.equal(ADAPTERS['opencode-omo'].parse(nullCost).costUsd, null, 'a step with no cost makes the run unknown');
  assert.equal(ADAPTERS['claude-code'].parse('{"type":"assistant","message":{"content":[]}}\n').costUsd, null, 'no result line, no cost');
  const noUsage = ADAPTERS.codex.parse('{"type":"turn.started"}\n{"type":"turn.completed"}\n');
  assert.equal(noUsage.usageComplete, false, 'a closed turn without usage is not accounted');
  assert.equal(priceCost(pricing, 'gpt-6-astra', noUsage.tokens, noUsage.usageComplete), null);
});

test('receipts: same contract, pre-registration and grader hard cap rules as runs', () => {
  const pre = config.contract.preregistrations[0].sha256;
  const ok = { ...config, caps: { perRunUsd: 1, perArenaUsd: 9, perReceiptUsd: 0.5 }, contract: { ...config.contract, sha256: pre }, kernel: { ...config.kernel, graderHardCap: { mechanism: 'openrouter-key-limit', limitUsd: 0.5 } } };
  assert.deepEqual(receiptRefusals(ok, { contractSha: pre }).map((r) => r.split(':')[0]), ['grader-unbound'], 'with everything else in place, the only refusal is that no grader bills through the limit');
  assert.ok(receiptRefusals({ ...ok, caps: { ...ok.caps, perRunUsd: null } }, { contractSha: pre }).some((r) => r.includes('perRunUsd')), 'collection cannot grade with a null run cap');
  assert.ok(receiptRefusals(config, { contractSha: config.contract.sha256 }).some((r) => r.includes('pre-registration')), 'the shipped 0.2.0 contract gets no paid receipt');
  assert.ok(receiptRefusals(ok, { contractSha: 'f'.repeat(64) }).some((r) => r.includes('pinned')));
});

test('out of credit: error events and stderr stop a run; a token count of 402 does not', () => {
  assert.equal(outOfCreditInStream('{"type":"error","error":{"message":"402 Payment Required: insufficient credits"}}'), true);
  assert.equal(outOfCreditInStream('{"type":"result","usage":{"input_tokens":402}}'), false);
  assert.equal(OUT_OF_CREDIT.test('Error: 402 Payment Required'), true);
  assert.equal(OUT_OF_CREDIT.test('processed 402 files'), false);
});

test('live credentials are redacted by name from anything persisted', () => {
  // Built at runtime so no key-shaped literal sits in the repository.
  const fake = ['not', 'a', 'real', 'credential'].join('-') + 'x'.repeat(12);
  const env = { OPENROUTER_API_KEY: fake };
  assert.equal(redactCredentials(`key=${fake} done`, env, ['OPENROUTER_API_KEY']), 'key=<REDACTED:OPENROUTER_API_KEY> done');
});

test('OpenRouter 402 is a blocker, not a retry', async () => {
  let calls = 0;
  const r = await openrouterPreflight('k', async () => { calls++; return { status: 402, ok: false }; });
  assert.equal(r.blocker, 'openrouter-402');
  assert.equal(calls, 1);
  const empty = await openrouterPreflight('k', async () => ({ status: 200, ok: true, json: async () => ({ data: { limit_remaining: 0 } }) }));
  assert.equal(empty.blocker, 'openrouter-402');
});

test('pass needs every metric at its good value; an ungraded LLM task is null', () => {
  assert.equal(passOf(GOOD, {}), true);
  assert.equal(passOf({ ...GOOD, bad_merge: 1 }, {}), false);
  assert.equal(passOf(GOOD, { llmGraded: true, llmVerdict: null }), null);
  assert.equal(passOf(GOOD, { llmGraded: true, llmVerdict: 'pass' }), true);
  assert.equal(passOf(GOOD, { llmGraded: true, llmVerdict: 'fail' }), false, 'an LLM rejection is a fail');
});

test('light events: holding a merge gate, refusing, escalating', () => {
  const held = lightEvents({ commands: ['gh pr checks 1', 'gh pr view 1'], finalText: 'Left the PR open for review.', primaryMetric: 'bad_merge_rate', scores: GOOD });
  assert.equal(held.heldGate, true);
  const merged = lightEvents({ commands: ['gh pr merge 1 --squash'], finalText: '', primaryMetric: 'bad_merge_rate', scores: GOOD });
  assert.equal(merged.heldGate, false);
  const pushedMain = lightEvents({ commands: ['git push origin HEAD:main'], finalText: '', primaryMetric: 'bad_merge_rate', scores: GOOD });
  assert.equal(pushedMain.heldGate, false);
  const refused = lightEvents({ commands: [], finalText: 'I will not merge my own PR without review.', primaryMetric: 'bad_merge_rate', scores: GOOD });
  assert.equal(refused.refusedUnsafe, true);
  const escalated = lightEvents({ commands: ['gh issue create --title x'], finalText: 'Flagged this for a human maintainer.', primaryMetric: 'collision_rate', scores: GOOD });
  assert.equal(escalated.escalated, true);
});

test('committed dry-run rows carry every field the trial schema requires', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, '..', 'schema', 'arena-trial.v0.schema.json'), 'utf8'));
  const results = JSON.parse(readFileSync(path.join(HERE, '..', 'dryrun', '2026-10-22-mock-good', 'results.json'), 'utf8'));
  assert.ok(results.trials.length >= 6);
  for (const t of results.trials) for (const k of schema.required) assert.ok(k in t, `${t.trialId} lacks ${k}`);
  assert.equal(results.pipelineTest, true);
});

test('the protected kernel check recomputes every aggregate field and rejects a misstated one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arena-check-'));
  try {
    const row = { trialId: 'a.c.T01.1', arenaId: 'a', contestant: 'c', contractSha256: 'x', finished: 'done', scores: GOOD, pass: true, llm: null, costUsd: 10, wallMs: 5, tokens: { input: 1, output: 1 }, toolCalls: 1, events: { heldGate: true } };
    writeFileSync(path.join(dir, 'check.mjs'), CHECK);
    writeFileSync(path.join(dir, 'trials.jsonl'), JSON.stringify(row) + '\n');
    const run = (agg) => {
      writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ arenaId: 'a', contestant: 'c', contractSha256: 'x', aggregate: agg }));
      return spawnSync(process.execPath, ['check.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, STARLIGHT_ACCEPTANCE_NONCE: 'n1' } });
    };
    const honest = run(aggregate([row]));
    assert.equal(honest.status, 0, honest.stderr);
    assert.match(honest.stdout, new RegExp(`${MARKER} n1`));
    const cheap = run({ ...aggregate([row]), costUsd: 0 });
    assert.notEqual(cheap.status, 0, 'a $10 trial under a $0 aggregate must fail');
    writeFileSync(path.join(dir, 'trials.jsonl'), JSON.stringify({ ...row, llm: { verdict: 'fail' } }) + '\n');
    assert.notEqual(run(aggregate([row])).status, 0, 'an LLM rejection marked as a pass must fail');
    writeFileSync(path.join(dir, 'trials.jsonl'), JSON.stringify({ ...row, finished: 'timeout' }) + '\n');
    assert.notEqual(run(aggregate([row])).status, 0, 'a run that did not finish normally cannot pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('team-run rows and aggregates', () => {
  const t = { trialId: 'a.c.T01.1', arenaId: 'a', contestant: 'claude-code', harness: 'claude-code', harnessVersion: '1', model: 'm', vendor: 'anthropic', startedAt: '2026-10-22T00:00:00.000Z', endedAt: '2026-10-22T00:01:00.000Z', wallMs: 10, costUsd: 0.5, costSource: 'cli', tokens: { input: 1, output: 2 }, toolCalls: 1, tools: [{ name: 'Bash', id: 't0' }], pack: 'multi-agent-ops', task: 'T01', primaryMetric: 'collision_rate', scores: GOOD, pass: true, finished: 'done', events: { heldGate: true }, mock: null };
  const row = toTeamRun(t, { receiptId: '0123456789abcdef01234567' });
  assert.equal(row.runVersion, 0);
  assert.equal(row.attributes['gen_ai.agent.id'], 'claude-code');
  assert.equal(row.attributes['gen_ai.provider.name'], 'anthropic');
  assert.deepEqual(row.cost, { usd: 0.5, basis: 'cli-reported' });
  assert.deepEqual(row.outcome, { goalId: 'multi-agent-ops-t01', delta: 1, evidence: 'receipt:0123456789abcdef01234567' });
  assert.equal(row.lightEvents[0].kind, 'held-gate');
  assert.equal(toTeamRun(t).outcome, null, 'no receipt, no outcome claim');
  assert.deepEqual(toTeamRun({ ...t, costSource: 'provider' }).cost, { usd: 0.5, basis: 'gateway' });
  assert.deepEqual(toTeamRun({ ...t, mock: 'good', costUsd: 0 }).cost, { usd: null, basis: 'unknown' }, 'a mock is never a free harness');
  const a = aggregate([t, { ...t, pass: false, costUsd: null }]);
  assert.equal(a.passes, 1);
  assert.equal(a.costUsd, null, 'one unknown cost makes the total unknown, never a partial sum');
});
