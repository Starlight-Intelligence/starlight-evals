// SIS leg: imports collector bundles into the pinned SIS importer and exercises trust,
// quarantine, crash/replay, owner-only admission and proof-gated completion. Spawned with
// the type-stripping loader so the pinned .ts sources run unmodified.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OPERATOR, OWNER, PROJECT, SESSIONS, workIdOf } from "./fixtures.mjs";

const { sandbox, sis, bundles, loader } = JSON.parse(process.argv[2]);
const m = await import(pathToFileURL(join(sis, "src", "continuity-import.ts")).href);
const wg = await import(pathToFileURL(join(sis, "src", "work-graph.ts")).href);
const cliPath = join(sis, "src", "continuity-cli.ts");

const checks = [];
const check = (group, id, ok, detail) => checks.push({ group, id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
// Refusal text can carry store paths; the scorecard only ever records these fixed codes.
const REFUSAL_CODES = [
  [/unsupported SIS source revision/, "unsupported-source-revision"], [/Checksum mismatch/, "checksum-mismatch"],
  [/manifest is incomplete/, "bundle-incomplete"], [/could not be read/, "bundle-unreadable"], [/may not claim/, "bundle-claims-authority"],
  [/only supply intent\.captured/, "foreign-event-kind"], [/Trust policy/, "invalid-trust-policy"], [/corrupt line/, "corrupt-store-line"],
  [/in progress/, "import-in-progress"], [/conflicts with stored content/, "event-id-conflict"], [/conflicts with the observation/, "observation-conflict"],
  [/not registered/, "work-not-registered"], [/Only the registered owner/, "not-owner"], [/reason is required/, "reason-required"],
  [/confirm the work ID/, "confirmation-required"], [/must require verification/, "verification-required"],
  [/acknowledge it explicitly/, "paused-not-acknowledged"], [/already admitted/, "already-admitted"], [/Work is blocked/, "work-blocked"],
  [/Work is completed/, "work-completed"], [/interactive terminal/, "no-interactive-terminal"], [/No trusted captured intent/, "no-trusted-intent"],
];
const code = (message) => message == null ? null : REFUSAL_CODES.find(([pattern]) => pattern.test(message))?.[1] ?? "unclassified";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const bundle1 = JSON.parse(read(bundles.first, "continuity.json"));
const eventWorks = SESSIONS.filter((s) => s.expect.event).map(workIdOf);
const checkoutOf = bundle1.observations[0]?.repository;

const basePolicy = () => ({
  schemaVersion: "starlight.continuity-trust.v1",
  supportedSourceRevisions: [bundle1.sisSourceRevision],
  collectors: [{ harness: "codex", sourceRefPrefix: "session:" }, { harness: "claude", sourceRefPrefix: "session:" }],
  operators: [OPERATOR],
  works: SESSIONS.filter((s) => !s.unbound).map((s) => ({ workId: workIdOf(s), projectId: PROJECT, ownerActorId: OWNER,
    checkout: { origin: checkoutOf.origin, branch: checkoutOf.branch } })),
});
let stores = 0;
const freshStore = () => join(sandbox, "sis-stores", `store-${++stores}`);
const lines = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const storeEvents = (store) => lines(join(store, "events.jsonl")).map((l) => JSON.parse(l));

// Rewrites a bundle and re-seals a valid manifest: a compromised collector can always
// produce matching checksums, so these cases test the trust policy, not integrity.
let reseals = 0;
function reseal(source, mutate) {
  const dir = join(sandbox, "resealed", `bundle-${++reseals}`);
  mkdirSync(dir, { recursive: true });
  const bundle = JSON.parse(read(source, "continuity.json"));
  mutate(bundle);
  const files = {
    "events.jsonl": bundle.events.map((e) => JSON.stringify(e)).join("\n") + (bundle.events.length ? "\n" : ""),
    "continuity.json": JSON.stringify(bundle, null, 2) + "\n",
    "recovery.txt": read(source, "recovery.txt"),
  };
  const checksums = {};
  for (const [name, value] of Object.entries(files)) { writeFileSync(join(dir, name), value); checksums[name] = sha(value); }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: "starlight.continuity-manifest.v1", checksums,
    eventCount: bundle.events.length, issueCount: bundle.issues.length, complete: true }, null, 2) + "\n");
  return dir;
}

// 1. The real pipeline: collector bundle into the SIS store.
const store = freshStore();
const policy = basePolicy();
const first = m.importContinuityBundle(bundles.first, store, policy);
check("pipeline", "sis-imports-collector-bundle", first.status === "imported" && first.accepted.length === eventWorks.length && first.quarantined.length === 0,
  { status: first.status, accepted: first.accepted.length, quarantined: first.quarantined.length, refusal: code(first.refusal) });
check("no-autostart", "import-starts-nothing", first.executionStarted === false);
const status = m.continuityStatus(store, policy);
const work = (s, st = status) => st.works.find((w) => w.workId === s);
check("pipeline", "status-read-model-is-versioned", status.schemaVersion === "starlight.continuity-status.v1" && status.works.length === eventWorks.length,
  { works: status.works.map((w) => `${w.workId}:${w.state}`) });
check("no-autostart", "no-work-admitted-or-resumable-after-import", status.works.every((w) => w.admission.admitted === false && w.mayAutomaticallyResume === false));
const partialWork = work("work:codex-partial");
check("native-goals", "native-goal-survives-import-with-verified-state", partialWork?.intent.goalAuthority.join() === "native-goal-store"
  && partialWork.reportedState?.verification === "native-goal-store" && partialWork.reportedState.value === "paused"
  && partialWork.intent.captureCompleteness.join() === "complete", partialWork && { reported: partialWork.reportedState, authority: partialWork.intent.goalAuthority });
check("workspace-and-checkout", "checkout-and-dirty-work-recovered", partialWork?.checkout?.dirty === true && partialWork.checkout.head === checkoutOf.head
  && partialWork.checkout.branch === checkoutOf.branch, partialWork?.checkout);
check("fail-closed", "only-reported-active-work-skips-owner-input", work("work:codex-interactive")?.state === "submitted"
  && ["work:claude-interactive", "work:codex-partial", "work:codex-conflict"].every((id) => work(id)?.state === "input-required"),
  status.works.map((w) => `${w.workId}:${w.state}`));

// 2. Crash and replay.
const eventsBefore = read(store, "events.jsonl");
const again = m.importContinuityBundle(bundles.first, store, policy);
check("crash-replay", "replaying-the-same-bundle-is-a-no-op", again.status === "already-imported" && read(store, "events.jsonl") === eventsBefore);
const second = m.importContinuityBundle(bundles.second, store, policy);
const afterSecond = m.continuityStatus(store, policy);
check("crash-replay", "fresh-observation-is-not-a-new-request", second.status === "imported"
  && eventWorks.every((id) => work(id, afterSecond).intent.observations === 2 && work(id, afterSecond).intent.distinctRequests === 1),
  work("work:codex-partial", afterSecond)?.intent);
const ids = storeEvents(store).map((e) => e.eventId);
check("crash-replay", "store-holds-no-duplicate-events", ids.length === new Set(ids).size && ids.length === eventWorks.length * 2, { stored: ids.length });

// Crash after the observations were written but before events and receipt.
const crashA = freshStore();
m.importContinuityBundle(bundles.first, crashA, policy);
const observationsA = read(crashA, "observations.jsonl");
rmSync(join(crashA, "events.jsonl"));
rmSync(join(crashA, "imports.jsonl"));
const replayA = m.importContinuityBundle(bundles.first, crashA, policy);
check("crash-replay", "crash-before-events-replays-without-duplicate-observations", replayA.status === "imported"
  && replayA.accepted.length === eventWorks.length && read(crashA, "observations.jsonl") === observationsA, { accepted: replayA.accepted.length });

// Crash mid-append: a torn final line and no receipt.
const crashB = freshStore();
m.importContinuityBundle(bundles.first, crashB, policy);
truncateSync(join(crashB, "imports.jsonl"), 0);
appendFileSync(join(crashB, "events.jsonl"), '{"schemaVersion":"1.0","eventId":"torn');
const replayB = m.importContinuityBundle(bundles.first, crashB, policy);
const statusB = m.continuityStatus(crashB, policy);
check("crash-replay", "torn-tail-is-ignored-and-replay-completes", replayB.status === "imported" && replayB.accepted.length === 0
  && replayB.duplicates.length === eventWorks.length && lines(join(crashB, "imports.jsonl")).length === 1 && statusB.works.length === eventWorks.length,
  { status: replayB.status, duplicates: replayB.duplicates.length, refusal: code(replayB.refusal) });

const conflicting = reseal(bundles.first, (b) => { b.events[0].summary = "Altered after export."; });
const storedBefore = read(store, "events.jsonl");
const conflict = m.importContinuityBundle(conflicting, store, policy);
check("crash-replay", "reused-event-id-with-new-content-refuses-whole-bundle", conflict.status === "refused" && /conflicts with stored content/.test(conflict.refusal)
  && read(store, "events.jsonl") === storedBefore, code(conflict.refusal));

// 3. Quarantine: each untrusted claim is held back with a reason, never silently dropped.
const quarantineCase = (id, mutatePolicy, mutateBundle, expectReason, expectWorks) => {
  const p = basePolicy();
  mutatePolicy?.(p);
  const source = mutateBundle ? reseal(bundles.first, mutateBundle) : bundles.first;
  const s = freshStore();
  const r = m.importContinuityBundle(source, s, p);
  const reasons = r.quarantined.filter((q) => expectWorks.includes(q.workId)).map((q) => q.reason);
  const held = lines(join(s, "quarantine.jsonl")).map((l) => JSON.parse(l));
  const ok = r.status === "imported" && reasons.length === expectWorks.length && reasons.every((x) => x === expectReason)
    && held.length === r.quarantined.length && !storeEvents(s).some((e) => expectWorks.includes(e.workId));
  check("quarantine", id, ok, { reasons: r.quarantined.map((q) => `${q.workId}:${q.reason}`), status: r.status, refusal: code(r.refusal) });
};
quarantineCase("unregistered-work", (p) => { p.works = p.works.filter((w) => w.workId !== "work:claude-interactive"); }, null, "unregistered-work", ["work:claude-interactive"]);
quarantineCase("project-mismatch", (p) => { p.works.find((w) => w.workId === "work:codex-interactive").projectId = "project:other"; }, null, "project-mismatch", ["work:codex-interactive"]);
quarantineCase("untrusted-collector", (p) => { p.collectors = p.collectors.filter((c) => c.harness !== "claude"); }, null, "untrusted-collector", ["work:claude-interactive"]);
quarantineCase("unknown-operator", (p) => { p.operators = ["actor:someone-else"]; }, null, "unknown-operator", eventWorks);
quarantineCase("checkout-mismatch", (p) => { p.works.find((w) => w.workId === "work:codex-partial").checkout.branch = "main"; }, null, "checkout-mismatch", ["work:codex-partial"]);
quarantineCase("observation-missing", null, (b) => { b.observations.find((o) => o.workId === "work:codex-interactive").requestDigest = "0".repeat(64); },
  "observation-missing", ["work:codex-interactive"]);
quarantineCase("observation-ambiguous", null, (b) => { b.observations.push({ ...b.observations.find((o) => o.workId === "work:claude-interactive") }); },
  "observation-ambiguous", ["work:claude-interactive"]);
quarantineCase("claim-invalid", null, (b) => { b.events.find((e) => e.workId === "work:codex-partial").data.stateVerification = "self-asserted"; },
  "claim-invalid", ["work:codex-partial"]);
quarantineCase("resume-not-forbidden", null, (b) => { b.events.find((e) => e.workId === "work:codex-conflict").data.mayAutomaticallyResume = true; },
  "resume-not-forbidden", ["work:codex-conflict"]);

// 4. Fail-closed refusals: the whole bundle is refused and nothing is written.
const refusalCase = (id, source, p, pattern) => {
  const s = freshStore();
  const r = m.importContinuityBundle(source, s, p);
  check("fail-closed", id, r.status === "refused" && pattern.test(r.refusal ?? "") && lines(join(s, "events.jsonl")).length === 0, code(r.refusal));
};
refusalCase("unsupported-source-revision", bundles.first, { ...basePolicy(), supportedSourceRevisions: ["f".repeat(40)] }, /unsupported SIS source revision/);
const tamperedDir = join(sandbox, "resealed", "tampered");
cpSync(bundles.first, tamperedDir, { recursive: true });
appendFileSync(join(tamperedDir, "events.jsonl"), "\n");
refusalCase("tampered-bundle-checksum", tamperedDir, basePolicy(), /Checksum mismatch/);
const interruptedDir = join(sandbox, "resealed", "interrupted");
cpSync(bundles.first, interruptedDir, { recursive: true });
rmSync(join(interruptedDir, "manifest.json"));
refusalCase("interrupted-export-without-manifest", interruptedDir, basePolicy(), /.+/);
refusalCase("bundle-claiming-admission", reseal(bundles.first, (b) => { b.admissionGranted = true; }), basePolicy(), /may not claim execution, admission or completion/);
refusalCase("collector-supplying-non-intent-event", reseal(bundles.first, (b) => { b.events[0].kind = "work.completed"; }), basePolicy(), /only supply intent.captured/);
refusalCase("invalid-trust-policy", bundles.first, { schemaVersion: "starlight.continuity-trust.v0" }, /Trust policy must declare/);
const corrupt = freshStore();
m.importContinuityBundle(bundles.first, corrupt, policy);
writeFileSync(join(corrupt, "events.jsonl"), "{not json}\n" + read(corrupt, "events.jsonl"));
const corruptResult = m.importContinuityBundle(bundles.second, corrupt, policy);
check("fail-closed", "corrupt-store-line-refuses-import", corruptResult.status === "refused" && /corrupt line/.test(corruptResult.refusal), code(corruptResult.refusal));
const locked = freshStore();
mkdirSync(locked, { recursive: true });
writeFileSync(join(locked, ".import.lock"), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), token: "live-holder" }));
const lockedResult = m.importContinuityBundle(bundles.first, locked, policy);
check("fail-closed", "live-import-lock-is-never-preempted", lockedResult.status === "refused" && /in progress/.test(lockedResult.refusal) && !existsSync(join(locked, "events.jsonl")),
  code(lockedResult.refusal));

// 5. Owner-only admission. Only the registered owner, present at a terminal, may admit.
const NOW = new Date("2026-10-04T22:00:00.000Z");
const typed = (workId) => ({ method: "interactive-terminal", typedWorkId: workId });
const attempt = (request) => { try { return { ok: true, event: m.reconcileWork(store, policy, { reason: "eval", now: NOW, ...request }) }; } catch (e) { return { ok: false, error: e.message }; } };
const target = "work:codex-partial";
const refusals = {
  unregistered: attempt({ workId: "work:not-registered", actorId: OWNER, decision: "admit", confirmation: typed("work:not-registered"), acknowledgePaused: true }),
  operatorNotOwner: attempt({ workId: target, actorId: OPERATOR, decision: "admit", confirmation: typed(target), acknowledgePaused: true }),
  agentImpostor: attempt({ workId: target, actorId: "actor:codex", decision: "admit", confirmation: typed(target), acknowledgePaused: true }),
  wrongTypedId: attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed("work:codex-interactive"), acknowledgePaused: true }),
  noConfirmation: attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: { method: "mcp-call", typedWorkId: target }, acknowledgePaused: true }),
  emptyReason: attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed(target), acknowledgePaused: true, reason: " " }),
  pausedNotAcknowledged: attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed(target) }),
  verificationNotRequired: attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed(target), acknowledgePaused: true,
    requirements: { artifact: true, change: true, checks: true, deployment: false, verification: false } }),
};
check("owner-admission", "non-owner-and-unconfirmed-admissions-refused", Object.values(refusals).every((r) => r.ok === false),
  Object.fromEntries(Object.entries(refusals).map(([k, v]) => [k, v.ok ? "ADMITTED" : code(v.error)])));
check("owner-admission", "refusals-write-nothing", !storeEvents(store).some((e) => e.kind !== "intent.captured"));
const cli = spawnSync(process.execPath, ["--import", loader, cliPath, "reconcile", "--work", target, "--actor", OWNER, "--decision", "admit", "--reason", "eval", "--acknowledge-paused"],
  { env: { ...process.env, SIS_CONTINUITY_HOME: join(sandbox, "sis-cli-home") }, encoding: "utf8" });
check("owner-admission", "agents-without-a-terminal-cannot-admit-through-the-cli", cli.status === 1 && /interactive terminal/.test(cli.stderr), code(cli.stderr));
const owner = attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed(target), acknowledgePaused: true });
check("owner-admission", "registered-owner-admits-after-acknowledging-paused-state", owner.ok && owner.event.kind === "work.admitted"
  && owner.event.source.system === "human" && owner.event.data.acknowledgedReportedState === true, owner.ok ? owner.event.kind : code(owner.error));
const secondClaim = attempt({ workId: target, actorId: OWNER, decision: "admit", confirmation: typed(target), acknowledgePaused: true });
check("owner-admission", "second-admission-claim-refused", secondClaim.ok === false && /already admitted/.test(secondClaim.error), code(secondClaim.error));
const activeAdmit = attempt({ workId: "work:codex-interactive", actorId: OWNER, decision: "admit", confirmation: typed("work:codex-interactive") });
check("owner-admission", "reported-active-work-admits-without-acknowledgement", activeAdmit.ok, activeAdmit.ok ? "admitted" : code(activeAdmit.error));
const blocked = attempt({ workId: "work:claude-interactive", actorId: OWNER, decision: "block", confirmation: typed("work:claude-interactive") });
const afterBlock = attempt({ workId: "work:claude-interactive", actorId: OWNER, decision: "admit", confirmation: typed("work:claude-interactive"), acknowledgePaused: true });
check("owner-admission", "owner-block-is-final-for-admission", blocked.ok && blocked.event.kind === "work.blocked" && afterBlock.ok === false && /blocked/.test(afterBlock.error),
  code(afterBlock.error));

// 6. Proof-gated completion.
const admittedStatus = work(target, m.continuityStatus(store, policy));
check("proof-gated-completion", "admitted-work-is-working-not-complete", admittedStatus.state === "working" && admittedStatus.delivery.completed === false
  && admittedStatus.delivery.missingProofs.includes("verification"), admittedStatus.delivery.missingProofs);
const stored = storeEvents(store);
const admitted = stored.find((e) => e.workId === target && e.kind === "work.admitted");
let n = 0;
const proof = (kind) => ({ ...admitted, kind, eventId: `eval-proof:${++n}`, source: { system: "ci", sourceId: "eval" },
  observedAt: `2026-10-04T23:00:${String(n).padStart(2, "0")}.000Z`, occurredAt: `2026-10-04T23:00:${String(n).padStart(2, "0")}.000Z`, data: {} });
const project = (extra) => {
  const projected = wg.projectWorkGraph([...stored, ...extra]);
  return { item: projected.workItems.find((w) => w.workId === target), issues: projected.issues.filter((i) => i.workId === target).map((i) => i.code) };
};
const bare = project([proof("work.completed")]);
check("proof-gated-completion", "completion-without-proof-is-refused", bare.item.completed === false && bare.issues.includes("completion-gate-failed"), bare.issues);
const required = Object.entries(admitted.data.requirements).filter(([, v]) => v).map(([k]) => ({ artifact: "artifact.produced", change: "change.opened",
  checks: "check.passed", deployment: "deployment.succeeded", verification: "verification.passed" })[k]);
n = 0;
const missingVerification = project([...required.filter((k) => k !== "verification.passed").map(proof), proof("work.completed")]);
check("proof-gated-completion", "completion-missing-verification-is-refused", missingVerification.item.completed === false
  && missingVerification.item.missingProofs.join() === "verification", missingVerification.item.missingProofs);
n = 0;
const full = project([...required.map(proof), proof("work.completed")]);
check("proof-gated-completion", "completion-with-every-required-proof-is-accepted", full.item.completed === true && full.issues.length === 0,
  "positive control; structural only, not signed deployment acceptance");
const unadmitted = wg.projectWorkGraph([...stored.filter((e) => e.workId === "work:codex-conflict"), { ...proof("work.completed"), workId: "work:codex-conflict", correlationId: "work:codex-conflict" }]);
check("proof-gated-completion", "reported-complete-or-unadmitted-work-cannot-complete",
  unadmitted.workItems[0].completed === false && unadmitted.issues.some((i) => i.code === "completion-gate-failed"));

process.stdout.write(JSON.stringify({ checks }));
