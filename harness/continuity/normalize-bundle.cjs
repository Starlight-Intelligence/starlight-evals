'use strict';
// Replaces the per-run sandbox path in a collector bundle with "/sandbox" and re-seals it
// with the pinned collector's own writer, so recorded bundles are identical on every runner.
const fs = require('node:fs');
const path = require('node:path');

const [lifecycle, sandbox, outDir, ...bundles] = process.argv.slice(2);
const { verifyContinuityBundle, writeContinuityBundle } = require(path.join(lifecycle, 'sis-continuity.js'));

const real = fs.realpathSync(sandbox);
const prefixes = [...new Set([sandbox, real].flatMap(p => [p, p.replace(/\\/g, '/')]))].sort((a, b) => b.length - a.length);
const normalize = value => {
    if (typeof value === 'string') {
        for (const prefix of prefixes) {
            const at = process.platform === 'win32' ? value.toLowerCase().indexOf(prefix.toLowerCase()) : value.indexOf(prefix);
            if (at === 0) return '/sandbox' + value.slice(prefix.length).replace(/\\/g, '/');
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
};

fs.mkdirSync(outDir, { recursive: true });
bundles.forEach((dir, index) => {
    writeContinuityBundle(normalize(verifyContinuityBundle(dir)), path.join(outDir, `bundle-${index + 1}`));
});
