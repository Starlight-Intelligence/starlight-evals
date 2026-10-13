// The scorecard and the run log are published (CI artifact, Actions log). This test runs
// the lane and asserts neither carries host paths, temp dirs, the user or host name, or
// error/stack text. It runs with the collector leg when AGENTIC_OPS_TOKEN is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (v) => new RegExp(`(^|[^A-Za-z0-9])${escape(v)}([^A-Za-z0-9]|$)`, "i");

// Fixed public text (pinned repo names, the lane's prose) may legitimately share a word with
// a host name, e.g. a machine called "Starlight". Identity checks run on everything else.
const PINS = JSON.parse(readFileSync(join(ROOT, "harness", "continuity", "pins.json"), "utf8")).repositories;
const PUBLIC_NAMES = [...new Set([...Object.values(PINS).map((p) => p.repo), "starlight-evals"])];
const withoutPublicText = (text, prose = []) => [...PUBLIC_NAMES, ...prose].reduce((t, v) => t.split(v).join(" "), text);

function assertNoHostData(text, label, prose = []) {
  const identityText = withoutPublicText(text, prose);
  assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]/, `${label}: Windows drive path`);
  assert.doesNotMatch(text, /(^|[^A-Za-z0-9.])\/(home|Users|tmp|var|private|root|runner)\//, `${label}: POSIX home or temp path`);
  assert.doesNotMatch(text, /\\\\?Users\\\\?/, `${label}: Windows user directory`);
  for (const dir of [tmpdir(), homedir(), ROOT]) {
    assert.ok(!text.toLowerCase().includes(dir.toLowerCase()) && !text.toLowerCase().includes(dir.replace(/\\/g, "/").toLowerCase()), `${label}: contains a host directory`);
  }
  const user = userInfo().username;
  if (user.length >= 3) assert.doesNotMatch(identityText, word(user), `${label}: contains the user name`);
  if (hostname().length >= 3) assert.doesNotMatch(identityText, word(hostname()), `${label}: contains the host name`);
  assert.doesNotMatch(text, /\bError:|\n\s+at\s|node:internal/, `${label}: error or stack text`);
}

test("scorecard and run log carry no host paths, identity or error text", () => {
  // Write into the repo's ignored out/ directory so the temp-dir check stays meaningful.
  mkdirSync(join(ROOT, "out"), { recursive: true });
  const out = mkdtempSync(join(ROOT, "out", "privacy-test-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "harness", "session-continuity.mjs"), "--out", out],
      { cwd: ROOT, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    const files = readdirSync(out).filter((f) => f.startsWith("session-continuity-") && f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one scorecard");
    const text = readFileSync(join(out, files[0]), "utf8");
    const scorecard = JSON.parse(text);
    assertNoHostData(text, "scorecard", [...scorecard.proves, ...scorecard.doesNotProve].map((p) => JSON.stringify(p).slice(1, -1)));
    assertNoHostData(r.stdout + r.stderr, "run log");
    assert.equal(scorecard.checks.find((c) => c.id === "scorecard-free-of-host-identifiers")?.ok, true);
    assert.notEqual(scorecard.verdict, "FAIL");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
