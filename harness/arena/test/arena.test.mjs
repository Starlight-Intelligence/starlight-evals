// node --test harness/arena/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, priceCost } from '../adapters.mjs';
import { aggregate, lightEvents, openrouterPreflight, paidRunRefusals, passOf, readCaps, toTeamRun } from '../lib.mjs';

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

test('cost: Claude and OpenCode report their own; Codex has none until a price row exists', () => {
  assert.equal(ADAPTERS['claude-code'].parse(mockStream('claude-code')).costUsd, 0);
  assert.equal(ADAPTERS['opencode-omo'].parse(mockStream('opencode-omo')).costUsd, 0);
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

test('with caps, a pre-registered contract and a key, a run is admitted; a cap of 0 still admits none', () => {
  const pre = config.contract.preregistrations[0].sha256;
  const set = { ...config, caps: { perRunUsd: 1, perArenaUsd: 9 } };
  assert.deepEqual(paidRunRefusals(set, byId('claude-code'), { env: { ANTHROPIC_API_KEY: 'x' }, contractSha: pre, contestantsStarted: 3 }), []);
  const tooBig = paidRunRefusals({ ...config, caps: { perRunUsd: 4, perArenaUsd: 9 } }, byId('claude-code'), { env: { ANTHROPIC_API_KEY: 'x' }, contractSha: pre, contestantsStarted: 3 });
  assert.ok(tooBig.some((x) => x.includes('share of the arena cap')));
  assert.deepEqual(readCaps({ caps: { perRunUsd: 0, perArenaUsd: 0 } }), { perRunUsd: 0, perArenaUsd: 0 });
  assert.ok(paidRunRefusals(set, byId('codex'), { env: { OPENAI_API_KEY: 'x' }, contractSha: pre, contestantsStarted: 3 }).some((x) => x.includes('no price row')));
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

test('team-run rows and aggregates', () => {
  const t = { trialId: 'a.c.T01.1', arenaId: 'a', contestant: 'c', harness: 'h', harnessVersion: '1', model: 'm', startedAt: 's', endedAt: 'e', wallMs: 10, costUsd: 0.5, costSource: 'cli', tokens: { input: 1, output: 2 }, toolCalls: 3, pack: 'p', task: 'T01', primaryMetric: 'collision_rate', scores: GOOD, pass: true, finished: 'done', events: { heldGate: false }, transcript: 'x', contractSha256: 'y', grader: {}, mock: null };
  const row = toTeamRun(t);
  assert.equal(row.schema, 'team-run.v0');
  assert.equal(row.outcome.status, 'pass');
  assert.equal(row.outcome.goalId, 'p:T01');
  assert.equal(row.pipelineTest, false);
  const a = aggregate([t, { ...t, pass: false, costUsd: null }]);
  assert.equal(a.passes, 1);
  assert.equal(a.costUsd, null, 'one unknown cost makes the total unknown, never a partial sum');
});
