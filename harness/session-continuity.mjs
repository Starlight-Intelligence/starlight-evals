#!/usr/bin/env node
/**
 * Built on SIP — session-continuity lane (v0.1).
 *
 * Runs synthetic sessions through the real continuity pipeline at pinned SHAs and
 * emits a JSON scorecard:
 *
 *   synthetic transcripts + Codex goal store
 *     -> agentic-ops collector (lifecycle/asph-engine.js, codex-goals.js, sis-continuity.js)
 *     -> continuity bundle
 *     -> SIS importer (src/continuity-import.ts) -> store -> status read model
 *     -> owner reconciliation and proof-gated completion (src/work-graph.ts)
 *
 * It also runs, unmodified, the sources' own regression tests and agentic-ops
 * lifecycle/continuity-proof.js. Sources are fetched from GitHub at an explicit commit and
 * refused on any sha256 mismatch; nothing is copied into this repo except the recorded
 * golden bundles (collector output from synthetic input).
 *
 * WHAT THIS DOES NOT PROVE
 *   No live harness runs (no claude/codex process, no tokens spent); transcripts are
 *   synthetic and follow the formats the pinned parser reads. No installed release is
 *   tested. Owner presence is a simulated typed confirmation. Workspace scope
 *   (agentic-ops #178) is not on the pinned main, so workspace sessions are expected to
 *   fail closed.
 *
 * DEPENDENCY GRACE (load-bearing)
 *   agentic-ops is private. Without AGENTIC_OPS_TOKEN (contents:read on frankxai/agentic-ops)
 *   the collector leg is BLOCKED; the SIS leg then imports the recorded golden bundles and
 *   the verdict is PARTIAL, never PASS. --require-collector turns BLOCKED into a failure.
 *
 * USAGE
 *   node harness/session-continuity.mjs [--out DIR] [--require-collector] [--record-golden] [--keep-sandbox]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitEnv, writeProofThread } from "./continuity/fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const LANE = join(HERE, "continuity");
const GOLDEN = join(ROOT, "fixtures", "continuity", "golden");
const BUNDLE_FILES = ["events.jsonl", "continuity.json", "recovery.txt", "manifest.json"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const outIndex = argv.indexOf("--out");
const OUT_DIR = resolve(outIndex >= 0 ? argv[outIndex + 1] : join(ROOT, "out"));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
const check = (group, id, ok, detail) => checks.push({ group, id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const legs = {};

// ---- 1. Pinned sources -------------------------------------------------------
const pins = JSON.parse(readFileSync(join(LANE, "pins.json"), "utf8")).repositories;
const token = process.env.AGENTIC_OPS_TOKEN || "";

async function fetchPinned(spec, path) {
  const headers = { "User-Agent": "starlight-evals-continuity" };
  let url;
  if (spec.visibility === "private") {
    if (!token) return { error: "missing-token" };
    url = `https://api.github.com/repos/${spec.repo}/contents/${path}?ref=${spec.sha}`;
    headers.Accept = "application/vnd.github.raw";
    headers.Authorization = `Bearer ${token}`;
  } else {
    url = `https://raw.githubusercontent.com/${spec.repo}/${spec.sha}/${path}`;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()) };
      if (attempt >= 3 || response.status < 500) return { error: `http-${response.status}` };
    } catch (error) {
      if (attempt >= 3) return { error: "network-error" };
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

const sources = [];
const fetched = {};
for (const [name, spec] of Object.entries(pins)) {
  fetched[name] = {};
  for (const [path, expected] of Object.entries(spec.files)) {
    const result = await fetchPinned(spec, path);
    const actual = result.bytes ? sha256(result.bytes) : null;
    const verified = Boolean(actual) && actual === expected;
    sources.push({ repo: spec.repo, sha: spec.sha, path, sha256: expected, verified,
      ...(result.error ? { error: result.error } : {}), ...(actual && !verified ? { actualSha256: actual } : {}) });
    if (verified) fetched[name][path] = result.bytes;
  }
}
const complete = (name) => Object.keys(pins[name].files).every((p) => fetched[name][p]);
const collectorBlocked = !complete("agentic-ops") && sources.filter((s) => s.repo === pins["agentic-ops"].repo).every((s) => s.error);
const hashFailures = sources.filter((s) => !s.verified && !(collectorBlocked && s.repo === pins["agentic-ops"].repo));
check("sources", "pinned-sources-fetched-and-hash-verified", hashFailures.length === 0,
  hashFailures.length ? hashFailures.map((s) => ({ repo: s.repo, path: s.path, error: s.error, actualSha256: s.actualSha256 })) : `${sources.filter((s) => s.verified).length} files`);

// ---- 2. Sandbox -----------------------------------------------------------------
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "starlight-continuity-eval-")));
const place = (dir, files) => {
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); }
};
const opsDir = join(sandbox, "agentic-ops");
const sisDir = join(sandbox, "sis");
place(opsDir, { ...fetched["agentic-ops"], "package.json": '{"type":"commonjs"}\n' });
place(sisDir, { ...fetched.sis, "package.json": '{"type":"module"}\n' });
cpSync(join(LANE, "loader"), join(sisDir, "node_modules", "tsx"), { recursive: true });
const mutationIndex = argv.indexOf("--mutation");
const MUTATION = mutationIndex >= 0 ? argv[mutationIndex + 1] : null;
if (MUTATION) {
  const edits = JSON.parse(readFileSync(join(LANE, "mutations.json"), "utf8"))[MUTATION];
  if (!edits) throw new Error(`Unknown mutation ${MUTATION}`);
  for (const { file, from, to } of edits) {
    const target = join(sandbox, file);
    const text = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (!text.includes(from)) throw new Error(`Mutation ${MUTATION} no longer applies to ${file}; update mutations.json with the pin`);
    writeFileSync(target, text.replace(from, to));
  }
}
const loader = pathToFileURL(join(sisDir, "node_modules", "tsx", "index.mjs")).href;

function sandboxEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)) delete env[key];
  // Under an outer `node --test`, this would route the nested suites' results to the parent.
  delete env.NODE_TEST_CONTEXT;
  mkdirSync(home, { recursive: true });
  return { ...env, ...gitEnv(sandbox), HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"),
    ASPH_SESSION_INDEX: join(home, "asph-index.v2.json"), PROMPT_LEDGER_DIR: join(home, "prompt-ledger"),
    PROMPT_LEDGER_CURSOR: join(home, "prompt-ledger-cursor.json"), PROMPT_HARVEST_CURSOR: join(home, "prompt-harvest-cursor.json"), ...extra };
}

function runLeg(name, args, env, cwd = ROOT) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  try {
    const result = JSON.parse(r.stdout);
    checks.push(...result.checks);
    return result;
  } catch {
    check(name, `${name}-leg-ran`, false, { exitCode: r.status, code: "leg-crashed" });
    return null;
  }
}

function tapSuite(group, id, args, cwd, env) {
  const r = spawnSync(process.execPath, ["--test-reporter=tap", ...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const count = (label) => Number((new RegExp(`^# ${label} (\\d+)`, "m").exec(r.stdout) || [])[1] ?? NaN);
  const result = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo") };
  const failing = [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((x) => x[1]).slice(0, 20);
  check(group, id, r.status === 0 && result.fail === 0 && result.pass > 0, { ...result, ...(failing.length ? { failing } : {}), ...(r.status ? { exitCode: r.status } : {}) });
  return result;
}

// ---- 3. Collector leg (live) ------------------------------------------------------
let bundles = null;
let bundleSource = "golden";
if (collectorBlocked) {
  legs.collector = { status: "BLOCKED", reason: "AGENTIC_OPS_TOKEN is not set or cannot read frankxai/agentic-ops; the private collector was not run" };
} else if (complete("agentic-ops")) {
  const lifecycle = join(opsDir, "lifecycle");
  const result = runLeg("pipeline", [join(LANE, "collector-leg.mjs"), JSON.stringify({ sandbox: join(sandbox, "collector"), lifecycle })],
    sandboxEnv(join(sandbox, "collector", "home")));
  legs.collector = { status: result ? "RAN" : "CRASHED" };
  if (result) {
    bundles = result.bundles;
    bundleSource = "live";
    // Record or compare the collector output, with the sandbox path replaced, as golden bundles.
    const normalize = spawnSync(process.execPath, [join(LANE, "normalize-bundle.cjs"), lifecycle, join(sandbox, "collector"), join(sandbox, "golden-candidate"),
      result.bundles.first, result.bundles.second], { env: sandboxEnv(join(sandbox, "normalize-home")), encoding: "utf8" });
    if (normalize.status !== 0) check("pipeline", "golden-bundles-normalized", false, { exitCode: normalize.status });
    else if (flag("--record-golden") && !MUTATION) {
      rmSync(GOLDEN, { recursive: true, force: true });
      cpSync(join(sandbox, "golden-candidate"), GOLDEN, { recursive: true });
      writeFileSync(join(GOLDEN, "provenance.json"), JSON.stringify({
        $comment: "Collector output for the synthetic sessions in harness/continuity/fixtures.mjs, produced by the pinned agentic-ops collector. The sandbox path was replaced by /sandbox and the bundle re-sealed with the collector's own writeContinuityBundle. Re-record with --record-golden only after reviewing the diff.",
        collector: { repo: pins["agentic-ops"].repo, sha: pins["agentic-ops"].sha }, collectorSisBase: result.collectorSisBase,
      }, null, 2) + "\n");
      check("pipeline", "golden-bundles-recorded-from-live-collector", true, "recorded");
    } else {
      const drift = ["bundle-1", "bundle-2"].flatMap((b) => BUNDLE_FILES.filter((f) => {
        const golden = join(GOLDEN, b, f);
        return !existsSync(golden) || !readFileSync(golden).equals(readFileSync(join(sandbox, "golden-candidate", b, f)));
      }).map((f) => `${b}/${f}`));
      check("pipeline", "live-collector-output-matches-recorded-golden", drift.length === 0, drift.length ? { drifted: drift } : undefined);
    }
  }
} else {
  legs.collector = { status: "UNVERIFIED", reason: "agentic-ops sources failed hash verification; nothing from them was executed" };
}

// ---- 4. SIS leg -----------------------------------------------------------------------
if (complete("sis")) {
  if (!bundles) {
    const copy = join(sandbox, "golden");
    cpSync(GOLDEN, copy, { recursive: true });
    bundles = { first: join(copy, "bundle-1"), second: join(copy, "bundle-2") };
  }
  runLeg("pipeline", ["--import", loader, join(LANE, "sis-leg.mjs"), JSON.stringify({ sandbox: join(sandbox, "sis-run"), sis: sisDir, bundles, loader })],
    sandboxEnv(join(sandbox, "sis-run", "home")));
  legs.sis = { status: "RAN", bundleSource };
  legs.sisRegression = tapSuite("regression-suites", "sis-continuity-regression-tests-pass",
    ["--import", "tsx", "--test", "test/continuity-import.test.ts", "test/continuity-cli.test.ts", "test/continuity-review-regressions.test.ts"],
    sisDir, sandboxEnv(join(sandbox, "sis-tests-home")));
} else {
  legs.sis = { status: "UNVERIFIED" };
}

// ---- 5. agentic-ops suites: unit tests and the end-to-end continuity proof ---------------
if (legs.collector.status === "RAN") {
  legs.collectorTests = tapSuite("regression-suites", "agentic-ops-continuity-tests-pass",
    ["--test", "lifecycle/codex-goals.test.js", "lifecycle/sis-continuity.test.js", "lifecycle/sis-continuity.conformance.test.js"], opsDir,
    sandboxEnv(join(sandbox, "ops-tests-home"), { SIS_WORK_GRAPH_SOURCE: join(sisDir, "src", "work-graph.ts") }));
  const thread = writeProofThread(join(sandbox, "proof-input"));
  const proofOut = join(sandbox, "proof-out");
  const proof = spawnSync(process.execPath, [join(opsDir, "lifecycle", "continuity-proof.js"), "--sis", sisDir, "--out", proofOut,
    "--codex-goals", thread.goals, "--codex-thread", thread.thread, "--codex-rollout", thread.rollout],
  { cwd: opsDir, env: sandboxEnv(join(sandbox, "proof-home")), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const receiptFile = join(proofOut, "receipt.json");
  if (existsSync(receiptFile)) {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    for (const [name, c] of Object.entries(receipt.checks)) {
      const detail = c.detail && typeof c.detail === "object" ? JSON.parse(JSON.stringify(c.detail, (k, v) => k === "killTrace" ? undefined : v)) : c.detail;
      check("continuity-proof", name, c.ok, detail);
    }
    legs.continuityProof = { pass: receipt.pass, complete: receipt.complete, scope: receipt.scope,
      note: "complete=false is expected: the real interrupted claude/codex harness leg (--harness-runs) spends tokens and is never run here" };
  } else {
    check("continuity-proof", "continuity-proof-ran", false, { exitCode: proof.status, code: "proof-crashed" });
  }
}

// ---- 6. Scorecard -------------------------------------------------------------------------
// Last line of defence: the scorecard is published as a CI artifact, so no string in it may
// carry a host path, temp dir, user name, host name or error/stack text. Any hit is
// replaced and fails the run, because it means an upstream detail escaped its code mapping.
const forbidden = [sandbox, tmpdir(), homedir(), ROOT, OUT_DIR].filter((v) => v && v.length > 3)
  .flatMap((v) => [v, v.replace(/\\/g, "/")]).map((v) => v.toLowerCase());
const userName = (() => { try { return userInfo().username; } catch { return ""; } })();
const PUBLIC_NAMES = [...new Set([...Object.values(pins).map((p) => p.repo), "starlight-evals"])];
const wordPatterns = [userName, hostname()].filter((v) => v && v.length >= 3)
  .map((v) => new RegExp(`(^|[^A-Za-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i"));
const hostDataPatterns = [/\b[A-Za-z]:[\\/]/, /(^|[^A-Za-z0-9.])\/(home|Users|tmp|var|private|root|runner)\//, /\bError:/, /\n\s+at\s/, /node:internal/];
let redactions = 0;
const scrub = (value) => {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    // A host can be named like a pinned public repo (e.g. "Starlight"); those names are not host data.
    const unpinned = PUBLIC_NAMES.reduce((text, name) => text.split(name).join(" "), value);
    if (forbidden.some((v) => lower.includes(v)) || wordPatterns.some((p) => p.test(unpinned)) || hostDataPatterns.some((p) => p.test(value))) { redactions++; return "[redacted-host-data]"; }
    return value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
};
for (const c of checks) if (c.detail !== undefined) c.detail = scrub(c.detail);
for (const key of Object.keys(legs)) legs[key] = scrub(legs[key]);
for (const [i, source] of sources.entries()) sources[i] = scrub(source);
check("privacy", "scorecard-free-of-host-identifiers", redactions === 0, { redactions });
const failed = checks.filter((c) => !c.ok);
const verdict = failed.length ? "FAIL" : legs.collector.status === "RAN" ? "PASS" : "PARTIAL";
const exitCode = verdict === "FAIL" || (verdict === "PARTIAL" && flag("--require-collector")) ? 1 : 0;
const groups = {};
for (const c of checks) (groups[c.group] ??= { passed: 0, failed: 0 })[c.ok ? "passed" : "failed"]++;
const scorecard = {
  schema: "starlight-evals.session-continuity-scorecard.v1",
  lane: "session-continuity",
  version: "0.1",
  generatedAt: new Date().toISOString(),
  execution: { node: process.version, platform: process.platform, ci: Boolean(process.env.CI) },
  ...(MUTATION ? { mutation: MUTATION } : {}),
  verdict,
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
  legs,
  groups,
  sources,
  checks,
  proves: [
    "The pinned collector grants intent authority only to complete interactive /goal requests or an interactive thread's native Codex goal; headless claude -p, codex exec, partial and clipped captures stay unresolved.",
    "Codex native goals in the thread_goals schema recover intent a sliced transcript cannot, carry verified state, and surface goal and state conflicts as issues.",
    "Metadata-only bundles contain no request text; private text appears only on explicit opt-in.",
    "The pinned SIS importer quarantines every untrusted claim with a named reason and refuses tampered, interrupted, foreign-kind or self-admitting bundles outright.",
    "Import is idempotent across replay and simulated crashes (torn tail, missing receipt, missing events), and a reused event ID with new content refuses the bundle.",
    "Only the registered owner with a typed confirmation can admit; agents without a terminal, operators and impostors cannot; completion stays gated on every required proof.",
    "Nothing is resumed, admitted or started automatically, and uncommitted work in the bound checkout survives recovery byte for byte."
  ],
  doesNotProve: [
    "No live harness: no claude or codex process is started; transcripts are synthetic and match the formats the pinned parser reads, not necessarily every format a future release writes.",
    "No installed release: sources run from pinned commits in a sandbox, not from an installed Starlight or SIS package.",
    "Types are stripped, not checked: a stand-in loader replaces tsx; SIS's own CI runs tsc.",
    "Owner presence is a simulated typed confirmation; the SIS library trusts its caller, so this is not authentication.",
    "Workspace scope (agentic-ops #178, SIS #291) is not on the pinned main; workspace sessions are only shown to fail closed.",
    "Structural completion is not signed deployment acceptance."
  ],
};
const scorecardDir = MUTATION ? join(OUT_DIR, "mutations") : OUT_DIR;
mkdirSync(scorecardDir, { recursive: true });
const outFile = join(scorecardDir, `session-continuity-${MUTATION ? `${MUTATION}-` : ""}${scorecard.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outFile, JSON.stringify(scorecard, null, 2) + "\n");
if (!flag("--keep-sandbox")) rmSync(sandbox, { recursive: true, force: true });

console.log(`\nSession continuity lane v0.1 — ${verdict}${MUTATION ? ` (mutation: ${MUTATION})` : ""}`);
console.log(`collector leg: ${legs.collector.status}${legs.collector.reason ? ` (${legs.collector.reason})` : ""}; SIS leg on ${bundleSource} bundles`);
for (const [group, g] of Object.entries(groups)) console.log(`  ${g.failed ? "FAIL" : "ok  "} ${group.padEnd(24)} ${g.passed}/${g.passed + g.failed}`);
for (const c of failed) console.log(`  FAILED ${c.group}/${c.id}: ${JSON.stringify(c.detail ?? null).slice(0, 400)}`);
console.log(`${scorecard.summary.passed}/${scorecard.summary.checks} checks passed. Scorecard: ${relative(process.cwd(), outFile).replace(/\\/g, "/")}`);
if (verdict === "PARTIAL") {
  const message = "PARTIAL: the private collector leg did not run, so this is not a PASS. Set AGENTIC_OPS_TOKEN to run it.";
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Continuity collector leg blocked::${message}` : message);
}
process.exitCode = exitCode;
