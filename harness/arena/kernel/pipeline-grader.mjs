// Deterministic grader for pipeline tests only (vendor "local"). It stands where a model reviewer
// from a different vendor than the contestant sits in a paid run, and approves a diff that adds a
// result bundle and nothing else. A receipt it signs proves the plumbing, never a contestant.
import { readFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const files = [...prompt.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
const ok = files.length > 0 && files.every((f) => f === 'results.json' || f === 'trials.jsonl');
console.log(JSON.stringify(ok
  ? { verdict: 'accept', findings: ['pipeline test: the diff adds only the result bundle'] }
  : { verdict: 'reject', findings: [`pipeline test: unexpected files ${files.join(', ') || '(none)'}`] }));
