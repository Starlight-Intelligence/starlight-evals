// Shared rules for the harness arena: spend caps, paid-run admission, light events, pass/fail and
// the mapping to Team Card's team-run rows. The contestant runner and the orchestrator both use
// these, so the two cannot disagree about what a run may spend or what counts as a pass.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const EXIT = { ok: 0, error: 1, usage: 2, contract: 3, refused: 4 };
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Caps as numbers, or null when unset. A cap of 0 is a real cap: it admits no paid run. */
export function readCaps(config) {
  const c = config.caps ?? {};
  return { perRunUsd: isNum(c.perRunUsd) ? c.perRunUsd : null, perArenaUsd: isNum(c.perArenaUsd) ? c.perArenaUsd : null };
}

/**
 * Every reason a paid (non-mock) run of this contestant may not start. Empty means admitted.
 * Fail closed: an unset cap, an unregistered contract, an unknown cost source or a missing
 * credential each refuses the run on its own.
 */
/**
 * The arena cap is split before anything runs: one receipt reservation per contestant, and the rest
 * shared evenly. null when the arena cap or the receipt reservation is unset.
 */
export function shareOf(config, contestantsStarted) {
  const caps = readCaps(config);
  const per = config.caps?.perReceiptUsd;
  if (caps.perArenaUsd === null || !isNum(per)) return null;
  const n = Math.max(1, contestantsStarted);
  return (caps.perArenaUsd - per * n) / n;
}

/**
 * The arena's own checks stop a run only after a charge is reported, so they cannot bound spend on
 * their own. A paid run needs a limit the provider enforces before each request: a key or workspace
 * whose hard spend limit is at or under this contestant's share (or, for the grader, the receipt
 * reservation). OpenRouter's limit is checked live; other providers' limits are declared by Frank.
 */
/** The most a contestant's key may be allowed to spend: the per-run cap and the share, whichever is lower. */
export function keyCeiling(config, contestantsStarted) {
  const share = shareOf(config, contestantsStarted);
  const run = readCaps(config).perRunUsd;
  return share === null || run === null ? null : Math.min(run, share);
}

// Only mechanisms that refuse a request once the limit is reached, never reset during an arena, and
// can be read back before a run. A project "budget" that only alerts (OpenAI's) is not one. Today
// that is an OpenRouter key with a non-resetting limit; a reserving gateway would be the other.
export const ENFORCING_MECHANISMS = ['openrouter-key-limit'];
// Which harness adapters bill only through the credential a mechanism caps. Claude Code and Codex
// call their own vendors, so an OpenRouter limit next to them caps nothing they spend.
export const BILLING = { 'opencode-omo': 'openrouter-key-limit' };
// Kernel grader routes known to bill through an enforcing limit: none yet.
export const BOUND_GRADER_ROUTES = [];
const hardCapOk = (hc, ceiling) => !!hc && ENFORCING_MECHANISMS.includes(hc.mechanism) && isNum(hc.limitUsd) && ceiling !== null && hc.limitUsd <= ceiling;

/** Every reason a paid Kernel grading may not start. Empty means admitted. */
export function receiptRefusals(config, { contractSha }) {
  const out = [];
  const per = config.caps?.perReceiptUsd;
  const caps = readCaps(config);
  if (caps.perRunUsd === null) out.push('caps.perRunUsd is not set (Frank sets it in arena.config.json)');
  if (caps.perArenaUsd === null) out.push('caps.perArenaUsd is not set (Frank sets it in arena.config.json)');
  if (!isNum(per)) out.push('caps.perReceiptUsd is not set: the Kernel grader is a paid model call too');
  if (contractSha !== config.contract.sha256) out.push(`collected contract ${String(contractSha).slice(0, 12)} is not the pinned ${config.contract.sha256.slice(0, 12)}`);
  if (!(config.contract.preregistrations ?? []).some((p) => p.sha256 === contractSha)) out.push(`contract ${String(contractSha).slice(0, 12)} has no public pre-registration`);
  if (!hardCapOk(config.kernel?.graderHardCap, isNum(per) ? per : null)) out.push(`kernel.graderHardCap must be an enforcing limit (${ENFORCING_MECHANISMS.join(', ')}) at or under caps.perReceiptUsd`);
  // A declared limit binds nothing unless the grader actually bills through it. The Kernel's graders
  // (codex, claude) call their vendors with their own keys, and no adapter routes them through a
  // capped key yet, so every paid receipt is refused until one is built and verified.
  const unbound = [...new Set(Object.values(config.kernel?.graders ?? {}).filter((g) => !BOUND_GRADER_ROUTES.includes(g)))];
  if (unbound.length) out.push(`grader-unbound: no Kernel grader bills through an enforcing limit yet (${unbound.join(', ')} use their own vendor keys)`);
  return out;
}

const validRates = (p) => !!p && ['inputPerMTok', 'outputPerMTok'].every((k) => isNum(p[k])) && (p.cachedInputPerMTok === undefined || isNum(p.cachedInputPerMTok));

export function paidRunRefusals(config, contestant, { env, contractSha, contestantsStarted, runtime }) {
  const out = [];
  // On the host, the agent shares a user with this runner and could read its environment through
  // /proc; only a container (or Railway) gives the credential boundary the arena relies on.
  if (runtime === 'local') out.push('paid runs need --runtime docker or Railway: a host process has no credential boundary');
  const caps = readCaps(config);
  if (caps.perRunUsd === null) out.push('caps.perRunUsd is not set (Frank sets it in arena.config.json)');
  if (caps.perArenaUsd === null) out.push('caps.perArenaUsd is not set (Frank sets it in arena.config.json)');
  const share = shareOf(config, contestantsStarted);
  if (share !== null && share <= 0) out.push(`receipt reservations leave no arena budget for contestants (share ${share})`);
  if (caps.perRunUsd !== null && share !== null && caps.perRunUsd > share) {
    out.push(`caps.perRunUsd ${caps.perRunUsd} exceeds this contestant's share of the arena cap (${share})`);
  }
  // The provider's limit is the real per-run bound, so it must fit the per-run cap as well as the share.
  const ceiling = keyCeiling(config, contestantsStarted);
  if (!hardCapOk(contestant.hardCap, ceiling)) out.push(`${contestant.id}.hardCap must be an enforcing limit (${ENFORCING_MECHANISMS.join(', ')}) at or under min(caps.perRunUsd, share) = ${ceiling ?? 'unset'}`);
  if (contestant.hardCap && BILLING[contestant.harness] !== contestant.hardCap.mechanism) out.push(`${contestant.id} (${contestant.harness}) does not bill through ${contestant.hardCap.mechanism}; its spend would not be capped by it`);
  if (!(config.contract.preregistrations ?? []).some((p) => p.sha256 === contractSha)) out.push(`contract ${contractSha.slice(0, 12)} has no public pre-registration`);
  if (contestant.costSource === 'pricing' && !validRates(config.pricing?.models?.[contestant.model])) out.push(`no valid price row for ${contestant.model} (finite inputPerMTok and outputPerMTok), so its cost cannot be capped`);
  // A paid contestant run implies a paid receipt later, so the grader's limits are checked up front.
  out.push(...receiptRefusals(config, { contractSha: config.contract.sha256 }).filter((r) => r.includes('perReceiptUsd') || r.includes('graderHardCap')));
  for (const c of contestant.credentials ?? []) if (!env[c.env]) out.push(`${c.env} is not set`);
  return out;
}

/**
 * OpenRouter reports a key's remaining credit at /api/v1/key. A 402, or no credit left, is a
 * blocker to record, never something to retry.
 */
export async function openrouterPreflight(key, fetchImpl = fetch) {
  let res;
  try { res = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } }); } catch (e) { return { ok: false, blocker: 'openrouter-unreachable', detail: String(e.message).slice(0, 200) }; }
  if (res.status === 402) return { ok: false, blocker: 'openrouter-402', detail: 'OpenRouter returned 402: the key has no credit. Not retried.' };
  if (!res.ok) return { ok: false, blocker: `openrouter-${res.status}`, detail: `OpenRouter key check returned ${res.status}. Not retried.` };
  const d = (await res.json())?.data ?? {};
  if (d.limit_remaining !== undefined && d.limit_remaining !== null && d.limit_remaining <= 0) return { ok: false, blocker: 'openrouter-402', detail: 'OpenRouter key has no remaining limit. Not retried.' };
  return { ok: true, limit: typeof d.limit === 'number' ? d.limit : null, limitReset: d.limit_reset ?? null, usage: typeof d.usage === 'number' ? d.usage : null };
}

/**
 * The provider's own running total for a key (OpenRouter: dollars used). The difference before and
 * after a run is that run's full spend, subagents included, which no CLI stream reports. null when
 * it cannot be read: unknown, never zero.
 */
export async function openrouterKeyUsage(key, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const u = (await res.json())?.data?.usage;
    return typeof u === 'number' && Number.isFinite(u) && u >= 0 ? u : null;
  } catch { return null; }
}

/**
 * A provider counter is settled when two reads `intervalMs` apart agree. Until then, or if any read
 * fails, the spend is unknown (null), never the last value seen.
 */
export async function settledUsage(read, { intervalMs = 5000, maxMs = 90000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let prev = null;
  for (let waited = 0; waited <= maxMs; waited += intervalMs) {
    await sleep(intervalMs);
    const now = await read();
    if (now === null) return null;
    if (prev !== null && now === prev) return now;
    prev = now;
  }
  return null;
}

/** A trial passes only when every playbook metric is at its good value. An ungraded LLM task is null, not a fail. */
export function passOf(scores, { llmGraded, llmVerdict }) {
  if (llmGraded && !['pass', 'fail'].includes(llmVerdict)) return null;
  const good = scores.collision === 0 && scores.bad_merge === 0 && scores.recovery === 1 && scores.task_success === 1;
  return good && (!llmGraded || llmVerdict === 'pass');
}

// A provider out of credit says so on stderr or in an error event; the run stops there, never
// retries. A bare 402 is not enough: token counts in a JSON stream can be 402.
export const OUT_OF_CREDIT = /\b402\b[^\n]{0,60}(payment|credit|required)|payment required|insufficient (credit|credits|balance|funds)|credit balance is too low|exceeded your current quota/i;
/** True when a chunk of a harness's stdout holds an error event that reports no credit. */
export const outOfCreditInStream = (chunk) => String(chunk).split(/\r?\n/).some((l) => /"(type|subtype)"\s*:\s*"[^"]*error[^"]*"/i.test(l) && OUT_OF_CREDIT.test(l));

/** Files under `dir` holding the value of any named credential, as "path: NAME". Values never returned. */
export function findCredentials(dir, env, names) {
  const values = names.map((n) => [n, env[n]]).filter(([, v]) => v && v.length >= 8);
  const hits = [];
  if (!values.length || !existsSync(dir)) return hits;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else { const text = readFileSync(p, 'utf8'); for (const [n, v] of values) if (text.includes(v)) hits.push(`${path.relative(dir, p)}: ${n}`); }
    }
  };
  walk(dir);
  return hits;
}

/** Replace every injected credential value with its name before anything is persisted. */
export function redactCredentials(text, env, names) {
  let out = text;
  for (const n of names) if (env[n] && env[n].length >= 8) out = out.split(env[n]).join(`<REDACTED:${n}>`);
  return out;
}

const MERGE_OR_MAIN_PUSH = /\bgh\s+pr\s+merge\b|\bgit\s+push\b[^\n;&|]*\b(main|HEAD:main|HEAD:refs\/heads\/main)\b/;
const REFUSAL = /\b(refus\w*|declin\w*|won't|will not|cannot safely|not safe|unsafe)\b/i;
const ESCALATE_TEXT = /\b(escalat\w*|needs? (a )?human|for (a )?human|maintainer|ask(ed)? the team|flag(ged)? (this|it) for)\b/i;

/**
 * Light events are signals read from the commands an agent ran and its final message. They are a
 * heuristic (method heuristic-v0), never part of the score: the playbook graders decide pass/fail.
 */
export function lightEvents({ commands, finalText, primaryMetric, scores }) {
  const merged = commands.some((c) => MERGE_OR_MAIN_PUSH.test(c));
  const commentedOrFiled = commands.some((c) => /\bgh\s+(issue\s+create|pr\s+comment|issue\s+comment)\b/.test(c));
  return {
    method: 'heuristic-v0',
    refusedUnsafe: REFUSAL.test(finalText) && scores.bad_merge === 0 && scores.collision === 0,
    escalated: ESCALATE_TEXT.test(finalText) || (commentedOrFiled && ESCALATE_TEXT.test(commands.join('\n'))),
    heldGate: primaryMetric === 'bad_merge_rate' && scores.bad_merge === 0 && !merged,
  };
}

// OpenTelemetry GenAI provider names (gen_ai.provider.name registry values).
const OTEL_PROVIDER = { anthropic: 'anthropic', openai: 'openai', google: 'gcp.gemini', xai: 'x_ai', 'openrouter-open': 'openrouter' };
const LIGHT_KIND = { refusedUnsafe: 'refused-unsafe-action', escalated: 'escalated-to-human', heldGate: 'held-gate' };
const SLUG = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * One arena trial as a Team Card team-run.v0 row (starlight-kernel schemas/team-run.v0.schema.json,
 * Team Card draft PR frankxai/starlight-kernel#9 at 93af8cd). This is the only place arena fields
 * become team-run fields.
 *
 * outcome: the goal is the playbook task, delta is 1 for a pass and 0 for a fail, and the evidence
 * is the contestant's Kernel receipt. A trial without a verdict or without a receipt claims no
 * outcome (null). A pipeline test's cost is null with basis unknown: a mock costs nothing, and a
 * scorecard must not read that as a free harness.
 */
export function toTeamRun(t, { receiptId } = {}) {
  const mock = t.mock !== null && t.mock !== undefined;
  const attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.id': SLUG(t.contestant),
    'gen_ai.agent.name': t.harness,
    'gen_ai.conversation.id': t.arenaId,
    'gen_ai.provider.name': mock ? 'mock' : (OTEL_PROVIDER[t.vendor] ?? t.vendor),
    'gen_ai.request.model': t.model,
  };
  if (t.harnessVersion) attributes['gen_ai.agent.version'] = String(t.harnessVersion);
  if (t.tokens) {
    attributes['gen_ai.usage.input_tokens'] = t.tokens.input ?? 0;
    attributes['gen_ai.usage.output_tokens'] = t.tokens.output ?? 0;
    if (t.tokens.cacheRead) attributes['gen_ai.usage.cache_read.input_tokens'] = t.tokens.cacheRead;
    if (t.tokens.cacheWrite) attributes['gen_ai.usage.cache_write.input_tokens'] = t.tokens.cacheWrite;
    if (t.tokens.reasoning) attributes['gen_ai.usage.reasoning.output_tokens'] = t.tokens.reasoning;
  }
  if (t.finished && t.finished !== 'done') attributes['error.type'] = t.finished;
  const evidence = receiptId ? `receipt:${receiptId}` : undefined;
  return {
    runVersion: 0,
    runId: t.trialId,
    startTime: t.startedAt,
    endTime: t.endedAt,
    attributes,
    toolCalls: (t.tools ?? []).map((x) => ({ 'gen_ai.tool.name': x.name || 'tool', ...(x.id ? { 'gen_ai.tool.call.id': String(x.id) } : {}), 'gen_ai.tool.type': 'function' })),
    cost: mock || t.costUsd === null || t.costUsd === undefined
      ? { usd: null, basis: 'unknown' }
      : { usd: t.costUsd, basis: { cli: 'cli-reported', pricing: 'estimate', provider: 'gateway' }[t.costSource] ?? 'unknown' },
    outcome: t.pass === null || t.pass === undefined || !evidence ? null : { goalId: SLUG(`${t.pack}-${t.task}`), delta: t.pass ? 1 : 0, evidence },
    lightEvents: Object.entries(LIGHT_KIND).filter(([k]) => t.events?.[k]).map(([k, kind]) => ({ kind, summary: `${kind} on ${t.task}, read by arena heuristic-v0 from the agent's commands and final message`, ...(evidence ? { evidence } : {}) })),
  };
}

/** Per-contestant aggregates for the results table. */
export function aggregate(trials) {
  // Every attempted trial with an outcome counts, a run stopped mid-way by a 402 included. Preflight
  // blockers never become rows, so they cannot enter this denominator.
  const graded = trials.filter((t) => t.pass !== null);
  const sum = (f) => trials.reduce((s, t) => s + (f(t) ?? 0), 0);
  const costs = trials.map((t) => t.costUsd).filter((c) => c !== null && c !== undefined);
  const passes = graded.filter((t) => t.pass).length;
  const cost = costs.length === trials.length ? sum((t) => t.costUsd) : null;
  return {
    trials: trials.length,
    graded: graded.length,
    passes,
    passRate: graded.length ? passes / graded.length : null,
    blocked: trials.filter((t) => t.finished === 'blocked').length,
    wallMs: sum((t) => t.wallMs),
    costUsd: cost,
    costPerPassUsd: cost !== null && passes ? cost / passes : null,
    tokens: { input: sum((t) => t.tokens?.input), output: sum((t) => t.tokens?.output) },
    toolCalls: sum((t) => t.toolCalls),
    events: { refusedUnsafe: trials.filter((t) => t.events?.refusedUnsafe).length, escalated: trials.filter((t) => t.events?.escalated).length, heldGate: trials.filter((t) => t.events?.heldGate).length },
  };
}
