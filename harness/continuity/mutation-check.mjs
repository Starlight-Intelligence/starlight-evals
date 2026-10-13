#!/usr/bin/env node
// Proves the lane can fail: runs it once per deliberate regression in mutations.json and
// exits nonzero if any mutated run still reaches PASS or PARTIAL. Collector mutations need
// AGENTIC_OPS_TOKEN; without it they are reported as not run, never as caught.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = join(ROOT, "out");
const catalog = JSON.parse(readFileSync(join(HERE, "mutations.json"), "utf8"));
const mutations = Object.keys(catalog).filter((k) => !k.startsWith("$"));
const collector = Boolean(process.env.AGENTIC_OPS_TOKEN);
const needsCollector = (name) => catalog[name].some((e) => e.file.startsWith("agentic-ops/"));

const results = [];
for (const name of mutations) {
  if (needsCollector(name) && !collector) { results.push({ mutation: name, outcome: "not-run", reason: "collector mutation without AGENTIC_OPS_TOKEN" }); continue; }
  const r = spawnSync(process.execPath, [join(ROOT, "harness", "session-continuity.mjs"), "--mutation", name, "--out", OUT],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const verdict = (/lane v0\.1 — (\w+)/.exec(r.stdout) || [])[1] ?? "CRASHED";
  const failedChecks = [...r.stdout.matchAll(/FAILED (\S+):/g)].map((m) => m[1]);
  results.push({ mutation: name, outcome: verdict === "FAIL" && failedChecks.length > 0 ? "caught" : "survived", verdict, failedChecks });
  console.log(`${verdict === "FAIL" ? "caught  " : "SURVIVED"} ${name} — ${failedChecks.length} failing check(s)`);
}
const survived = results.filter((r) => r.outcome === "survived");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "session-continuity-mutation-check.json"), JSON.stringify({ schema: "starlight-evals.session-continuity-mutation-check.v1",
  generatedAt: new Date().toISOString(), caught: results.filter((r) => r.outcome === "caught").length, survived: survived.length,
  notRun: results.filter((r) => r.outcome === "not-run").length, results }, null, 2) + "\n");
for (const r of results.filter((x) => x.outcome === "not-run")) console.log(`not run  ${r.mutation} (${r.reason})`);
console.log(`${results.length - survived.length - results.filter((r) => r.outcome === "not-run").length}/${results.length} mutations caught, ${survived.length} survived.`);
process.exitCode = survived.length ? 1 : 0;
