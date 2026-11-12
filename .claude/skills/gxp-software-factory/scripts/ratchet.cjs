#!/usr/bin/env node
// A ratchet for known debt: a baseline that may shrink and never grow.
//
//   <tool that prints one finding per line> | node ratchet.cjs --baseline debt.json [--strict-stale] [--name "type errors"]
//   node ratchet.cjs --baseline debt.json --current findings.json        (a JSON array of strings, or of { key, count })
//   node ratchet.cjs --baseline debt.json --update [--reason "..."]      rewrite the baseline from the current findings
//
// Use it when a check cannot be clean on day one (type errors, accessibility violations, lint findings, known-failing
// browser checks) but must not get worse. It fails on anything that is not in the baseline. With --strict-stale it also
// fails when a baseline entry no longer occurs, so the list has to be shrunk in the same change that fixed it and a
// "known" problem cannot quietly return later under the old entry. Tie each entry to an open deviation or ticket.
//
// A finding is keyed by its text. Make the key stable: file + rule + message, never a line number.
// --update refuses to add entries unless --allow-grow is given with --reason: growing the baseline to get a change
// through is exactly what a ratchet exists to stop.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const baselineFile = opt('--baseline');
const name = opt('--name') || 'findings';
if (!baselineFile) { console.error('usage: ... | node ratchet.cjs --baseline <file.json> [--current <file.json>] [--strict-stale] [--update [--allow-grow --reason "..."]] [--name <what>]'); process.exit(2); }

function readCurrent() {
  const add = (m, k, n = 1) => { const key = String(k).trim(); if (key) m.set(key, (m.get(key) || 0) + n); };
  const m = new Map();
  const cur = opt('--current');
  if (cur) {
    const j = JSON.parse(fs.readFileSync(cur, 'utf8'));
    for (const x of (Array.isArray(j) ? j : j.entries || j.findings || [])) { if (typeof x === 'string') add(m, x); else add(m, x.key, x.count || 1); }
  } else {
    for (const line of fs.readFileSync(0, 'utf8').split(/\r?\n/)) add(m, line);
  }
  return m;
}
const current = readCurrent();
let baseline = { entries: [] };
if (fs.existsSync(baselineFile)) {
  try { baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch (e) { console.error(`ratchet: cannot read ${baselineFile}: ${e.message}`); process.exit(2); }
} else if (!flag('--update')) { console.error(`ratchet: ${baselineFile} does not exist; create it with --update --allow-grow --reason "first baseline"`); process.exit(2); }
const allowed = new Map((baseline.entries || []).map(e => [e.key, e.count || 1]));

const fresh = [...current].filter(([k, n]) => n > (allowed.get(k) || 0));
const stale = [...allowed].filter(([k, n]) => (current.get(k) || 0) < n);

if (flag('--update')) {
  if (fresh.length && !flag('--allow-grow')) {
    console.error(`ratchet: refusing to add ${fresh.length} new ${name} to the baseline. Fix them, or pass --allow-grow --reason "..." if a person decided to accept them.`);
    for (const [k] of fresh.slice(0, 20)) console.error('  + ' + k);
    process.exit(1);
  }
  if (fresh.length && !opt('--reason')) { console.error('ratchet: --allow-grow needs --reason "<who decided and why>"'); process.exit(2); }
  const old = new Map((baseline.entries || []).map(e => [e.key, e]));
  const entries = [...current].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, count]) => ({ ...(old.get(key) || {}), key, count }));
  const history = [...(baseline.history || [])];
  if (fresh.length) history.push({ grew: fresh.length, reason: opt('--reason'), at: new Date().toISOString().slice(0, 10) });
  fs.mkdirSync(path.dirname(path.resolve(baselineFile)), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({ comment: baseline.comment || `Known ${name}. This list may shrink and must not grow; each entry should name an open deviation or ticket.`, entries, history }, null, 2) + '\n');
  console.log(`ratchet: baseline written, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${stale.length} removed, ${fresh.length} added).`);
  process.exit(0);
}

let bad = false;
if (fresh.length) {
  bad = true;
  console.error(`${fresh.length} NEW ${name} (not in ${path.basename(baselineFile)}):`);
  for (const [k, n] of fresh.slice(0, 50)) console.error(`  + ${k}${n > 1 ? `  (x${n}, baseline ${allowed.get(k) || 0})` : ''}`);
  console.error('Fix them. The baseline is for what existed before this check; it must not grow.');
}
if (stale.length) {
  const line = `${stale.length} baseline entr${stale.length === 1 ? 'y no longer occurs' : 'ies no longer occur'}: shrink the baseline (node ratchet.cjs --baseline ${baselineFile} --update).`;
  if (flag('--strict-stale')) { bad = true; console.error(line); for (const [k] of stale.slice(0, 50)) console.error('  - ' + k); }
  else console.log(line);
}
if (!bad) console.log(`ratchet OK: ${[...current.values()].reduce((a, b) => a + b, 0)} known ${name}, none new.`);
process.exit(bad ? 1 : 0);
