import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { gradeOutput } from './grade.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// minimal graphInfo stub
const graphInfo = {
  set: new Set(['superpowers', 'deepresearch', 'source-backed-research', 'impeccable', 'web-design-guidelines', 'acos-meta', 'content-strategy'])
};

test('known-good routing passes', () => {
  const c = { id: 'case-01', input: 'hi', expect: { classification: 'question', loads: [], refuses: [] } };
  const out = { loads: [], askedClarification: false };
  const res = gradeOutput(out, c, graphInfo);
  assert.equal(res.pass, true);
  assert.deepEqual(res.hardFailures, []);
});

test('refused skill fails with correct code', () => {
  const c = { id: 'case-x', input: 'test', expect: { loads: [], refuses: ['superpowers'] } };
  const out = { loads: ['superpowers'] };
  const res = gradeOutput(out, c, graphInfo);
  assert.equal(res.pass, false);
  assert.ok(res.hardFailures.includes('no-refused-slug'));
});

test('nonexistent slug fails with nonexistent-skill', () => {
  const c = { id: 'case-y', input: 'test', expect: { loads: [], refuses: [] } };
  const out = { loads: ['totally-made-up-skill'] };
  const res = gradeOutput(out, c, graphInfo);
  assert.equal(res.pass, false);
  assert.ok(res.hardFailures.includes('nonexistent-skill'));
});
