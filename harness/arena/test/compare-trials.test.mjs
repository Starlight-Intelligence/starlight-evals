import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareTrials } from '../compare-trials.mjs';

const fixture = name => readFileSync(new URL('../dryrun/2026-10-22-mock-good/' + name + '/trials.jsonl', import.meta.url));
const left = fixture('claude-code'), right = fixture('codex');
function edit(bytes, change) {
  const rows = bytes.toString().trim().split('\n').map(line=>JSON.parse(line));
  return Buffer.from(change(rows).map(row=>JSON.stringify(row)).join('\n'));
}
test('replays shipped mock rows, preserving the mock and different fixture vendors', () => {
  const report = compareTrials(left, right);
  assert.equal(report.counts.bothPassed,2);
  assert.equal(report.differentFixtureVendors,true);
  assert.equal(report.pipelineTest,true);
  assert.equal(report.baseline.costPerPassUsd,null);
  assert.match(report.candidate.inputSha256,/^[a-f0-9]{64}$/);
});
test('canceling gains and regressions survive equal aggregate pass counts', () => {
  const failedAt = i => rows => rows.map((r,j)=>({...r,pass:i!==j}));
  const r = compareTrials(edit(left,failedAt(0)), edit(edit(right,failedAt(1)),rows=>rows.reverse()));
  assert.deepEqual(r.differences.map(d=>d.outcome),['gained','regressed']);
  assert.equal(r.baseline.passes,r.candidate.passes);
});
test('ungraded runs stay unresolved and missing spend stays unknown', () => {
  const live = rows => rows.map(r=>({...r,model:'unit-test',mock:null,costUsd:0.25}));
  const r=compareTrials(edit(left,live),edit(edit(right,live),rows=>rows.map((r,i)=>i?{...r,pass:null,costUsd:null}:r)));
  assert.equal(r.counts.unresolved,1);
  assert.equal(r.candidate.totalCostUsd,null);
  assert.equal(r.baseline.totalCostUsd,0.5);
});
test('spend from failed tasks counts toward cost per accepted task',()=>{
  const live=rows=>rows.map((r,i)=>({...r,model:'test',mock:null,costUsd:0.2,pass:i===0}));
  assert.equal(compareTrials(edit(left,live),edit(right,live)).candidate.costPerPassUsd,0.4);
});
test('rejects incomplete, duplicated, substituted and contaminated comparisons',()=>{
  for(const change of [
    rows=>rows.slice(1),rows=>[rows[0],rows[0]],rows=>rows.map(r=>({...r,task:r.task+'X'})),
    rows=>rows.map(r=>({...r,contractSha256:'a'.repeat(64)})),
    rows=>rows.map((r,i)=>i?{...r,model:'other'}:r),rows=>rows.map(r=>({...r,finished:'timeout',pass:true})),
    rows=>rows.map(r=>({...r,costUsd:-1})),rows=>rows.map(r=>({...r,mock:null})),
  ]) assert.throws(()=>compareTrials(left,edit(right,change)));
});

test('older exports keep missing optional fixture and version provenance unknown', () => {
  const legacy = edit(left, rows => rows.map(({fixtureVendor, harnessVersion, ...row}) => row));
  const result = compareTrials(legacy, right);
  assert.equal(result.baseline.harnessVersion, null);
  assert.equal(result.differentFixtureVendors, null);
});
