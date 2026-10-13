// Synthetic, deterministic inputs for the session-continuity lane. No private data:
// every transcript, goal and checkout is generated here from fixed text and fixed times.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const ORIGIN = "https://github.com/frankxai/continuity-eval-fixture.git";
export const BRANCH = "agent/claude/continuity-fixture";
export const OBSERVED_1 = "2026-10-04T20:00:00.000Z";
export const OBSERVED_2 = "2026-10-04T21:00:00.000Z";
const T = (minute) => `2026-10-04T19:${String(minute).padStart(2, "0")}:00.000Z`;
const MS = (iso) => Date.parse(iso);

// Every request carries this marker so a privacy check can grep for leaked text.
export const PROMPT_MARKER = "FIXTURE-REQUEST";

// One row per synthetic session. `expect` is what the collector at the pinned SHA must do.
export const SESSIONS = [
  { key: "claude-interactive", engine: "claude", id: "0a1b2c3d-0000-4000-8000-000000000001", entrypoint: "cli", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} ship the continuity fixture page`, bind: { reportedState: undefined },
    expect: { origin: "user-message", authority: "explicit-user-directive", event: true } },
  { key: "claude-headless", engine: "claude", id: "0a1b2c3d-0000-4000-8000-000000000002", entrypoint: "sdk-cli", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} headless print-mode run`, bind: {},
    expect: { origin: null, authority: "unresolved", event: false, issues: ["goal-unresolved"] } },
  { key: "claude-clipped", engine: "claude", id: "0a1b2c3d-0000-4000-8000-000000000003", entrypoint: "cli", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} ${"pasted context ".repeat(300)}`, bind: {},
    expect: { truncated: true, authority: "unresolved", event: false, issues: ["goal-unresolved"] } },
  { key: "codex-interactive", engine: "codex", id: "019a0000-0000-7000-8000-000000000004", originator: "codex-tui", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} finish the interactive codex lane`, bind: { reportedState: "active" },
    expect: { origin: "user-message", authority: "explicit-user-directive", event: true } },
  { key: "codex-exec", engine: "codex", id: "019a0000-0000-7000-8000-000000000005", originator: "codex_exec", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} codex exec automation`, bind: {},
    expect: { origin: "automation-message", authority: "unresolved", event: false, issues: ["goal-unresolved"] } },
  { key: "codex-partial", engine: "codex", id: "019a0000-0000-7000-8000-000000000006", originator: "codex-tui", where: "checkout", partial: true,
    prompt: `/goal ${PROMPT_MARKER} long campaign whose transcript is only sliced`, bind: {},
    native: { goalId: "goal-partial", objective: `${PROMPT_MARKER} long campaign recovered from the native store`, status: "paused" },
    expect: { partial: true, authority: "unresolved", event: true, eventAuthority: "native-goal-store", reportedState: "paused" } },
  { key: "codex-exec-native", engine: "codex", id: "019a0000-0000-7000-8000-000000000007", originator: "codex_exec", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} goal set by codex exec`, bind: {},
    native: { goalId: "goal-exec", objective: `${PROMPT_MARKER} goal set by codex exec`, status: "active" },
    expect: { authority: "unresolved", event: false, issues: ["native-goal-not-interactive", "goal-unresolved"] } },
  { key: "codex-conflict", engine: "codex", id: "019a0000-0000-7000-8000-000000000008", originator: "Codex Desktop", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} transcript says one thing`, bind: { reportedState: "active" },
    native: { goalId: "goal-conflict", objective: `${PROMPT_MARKER} native store says another`, status: "usage_limited" },
    expect: { authority: "explicit-user-directive", event: true, eventAuthority: "native-goal-store", reportedState: "blocked", issues: ["goal-conflict", "state-conflict"] } },
  { key: "codex-workspace", engine: "codex", id: "019a0000-0000-7000-8000-000000000009", originator: "codex-tui", where: "workspace",
    prompt: `/goal ${PROMPT_MARKER} work started outside any checkout`, bind: {},
    expect: { authority: "explicit-user-directive", event: false, issues: ["repository-unverified"] } },
  { key: "codex-unbound", engine: "codex", id: "019a0000-0000-7000-8000-00000000000a", originator: "codex-tui", where: "checkout",
    prompt: `/goal ${PROMPT_MARKER} nobody bound this session`, unbound: true,
    expect: { authority: "explicit-user-directive", event: false, unbound: true } },
];

export const workIdOf = (s) => `work:${s.key}`;
export const PROJECT = "project:continuity-eval";
export const OPERATOR = "actor:operator";
export const OWNER = "actor:owner";

export function gitEnv(sandbox) {
  // Isolate from the host's global and system Git config (hooks, autocrlf, fsmonitor),
  // and pin identity and dates so the fixture commit SHA is identical on every runner.
  const config = join(sandbox, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Continuity eval\n\temail = continuity-eval@example.invalid\n[init]\n\tdefaultBranch = main\n");
  return {
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Continuity eval", GIT_AUTHOR_EMAIL: "continuity-eval@example.invalid", GIT_AUTHOR_DATE: "2026-10-04T18:00:00Z",
    GIT_COMMITTER_NAME: "Continuity eval", GIT_COMMITTER_EMAIL: "continuity-eval@example.invalid", GIT_COMMITTER_DATE: "2026-10-04T18:00:00Z",
  };
}

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeCheckout(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", BRANCH]);
  git(dir, ["remote", "add", "origin", ORIGIN]);
  writeFileSync(join(dir, "README.md"), "# Continuity eval fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "Fixture revision"]);
  // Uncommitted work that recovery must leave byte-identical.
  writeFileSync(join(dir, "README.md"), "# Continuity eval fixture\n\nUnfinished edit that must survive recovery.\n");
  writeFileSync(join(dir, "draft.txt"), "untracked work in progress\n");
  return { root: dir, head: git(dir, ["rev-parse", "HEAD"]), branch: BRANCH, origin: ORIGIN };
}

export const dirtyFingerprint = (dir) => sha256([
  git(dir, ["status", "--porcelain=v1"]), git(dir, ["diff"]), readFileSync(join(dir, "draft.txt"), "utf8"), git(dir, ["rev-parse", "HEAD"]),
].join("\0"));

function writeLines(file, records, mtimeIso) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (mtimeIso) utimesSync(file, new Date(mtimeIso), new Date(mtimeIso));
  return file;
}

function claudeTranscript(home, s, cwd) {
  const base = { sessionId: s.id, cwd, gitBranch: BRANCH, entrypoint: s.entrypoint, version: "2.1.0" };
  return writeLines(join(home, ".claude", "projects", "continuity-eval", `${s.id}.jsonl`), [
    { ...base, type: "user", timestamp: T(10), uuid: `${s.id}-u1`, message: { role: "user", content: s.prompt } },
    { ...base, type: "assistant", timestamp: T(11), uuid: `${s.id}-a1`, message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] } },
  ]);
}

function codexRollout(home, s, cwd) {
  const records = [
    { timestamp: T(20), type: "session_meta", payload: { id: s.id, cwd, originator: s.originator, cli_version: "0.80.0", git: { branch: BRANCH } } },
  ];
  // A partial capture: older than the collector's full-parse window and larger than its
  // head+tail budget, so only bounded slices are read and the capture is flagged partial.
  if (s.partial) {
    const filler = "x".repeat(900);
    for (let i = 0; i < 1400; i++) records.push({ timestamp: T(21), type: "response_item", payload: { type: "reasoning", summary: [], note: filler } });
  }
  records.push({ timestamp: T(30), type: "event_msg", payload: { type: "user_message", message: s.prompt } });
  records.push({ timestamp: T(31), type: "event_msg", payload: { type: "agent_message", message: "Acknowledged." } });
  return writeLines(join(home, ".codex", "sessions", "2026", "10", "04", `rollout-2026-10-04T19-20-00-${s.id}.jsonl`), records,
    s.partial ? "2026-08-01T00:00:00.000Z" : undefined);
}

export function writeTranscripts(home, checkout, workspace) {
  for (const s of SESSIONS) {
    const cwd = s.where === "workspace" ? workspace : checkout;
    if (s.engine === "claude") claudeTranscript(home, s, cwd); else codexRollout(home, s, cwd);
  }
}

// Mirrors Codex's thread_goals table, including its status constraint.
export function writeGoalStore(file, rows = SESSIONS.filter((s) => s.native).map((s) => ({ thread: s.id, ...s.native }))) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`create table thread_goals (thread_id text primary key not null, goal_id text not null, objective text not null,
    status text not null check(status in ('active','paused','blocked','usage_limited','budget_limited','complete')),
    token_budget integer, tokens_used integer not null default 0, time_used_seconds integer not null default 0,
    created_at_ms integer not null, updated_at_ms integer not null)`);
  const insert = db.prepare("insert into thread_goals (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.thread, r.goalId, r.objective, r.status, MS("2026-10-04T18:30:00.000Z"), MS("2026-10-04T19:45:00.000Z"));
  db.close();
  return file;
}

// A single interactive rollout plus its paused native goal, for the end-to-end proof.
export function writeProofThread(dir) {
  const s = { id: "019a0000-0000-7000-8000-0000000000aa", originator: "codex-tui", prompt: `/goal ${PROMPT_MARKER} original campaign` };
  const rollout = codexRollout(dir, s, join(dir, "elsewhere"));
  const goals = writeGoalStore(join(dir, "goals_1.sqlite"), [{ thread: s.id, goalId: "goal-proof", objective: `${PROMPT_MARKER} original campaign`, status: "paused" }]);
  return { thread: s.id, rollout, goals };
}
