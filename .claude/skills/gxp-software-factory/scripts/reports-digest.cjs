#!/usr/bin/env node
// Reads the track reports of a wave (report-<track>.json) and tells the lead whether the gate may start.
//
//   node reports-digest.cjs <dir-with-report-*.json> [--expect track-a,track-b] [--roadmap <file>] [--repo .] [--json] [--for-gate]
//
// Why: a report is long and arrives while other tracks still write; the lead should read a table, not five pages, and
// must not start the gate while a report is missing, a track is blocked, or a track says "complete" without showing it.
//
// With --roadmap the report is held against the plan (the acceptance ledger):
//   every acceptance criterion of the track's gaps must be answered in report.acceptance as
//   { "gap": "M03", "n": 1, "status": "met" | "partly" | "not-met", "evidence": "tests/api/esign.test.ts :: wrong password" };
//   "met" needs evidence (with --repo the named file must exist); status "complete" needs every criterion met.
// --for-gate prints the compact JSON to paste into the gate brief.
// Exit code: 0 ready for the gate; 2 not ready (a report missing, unreadable, incomplete, blocked, or contradicting the plan).
const fs = require('fs');
const path = require('path');
const { args, loadRoadmap } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;

  const { flag, opt, positional } = args(argv, ['--expect', '--roadmap', '--repo']);
  const dir = path.resolve(positional[0] || '.');
  const expect = (opt('--expect', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const repo = opt('--repo') ? path.resolve(opt('--repo')) : null;
  const REQUIRED = ['track', 'status', 'done', 'notDone', 'filesChanged', 'testsAdded', 'testEvidence', 'decisionsForUser', 'needsFromOtherTracks'];
  const STATUS = ['complete', 'partial', 'blocked'];
  const LEDGER = ['met', 'partly', 'not-met'];

  if (!fs.existsSync(dir)) { console.error(`reports-digest: ${dir} does not exist`); io.exit(2); }
  let road = null;
  if (opt('--roadmap')) {
    const rf = path.resolve(opt('--roadmap'));
    if (!fs.existsSync(rf)) { console.error(`reports-digest: roadmap ${rf} not found`); io.exit(2); }
    road = loadRoadmap(rf);
  }
  const files = fs.readdirSync(dir).filter(f => /^report-.+\.json$/.test(f)).sort();
  const reports = [], blocking = [], warnings = [];
  const arr = (x) => (Array.isArray(x) ? x : []);
  const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  for (const f of files) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { blocking.push(`${f}: not valid JSON (${e.message}); ask the track to rewrite it`); continue; }
    const missing = REQUIRED.filter(k => r[k] === undefined);
    if (missing.length) blocking.push(`${f}: missing field(s) ${missing.join(', ')}`);
    if (r.status && !STATUS.includes(r.status)) blocking.push(`${f}: status "${r.status}" is not one of ${STATUS.join(' | ')}`);
    if (r.track && f !== `report-${r.track}.json`) blocking.push(`${f}: says track "${r.track}" (file name and track must agree)`);
    if (typeof r.testEvidence === 'string' && r.testEvidence.trim().length < 20) warnings.push(`${f}: testEvidence is too short to be exact commands and totals`);
    if (r.status === 'complete' && arr(r.notDone).length) warnings.push(`${f}: status is complete but notDone has ${arr(r.notDone).length} item(s): read them; an unmet acceptance criterion makes the track partial`);

    // the acceptance ledger against the plan
    const unmet = [];
    if (road && r.track) {
      const t = road.byName.get(r.track);
      if (!t) blocking.push(`${f}: track "${r.track}" is not in the roadmap`);
      else {
        const ledger = Array.isArray(r.acceptance) ? r.acceptance : null;
        const criteria = t.gapIds.flatMap(g => arr((road.gapById.get(g) || {}).acceptance).map((text, i) => ({ gap: g, n: i + 1, text })));
        if (!ledger && criteria.length) blocking.push(`${f}: no acceptance ledger (report.acceptance): ${criteria.length} acceptance criteria of ${t.gapIds.join(', ')} are unanswered`);
        for (const c of (ledger ? criteria : [])) {
          const e = ledger.find(x => x && x.gap === c.gap && Number(x.n) === c.n);
          const id = `${c.gap}#${c.n}`;
          if (!e) { blocking.push(`${f}: acceptance ${id} not answered: "${cut(c.text, 110)}"`); continue; }
          if (!LEDGER.includes(e.status)) { blocking.push(`${f}: acceptance ${id} has status "${e.status}" (use ${LEDGER.join(' | ')})`); continue; }
          if (e.status !== 'met') { unmet.push(`${id} ${e.status}: ${cut(c.text, 110)}`); continue; }
          const ev = String(e.evidence || '').trim();
          if (!ev) { blocking.push(`${f}: acceptance ${id} is "met" without evidence (name the test: file :: title)`); continue; }
          const evFile = ev.split('::')[0].trim().split(/\s+/)[0];
          if (repo && /[/.]/.test(evFile) && !fs.existsSync(path.join(repo, evFile))) blocking.push(`${f}: acceptance ${id} names evidence that does not exist: ${evFile}`);
        }
        for (const e of arr(ledger)) if (e && !criteria.some(c => c.gap === e.gap && c.n === Number(e.n))) warnings.push(`${f}: acceptance entry ${e.gap}#${e.n} matches no criterion of the roadmap`);
        if (r.status === 'complete' && unmet.length) blocking.push(`${f}: status is "complete" but ${unmet.length} acceptance criteri${unmet.length === 1 ? 'on is' : 'a are'} not met: the track is partial`);
      }
    }
    reports.push({ file: f, unmet, ...r });
  }
  const have = new Set(reports.map(r => r.track));
  const missingTracks = expect.filter(t => !have.has(t));
  const blocked = reports.filter(r => r.status === 'blocked').map(r => r.track);
  const partial = reports.filter(r => r.status === 'partial').map(r => r.track);
  const tracks = reports.map(r => ({ track: r.track, status: r.status, done: arr(r.done).length, notDone: arr(r.notDone), unmetAcceptance: r.unmet, needsFromOtherTracks: arr(r.needsFromOtherTracks), decisionsForUser: arr(r.decisionsForUser), testEvidence: r.testEvidence || '', filesChanged: arr(r.filesChanged).length, testsAdded: arr(r.testsAdded) }));
  const ready = !missingTracks.length && !blocked.length && !blocking.length;

  if (flag('--for-gate')) {
    console.log(JSON.stringify(tracks.map(t => ({ track: t.track, status: t.status, notDone: t.notDone, unmetAcceptance: t.unmetAcceptance, needsFromOtherTracks: t.needsFromOtherTracks, decisionsForUser: t.decisionsForUser, testEvidence: t.testEvidence, testsAdded: t.testsAdded }))));
    io.exit(ready ? 0 : 2);
  }
  if (flag('--json')) { console.log(JSON.stringify({ ready, reports: reports.length, missing: missingTracks, blocked, partial, blocking, warnings, tracks }, null, 2)); io.exit(ready ? 0 : 2); }

  console.log(`${reports.length} report(s) in ${dir}${expect.length ? `, ${expect.length} expected` : ''}${road ? ', held against the roadmap' : ' (no --roadmap: acceptance criteria not checked)'}`);
  console.log('\n  track'.padEnd(34) + 'status'.padEnd(10) + 'done  notDone  unmet  needs  decisions  tests');
  for (const t of tracks) console.log('  ' + String(t.track).padEnd(31) + String(t.status).padEnd(10) + String(t.done).padStart(4) + String(t.notDone.length).padStart(9) + String(t.unmetAcceptance.length).padStart(7) + String(t.needsFromOtherTracks.length).padStart(7) + String(t.decisionsForUser.length).padStart(11) + String(t.testsAdded.length).padStart(7));
  const section = (title, pick) => {
    const rows = tracks.flatMap(t => pick(t).map(x => [t.track, x]));
    if (!rows.length) return;
    console.log(`\n${title} (${rows.length})`);
    for (const [track, x] of rows) console.log(`  [${track}] ${cut(x, 300)}`);
  };
  section('ACCEPTANCE NOT MET: the plan asked for these; they go to the user and into the open-items register', t => t.unmetAcceptance);
  section('NOT DONE: say these to the user, do not let them disappear', t => t.notDone);
  section('FOR THE GATE: needs from other tracks (shared files, counters, derived files)', t => t.needsFromOtherTracks);
  section('DECISIONS FOR THE USER: conservative defaults that a person must confirm', t => t.decisionsForUser);
  if (blocking.length) { console.log(`\nBLOCKING (${blocking.length})`); for (const p of blocking) console.log('  X ' + p); }
  if (warnings.length) { console.log(`\nWARNINGS (${warnings.length})`); for (const p of warnings) console.log('  ! ' + p); }
  if (missingTracks.length) console.log(`\nMISSING REPORTS: ${missingTracks.join(', ')}. Do not start the gate: the track is still writing, or died (resume it with the same agent id).`);
  if (blocked.length) console.log(`\nBLOCKED: ${blocked.join(', ')}. Read the report and unblock it or take the track out of the wave before the gate.`);
  console.log(ready ? `\nReady for the gate${partial.length ? ` (partial: ${partial.join(', ')}: the gate brief must carry their notDone and unmet acceptance)` : ''}.` : '\nNOT ready for the gate.');
  io.exit(ready ? 0 : 2);
}

module.exports = { main };
if (require.main === module) cli(main);
