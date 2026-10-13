// Collector leg: runs the pinned agentic-ops collector over synthetic transcripts and a
// synthetic Codex goal store. Spawned by session-continuity.mjs with HOME pointed at a
// sandbox, so the collector never sees the runner's own transcripts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  OBSERVED_1, OBSERVED_2, OPERATOR, PROJECT, PROMPT_MARKER, SESSIONS,
  dirtyFingerprint, makeCheckout, workIdOf, writeGoalStore, writeTranscripts,
} from "./fixtures.mjs";

const { sandbox, lifecycle } = JSON.parse(process.argv[2]);
const require = createRequire(join(lifecycle, "noop.js"));
const engine = require(join(lifecycle, "asph-engine.js"));
const exporter = require(join(lifecycle, "sis-continuity.js"));
const { readCodexGoals } = require(join(lifecycle, "codex-goals.js"));
const cli = join(lifecycle, "sis-continuity.js");

const checks = [];
const check = (group, id, ok, detail) => checks.push({ group, id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });

const home = process.env.HOME;
const checkout = makeCheckout(join(sandbox, "checkout"));
const workspace = join(sandbox, "workspace");
mkdirSync(workspace, { recursive: true });
writeTranscripts(home, checkout.root, workspace);
const goalStore = writeGoalStore(join(sandbox, "codex-state", "goals_1.sqlite"));
const dirtyBefore = dirtyFingerprint(checkout.root);
const countTranscripts = () => {
  let n = 0;
  const walk = (dir) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name)) : n++; };
  walk(join(home, ".claude")); walk(join(home, ".codex"));
  return n;
};
const transcriptsBefore = countTranscripts();

// 1. Transcript scan and intent authority, through the collector's own parser.
const scanned = engine.scanSessions();
const byKey = new Map(SESSIONS.map((s) => [s.key, scanned.find((x) => x.engine === s.engine && x.sessionId === s.id)]));
check("intent-authority", "collector-observes-every-synthetic-session", SESSIONS.every((s) => byKey.get(s.key)),
  { observed: [...byKey.values()].filter(Boolean).length, expected: SESSIONS.length });
// Any extra session would mean the collector read a real ~/.claude, ~/.codex, ~/.grok or Hermes store.
check("privacy", "collector-reads-only-synthetic-sessions", scanned.length === SESSIONS.length, { scanned: scanned.length });
for (const s of SESSIONS) {
  const seen = byKey.get(s.key);
  if (!seen) continue;
  const authority = engine.getNextGoalPrompt(seen).goalAuthority;
  const detail = { origin: seen.lastPromptOrigin, partial: seen.partial, truncated: seen.lastPromptTruncated, authority };
  const ok = authority === s.expect.authority
    && (!("origin" in s.expect) || seen.lastPromptOrigin === s.expect.origin)
    && (!s.expect.partial || seen.partial === true)
    && (!s.expect.truncated || seen.lastPromptTruncated === true);
  check("intent-authority", `transcript-authority:${s.key}`, ok, detail);
}

// 2. Native goal store, read through the collector's private-snapshot reader.
const codexIds = SESSIONS.filter((s) => s.engine === "codex").map((s) => s.id);
const native = await readCodexGoals(goalStore, codexIds);
const partial = SESSIONS.find((s) => s.key === "codex-partial");
check("native-goals", "goal-store-read-maps-native-status", native.available && native.goals.size === 3
  && native.goals.get(SESSIONS.find((s) => s.key === "codex-conflict").id)?.state === "blocked"
  && native.goals.get(partial.id)?.state === "paused", { available: native.available, goals: native.goals.size });
const goalStoreFiles = readdirSync(join(sandbox, "codex-state")).sort();
check("native-goals", "goal-store-left-untouched", JSON.stringify(goalStoreFiles) === JSON.stringify(["goals_1.sqlite"]), goalStoreFiles);
const absent = await readCodexGoals(join(sandbox, "codex-state", "absent.sqlite"), codexIds);
const junkFile = join(sandbox, "codex-state-junk.sqlite");
writeFileSync(junkFile, "not a database");
const junk = await readCodexGoals(junkFile, codexIds);
check("fail-closed", "unreadable-goal-store-is-reported-not-guessed", absent.available === false && absent.reason === "goal-store-missing" && junk.available === false,
  { absent: absent.reason, junk: junk.reason });

// 3. Bundle export through the collector CLI, with explicit operator bindings.
const snapshotSessions = scanned.filter((s) => SESSIONS.some((f) => f.engine === s.engine && f.id === s.sessionId));
const bindings = SESSIONS.filter((s) => !s.unbound).map((s) => ({
  engine: s.engine, sessionId: s.id, workId: workIdOf(s), projectId: PROJECT, actorId: OPERATOR, sourceRef: `session:${s.id}`,
  ...(s.bind.reportedState ? { reportedState: s.bind.reportedState } : {}),
  repository: s.where === "workspace"
    ? { root: workspace, origin: checkout.origin, branch: checkout.branch, head: checkout.head }
    : { root: checkout.root, origin: checkout.origin, branch: checkout.branch, head: checkout.head },
}));
const bindingsFile = join(sandbox, "bindings.json");
writeFileSync(bindingsFile, JSON.stringify({ schemaVersion: "starlight.session-bindings.v1", bindings }));
const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: process.env });
const exportBundle = (name, observedAt, extra = []) => {
  const snapshot = join(sandbox, `${name}.snapshot.json`);
  writeFileSync(snapshot, JSON.stringify({ schemaVersion: "starlight.session-snapshot.v1", observedAt, sessions: snapshotSessions }));
  const out = join(sandbox, "bundles", name);
  mkdirSync(join(sandbox, "bundles"), { recursive: true });
  const r = runCli(["--snapshot", snapshot, "--bindings", bindingsFile, "--output", out, ...extra]);
  return { out, status: r.status, result: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};
const b1 = exportBundle("bundle-1", OBSERVED_1, ["--codex-goals", goalStore]);
const b2 = exportBundle("bundle-2", OBSERVED_2, ["--codex-goals", goalStore]);
check("pipeline", "collector-cli-exports-bundles", b1.status === 0 && b2.status === 0, { first: b1.result, second: b2.result });
const verify = runCli(["--verify", b1.out]);
check("pipeline", "collector-verifies-its-own-bundle", verify.status === 0 && JSON.parse(verify.stdout).verified === true);

const bundle = JSON.parse(readFileSync(join(b1.out, "continuity.json"), "utf8"));
const eventFor = (s) => bundle.events.find((e) => e.workId === workIdOf(s));
const issuesFor = (s) => bundle.issues.filter((i) => i.sessionKey === JSON.stringify([s.engine, s.id])).map((i) => i.code).sort();
for (const s of SESSIONS) {
  const event = eventFor(s);
  const issues = issuesFor(s);
  let ok = Boolean(event) === s.expect.event && JSON.stringify(issues) === JSON.stringify([...(s.expect.issues || [])].sort());
  if (event && s.expect.eventAuthority) ok &&= event.data.goalAuthority === s.expect.eventAuthority && event.data.stateVerification === "native-goal-store";
  if (event && s.expect.reportedState) ok &&= event.data.reportedState === s.expect.reportedState;
  if (s.expect.unbound) ok &&= bundle.unboundSessions.includes(JSON.stringify([s.engine, s.id]));
  const group = s.native ? "native-goals" : s.where === "workspace" ? "workspace-and-checkout" : "intent-authority";
  check(group, `bundle-outcome:${s.key}`, ok, { event: Boolean(event), authority: event?.data.goalAuthority ?? null, issues });
}
check("intent-authority", "only-interactive-or-native-intent-becomes-events", bundle.events.length === SESSIONS.filter((s) => s.expect.event).length
  && bundle.events.every((e) => ["explicit-user-directive", "native-goal-store"].includes(e.data.goalAuthority)), { events: bundle.events.length });

// 4. Checkout and workspace sessions.
const observed = bundle.observations.find((o) => o.workId === "work:codex-interactive");
check("workspace-and-checkout", "checkout-identity-and-dirty-flag-recorded", observed && observed.repository.dirty === true
  && observed.repository.head === checkout.head && observed.repository.branch === checkout.branch && observed.repository.origin === checkout.origin);
check("workspace-and-checkout", "workspace-session-has-no-observation", !bundle.observations.some((o) => o.workId === "work:codex-workspace"),
  "pinned main has no workspace scope (agentic-ops #178 is unmerged), so a session outside any checkout fails closed");

// 5. Privacy: the default export is metadata only.
const bundleText = ["events.jsonl", "continuity.json", "recovery.txt", "manifest.json"].map((f) => readFileSync(join(b1.out, f), "utf8")).join("\n");
check("privacy", "metadata-only-bundle-has-no-request-text", bundle.privacy === "metadata-only" && !bundleText.includes(PROMPT_MARKER)
  && !/"objective"|"recoveryPrompt"/.test(bundleText), { privacy: bundle.privacy });
check("privacy", "metadata-only-recovery-note-withholds-text", /Private request text omitted/.test(readFileSync(join(b1.out, "recovery.txt"), "utf8")));
const privateOut = exportBundle("bundle-private", OBSERVED_1, ["--codex-goals", goalStore, "--include-private-text"]);
const privateBundle = privateOut.status === 0 ? JSON.parse(readFileSync(join(privateOut.out, "continuity.json"), "utf8")) : null;
check("privacy", "private-text-only-on-explicit-opt-in", privateBundle?.privacy === "local-private-redacted-text"
  && privateBundle.observations.some((o) => typeof o.objective === "string"), { privacy: privateBundle?.privacy });

// 6. Fail-closed export paths.
const missingStoreOut = join(sandbox, "bundles", "missing-store");
const missingStore = runCli(["--snapshot", join(sandbox, "bundle-1.snapshot.json"), "--bindings", bindingsFile, "--output", missingStoreOut,
  "--codex-goals", join(sandbox, "codex-state", "absent.sqlite")]);
check("fail-closed", "missing-goal-store-refuses-export", missingStore.status === 1 && !existsSync(missingStoreOut));
const before = readFileSync(join(b1.out, "continuity.json"));
const overwrite = runCli(["--snapshot", join(sandbox, "bundle-1.snapshot.json"), "--bindings", bindingsFile, "--output", b1.out]);
check("crash-replay", "export-never-overwrites-an-earlier-bundle", overwrite.status === 1 && Buffer.compare(before, readFileSync(join(b1.out, "continuity.json"))) === 0);
const tampered = join(sandbox, "bundles", "tampered");
mkdirSync(tampered);
for (const f of ["events.jsonl", "continuity.json", "recovery.txt", "manifest.json"]) writeFileSync(join(tampered, f), readFileSync(join(b1.out, f)));
writeFileSync(join(tampered, "events.jsonl"), readFileSync(join(tampered, "events.jsonl"), "utf8") + "\n");
check("fail-closed", "collector-verify-detects-tampering", runCli(["--verify", tampered]).status === 1);
const interrupted = join(sandbox, "bundles", "interrupted");
mkdirSync(interrupted);
for (const f of ["events.jsonl", "continuity.json", "recovery.txt"]) writeFileSync(join(interrupted, f), readFileSync(join(b1.out, f)));
check("fail-closed", "collector-verify-rejects-bundle-without-manifest", runCli(["--verify", interrupted]).status === 1);
let refused = false;
try { exporter.buildContinuityBundle({ schemaVersion: "starlight.session-snapshot.v1", observedAt: "2026-10-04 20:00", sessions: [] },
  { schemaVersion: "starlight.session-bindings.v1", bindings: [] }); } catch { refused = true; }
check("fail-closed", "malformed-snapshot-time-refused", refused);

// 7. Nothing was started, admitted or completed; dirty work survived.
check("no-autostart", "bundle-claims-no-execution-admission-or-completion", [bundle, JSON.parse(readFileSync(join(b2.out, "continuity.json"), "utf8"))]
  .every((b) => b.executionStarted === false && b.admissionGranted === false && b.completionClaimed === false
    && b.observations.every((o) => o.mayAutomaticallyResume === false) && b.events.every((e) => e.data.mayAutomaticallyResume === false)));
check("no-autostart", "no-harness-transcript-created-by-recovery", countTranscripts() === transcriptsBefore, { before: transcriptsBefore, after: countTranscripts() });
check("no-autostart", "dirty-work-preserved-through-collection", dirtyFingerprint(checkout.root) === dirtyBefore);

process.stdout.write(JSON.stringify({ checks, bundles: { first: b1.out, second: b2.out }, collectorSisBase: exporter.SIS_BASE }));
