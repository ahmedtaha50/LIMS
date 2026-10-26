// Type-checks the server project (tsconfig.server.json: strictNullChecks on) and compares the result with a baseline of
// the errors that were already there when the check was introduced. Only NEW errors fail; fixing old ones is welcome.
//
// Why: without strictNullChecks, TypeScript could not tell Drizzle's row types apart, so r.expirationDate (the column is
// expiryDate) and r.isOOS (the column is isOos) compiled for months and silently produced zero counts.
//
//   node scripts/typecheck-server.cjs                 check (exit 1 on a new error)
//   node scripts/typecheck-server.cjs --update        rewrite the baseline from the current state (review the diff!)
//   options: --project <tsconfig>  --baseline <file>
//
// An entry is keyed by file + error code + message with object-type bodies collapsed, never by line number, so ordinary
// edits do not move it, and it carries a count, so a second identical error in the same file is still a new error.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const project = path.resolve(root, arg('--project', 'tsconfig.server.json'));
const baselineFile = path.resolve(root, arg('--baseline', path.join('scripts', 'dev', 'typecheck', 'baseline.json')));
const update = process.argv.includes('--update');

const tscJs = require.resolve('typescript/lib/tsc.js', { paths: [root] });
const tscVersion = require(path.join(path.dirname(tscJs), '..', 'package.json')).version;

const run = spawnSync(process.execPath, [tscJs, '-p', project, '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const output = (run.stdout || '') + (run.stderr || '');
const DIAG = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const collapse = (m) => { let s = m, prev; do { prev = s; s = s.replace(/\{[^{}]*\}/g, '{…}'); } while (s !== prev); return s.length > 240 ? s.slice(0, 240) + '…' : s; };

const diagnostics = [];
for (const line of output.split(/\r?\n/)) {
  const m = DIAG.exec(line);
  if (m) diagnostics.push({ file: path.relative(root, path.resolve(root, m[1])).split(path.sep).join('/'), line: Number(m[2]), code: m[4], message: collapse(m[5]), text: line });
}
if (!diagnostics.length && run.status !== 0) {
  console.error(output.trim() || `tsc exited with ${run.status}`);
  console.error('tsc failed without reporting a diagnostic (configuration error?).');
  process.exit(1);
}

const keyOf = (d) => `${d.file}\u0000${d.code}\u0000${d.message}`;
const current = new Map();
for (const d of diagnostics) current.set(keyOf(d), (current.get(keyOf(d)) || 0) + 1);

if (update) {
  const errors = [...current].map(([k, count]) => { const [file, code, message] = k.split('\u0000'); return { file, code, message, count }; })
    .sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({
    description: 'Known type errors of tsconfig.server.json. Only new errors fail "npm run lint:server". Shrink this file when you fix one (node scripts/typecheck-server.cjs --update); never add to it to get a change through.',
    typescript: tscVersion,
    errors,
  }, null, 2) + '\n');
  console.log(`Baseline written: ${errors.length} entries, ${diagnostics.length} errors (${path.relative(root, baselineFile)}).`);
  process.exit(0);
}

let baseline = { errors: [] };
try { baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch (e) { console.error(`Cannot read baseline ${baselineFile}: ${e.message}`); process.exit(1); }
if (baseline.typescript && baseline.typescript !== tscVersion) console.warn(`Note: baseline was recorded with TypeScript ${baseline.typescript}, this is ${tscVersion}; messages may differ.`);
const allowed = new Map(baseline.errors.map(e => [`${e.file}\u0000${e.code}\u0000${e.message}`, e.count]));

const fresh = [...current].filter(([k, n]) => n > (allowed.get(k) || 0)).map(([k]) => k);
if (fresh.length) {
  console.error(`\n${fresh.length} NEW type error kind(s) in the server project (strictNullChecks):\n`);
  for (const d of diagnostics) if (fresh.includes(keyOf(d))) console.error('  ' + d.text);
  console.error('\nFix them. The baseline (scripts/dev/typecheck/baseline.json) is for errors that existed before this check; it must not grow.');
  process.exit(1);
}

const fixed = [...allowed].filter(([k, n]) => (current.get(k) || 0) < n).length;
console.log(`Server type check passed: ${diagnostics.length} known error(s) in the baseline, none new.`);
if (fixed) console.log(`${fixed} baseline entr${fixed === 1 ? 'y no longer occurs' : 'ies no longer occur'} (fixed). Shrink the baseline: node scripts/typecheck-server.cjs --update`);
