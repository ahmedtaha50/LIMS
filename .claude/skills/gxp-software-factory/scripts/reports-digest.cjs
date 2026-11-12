#!/usr/bin/env node
// Reads the track reports of a wave (report-<track>.json) and tells the lead what the gate has to do.
//
//   node reports-digest.cjs <dir-with-report-*.json> [--expect track-a,track-b] [--json] [--for-gate]
//
// Why: a report is long and arrives while other tracks still write; the lead should read a table, not five pages, and
// must not start the gate while a report is missing or a track is blocked. --for-gate prints the compact JSON to paste
// into the gate brief (the gate needs notDone, needsFromOtherTracks and decisionsForUser, not the prose).
// Exit code: 0 all expected reports present and none blocked; 2 a report is missing, unreadable, incomplete or blocked.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--expect') || '.');
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const expect = (opt('--expect') || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUIRED = ['track', 'status', 'done', 'notDone', 'filesChanged', 'testsAdded', 'testEvidence', 'decisionsForUser', 'needsFromOtherTracks'];
const STATUS = ['complete', 'partial', 'blocked'];

if (!fs.existsSync(dir)) { console.error(`reports-digest: ${dir} does not exist`); process.exit(2); }
const files = fs.readdirSync(dir).filter(f => /^report-.+\.json$/.test(f)).sort();
const reports = [], problems = [];
for (const f of files) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { problems.push(`${f}: not valid JSON (${e.message}); ask the track to rewrite it`); continue; }
  const missing = REQUIRED.filter(k => r[k] === undefined);
  if (missing.length) problems.push(`${f}: missing ${missing.join(', ')}`);
  if (r.status && !STATUS.includes(r.status)) problems.push(`${f}: status "${r.status}" is not one of ${STATUS.join(' | ')}`);
  if (r.track && f !== `report-${r.track}.json`) problems.push(`${f}: says track "${r.track}" (file name and track must agree)`);
  if (typeof r.testEvidence === 'string' && r.testEvidence.trim().length < 20) problems.push(`${f}: testEvidence is too short to be exact commands and totals`);
  if (r.status === 'complete' && Array.isArray(r.notDone) && r.notDone.length > 0) problems.push(`${f}: status is complete but notDone has ${r.notDone.length} item(s): read them; if an acceptance criterion is among them the track is partial`);
  reports.push({ file: f, ...r });
}
const have = new Set(reports.map(r => r.track));
const missingTracks = expect.filter(t => !have.has(t));
const blocked = reports.filter(r => r.status === 'blocked').map(r => r.track);
const partial = reports.filter(r => r.status === 'partial').map(r => r.track);
const arr = (x) => (Array.isArray(x) ? x : []);

const digest = {
  reports: reports.length, missing: missingTracks, blocked, partial, problems,
  tracks: reports.map(r => ({ track: r.track, status: r.status, done: arr(r.done).length, notDone: arr(r.notDone), needsFromOtherTracks: arr(r.needsFromOtherTracks), decisionsForUser: arr(r.decisionsForUser), testEvidence: r.testEvidence || '', filesChanged: arr(r.filesChanged).length, testsAdded: arr(r.testsAdded) })),
};
const ready = !missingTracks.length && !blocked.length && !problems.some(p => /not valid JSON|missing /.test(p));

if (argv.includes('--for-gate')) {
  console.log(JSON.stringify(digest.tracks.map(t => ({ track: t.track, status: t.status, notDone: t.notDone, needsFromOtherTracks: t.needsFromOtherTracks, decisionsForUser: t.decisionsForUser, testEvidence: t.testEvidence, testsAdded: t.testsAdded }))));
  process.exit(ready ? 0 : 2);
}
if (argv.includes('--json')) { console.log(JSON.stringify({ ready, ...digest }, null, 2)); process.exit(ready ? 0 : 2); }

const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
console.log(`${reports.length} report(s) in ${dir}${expect.length ? `, ${expect.length} expected` : ''}`);
console.log('\n  track'.padEnd(34) + 'status'.padEnd(10) + 'done  notDone  needs  decisions  tests');
for (const t of digest.tracks) console.log('  ' + String(t.track).padEnd(31) + String(t.status).padEnd(10) + String(t.done).padStart(4) + String(t.notDone.length).padStart(9) + String(t.needsFromOtherTracks.length).padStart(7) + String(t.decisionsForUser.length).padStart(11) + String(t.testsAdded.length).padStart(7));
const section = (title, pick) => {
  const rows = digest.tracks.flatMap(t => pick(t).map(x => [t.track, x]));
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const [track, x] of rows) console.log(`  [${track}] ${cut(x, 300)}`);
};
section('NOT DONE: say these to the user, do not let them disappear', t => t.notDone);
section('FOR THE GATE: needs from other tracks (shared files, counters, derived files)', t => t.needsFromOtherTracks);
section('DECISIONS FOR THE USER: conservative defaults that a person must confirm', t => t.decisionsForUser);
if (problems.length) { console.log(`\nPROBLEMS (${problems.length})`); for (const p of problems) console.log('  ! ' + p); }
if (missingTracks.length) console.log(`\nMISSING REPORTS: ${missingTracks.join(', ')}. Do not start the gate: the track is still writing, or died (resume it with the same agent id).`);
if (blocked.length) console.log(`\nBLOCKED: ${blocked.join(', ')}. Read the report and unblock it or take the track out of the wave before the gate.`);
console.log(ready ? `\nReady for the gate${partial.length ? ` (partial: ${partial.join(', ')}: the gate brief must carry their notDone)` : ''}.` : '\nNOT ready for the gate.');
process.exit(ready ? 0 : 2);
