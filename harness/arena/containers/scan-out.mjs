// Last check before a contestant bundle leaves its container: no file under the output directory
// may contain the value of any credential this image was given (ARENA_CRED_NAMES). Exit 1 names
// the file and the credential, never the value.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const names = String(process.env.ARENA_CRED_NAMES || '').split(/\s+/).filter(Boolean);
const values = names.map((n) => [n, process.env[n]]).filter(([, v]) => v && v.length >= 8);
const hits = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else { const text = readFileSync(p, 'utf8'); for (const [n, v] of values) if (text.includes(v)) hits.push(`${path.relative(root, p)}: ${n}`); }
  }
};
walk(root);
if (hits.length) { console.error(`credential found in output, upload refused:\n  ${hits.join('\n  ')}`); process.exit(1); }
