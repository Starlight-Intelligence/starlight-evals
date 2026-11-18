// Offline, descriptive comparison of two arena-trial.v0 exports from one run.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCli } from '../cli.mjs';
import { aggregate } from './lib.mjs';

const runFields = ['arenaId', 'pack', 'contractSha256', 'mock'];
const armFields = ['contestant', 'harness', 'harnessVersion', 'model', 'vendor', 'fixtureVendor'];
const requiredIdentity = ['contestant', 'harness', 'model', 'vendor'];
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function indexFile(bytes, label) {
  const rows = new Map();
  let first;
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const fail = message => { throw new Error(`${label} line ${index + 1}: ${message}`); };
    let row;
    try { row = JSON.parse(line); } catch { fail('invalid JSON'); }
    if (row?.schema !== 'arena-trial.v0' || !nonEmpty(row.arenaId) || !nonEmpty(row.pack)
        || !/^[a-f0-9]{64}$/.test(row.contractSha256) || ![null, 'good', 'bad', 'noop'].includes(row.mock)
        || !requiredIdentity.every(key => nonEmpty(row[key]))
        || !(row.harnessVersion == null || nonEmpty(row.harnessVersion))
        || !(row.fixtureVendor == null || nonEmpty(row.fixtureVendor))
        || !nonEmpty(row.task) || !nonEmpty(row.primaryMetric) || !Number.isSafeInteger(row.trial) || row.trial < 1) {
      fail('missing or invalid trial identity');
    }
    if (![true, false, null].includes(row.pass)
        || !['done', 'error', 'timeout', 'cap', 'max_steps', 'blocked'].includes(row.finished)
        || (row.pass === true && row.finished !== 'done')
        || !(row.costUsd === null || (Number.isFinite(row.costUsd) && row.costUsd >= 0))
        || !['provider','cli','pricing'].includes(row.costSource)
        || (row.model === 'mock' && row.mock === null)) fail('inconsistent outcome or accounting');
    // These metadata fields were optional in v0 exports. Keep missing provenance visible.
    row.harnessVersion ??= null;
    row.fixtureVendor ??= null;
    first ??= row;
    if (![...runFields, ...armFields].every(key => first[key] === row[key])) fail('mixed run or configuration');
    const key = JSON.stringify([row.task, row.trial]);
    if (rows.has(key)) fail('duplicate task and repetition');
    rows.set(key, row);
  }
  if (!first) throw new Error(label + ': empty trial file');
  return {first, rows, digest:createHash('sha256').update(bytes).digest('hex')};
}

function armSummary(arm) {
  const rows = [...arm.rows.values()];
  const {passes, graded, costUsd, costPerPassUsd} = aggregate(rows);
  const real = arm.first.mock === null;
  return {
    ...Object.fromEntries(armFields.map(key => [key, arm.first[key]])),
    inputSha256: arm.digest, attempted: rows.length, graded, passes,
    costSources: [...new Set(rows.map(row => row.costSource))].sort(),
    totalCostUsd: real ? costUsd : null, costPerPassUsd: real ? costPerPassUsd : null,
  };
}

export function compareTrials(baseBytes, candidateBytes) {
  const base = indexFile(baseBytes, 'baseline'), candidate = indexFile(candidateBytes, 'candidate');
  if (!runFields.every(key => base.first[key] === candidate.first[key])) throw new Error('different run, pack, contract or mock mode');
  if (base.first.contestant === candidate.first.contestant) throw new Error('expected two different contestants');
  if (base.rows.size !== candidate.rows.size) throw new Error('unpaired task sets');
  const counts = {bothPassed:0, bothFailed:0, gained:0, regressed:0, unresolved:0};
  const differences = [];
  for (const [key, left] of base.rows) {
    const right = candidate.rows.get(key);
    if (!right) throw new Error('unpaired task sets');
    if (left.primaryMetric !== right.primaryMetric || left.kind !== right.kind) throw new Error('task definitions differ');
    let outcome;
    if (left.pass === null || right.pass === null) outcome = 'unresolved';
    else if (left.pass !== right.pass) outcome = right.pass ? 'gained' : 'regressed';
    else outcome = left.pass ? 'bothPassed' : 'bothFailed';
    counts[outcome]++;
    if (outcome !== 'bothPassed') differences.push({task:left.task, trial:left.trial, outcome, baseline:left.pass, candidate:right.pass});
  }
  differences.sort((a,b) => a.task.localeCompare(b.task, 'en') || a.trial - b.trial);
  return {
    schema:'arena-paired-comparison.v1',
    ...Object.fromEntries(runFields.map(key => [key, base.first[key]])),
    pipelineTest: base.first.mock !== null,
    differentFixtureVendors: base.first.fixtureVendor && candidate.first.fixtureVendor
      ? base.first.fixtureVendor !== candidate.first.fixtureVendor : null,
    pairs: base.rows.size, counts, differences, baseline:armSummary(base), candidate:armSummary(candidate),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCli({usage:'node harness/arena/compare-trials.mjs --baseline FILE --candidate FILE', flags:{'--baseline':'value','--candidate':'value'}});
  if (!args['--baseline'] || !args['--candidate']) {
    console.error('Supply --baseline and --candidate trial files.'); process.exitCode = 2;
  } else {
    try {
      const result = compareTrials(readFileSync(args['--baseline']), readFileSync(args['--candidate']));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
