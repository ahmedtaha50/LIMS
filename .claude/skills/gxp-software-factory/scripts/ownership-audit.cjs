#!/usr/bin/env node
// Did every track stay inside the files the plan gave it?
//
//   node ownership-audit.cjs --tracks track-a,track-b [--repo .] [--roadmap <file>] [--base HEAD] [--allow "glob,glob"] [--json]
//
// Run it when the tracks of a wave have reported and BEFORE the gate applies patches (the gate may edit any file; tracks may not).
// It compares the files that changed since --base (default HEAD: the uncommitted work of the wave) with ownsFiles:
//   OK         the file belongs to exactly one track of the wave, or is that track's change record / gate patch
//   FOREIGN    it belongs to a track that is not in this wave: somebody edited another track's file
//   CONTESTED  two tracks of the wave both own it: the roadmap is wrong (roadmap-lint should have refused it)
//   UNOWNED    no track owns it: a shared file edited directly instead of through a gate patch, or a new file outside the patterns
// It also fails when a track changed nothing or wrote no change record. Exit 1 on any finding.
// Why: prose in a brief ("edit only your files") is a request; this is the check. One line edited in a shared file by two tracks
// is how a wave loses an afternoon at the gate.
const path = require('path');
const fs = require('fs');
const { args, loadConfig, loadRoadmap, matcher, isGit, changedFiles } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;

  const { flag, opt } = args(argv, ['--tracks', '--repo', '--roadmap', '--base', '--allow', '--changes-dir']);
  const repo = path.resolve(opt('--repo', '.'));
  const cfg = loadConfig(repo);
  const roadmapFile = path.resolve(repo, opt('--roadmap', cfg.ROADMAP));
  const changesDir = opt('--changes-dir', cfg.CHANGES_DIR).replace(/\/$/, '');
  const wave = (opt('--tracks', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!wave.length) { console.error('usage: node ownership-audit.cjs --tracks a,b [--repo .] [--roadmap file] [--base HEAD] [--allow globs]'); io.exit(2); }
  if (!isGit(repo)) { console.error(`ownership-audit: ${repo} is not a git repository`); io.exit(2); }
  if (!fs.existsSync(roadmapFile)) { console.error(`ownership-audit: roadmap ${roadmapFile} not found`); io.exit(2); }
  const road = loadRoadmap(roadmapFile);
  const unknown = wave.filter(t => !road.byName.has(t));
  if (unknown.length) { console.error(`ownership-audit: not in the roadmap: ${unknown.join(', ')}`); io.exit(2); }

  const owners = road.tracks.map(t => ({ track: t.track, owns: matcher(t.ownsFiles) }));
  const extra = matcher((opt('--allow', '') || '').split(',').map(s => s.trim()).filter(Boolean));
  const record = (f) => wave.find(t => f === `${changesDir}/${t}.md` || f === `${changesDir}/${t}.gate.patch`);
  const files = changedFiles(repo, opt('--base', 'HEAD'));

  const rows = [], perTrack = new Map(wave.map(t => [t, { files: 0, record: false }]));
  for (const f of files) {
    const rec = record(f);
    if (rec) { perTrack.get(rec).record = perTrack.get(rec).record || f.endsWith('.md'); rows.push({ file: f, status: 'OK', track: rec, why: 'change record or gate patch' }); continue; }
    const own = owners.filter(o => o.owns(f)).map(o => o.track);
    const inWave = own.filter(t => wave.includes(t));
    if (inWave.length === 1) { perTrack.get(inWave[0]).files++; rows.push({ file: f, status: 'OK', track: inWave[0] }); }
    else if (inWave.length > 1) rows.push({ file: f, status: 'CONTESTED', track: inWave.join(' + '), why: 'two tracks of this wave own it' });
    else if (extra(f)) rows.push({ file: f, status: 'OK', track: '(allowed)', why: '--allow' });
    else if (own.length) rows.push({ file: f, status: 'FOREIGN', track: own.join(', '), why: 'owned by a track that is not in this wave' });
    else rows.push({ file: f, status: 'UNOWNED', track: '', why: 'no track owns it: shared file (use a gate patch) or a new file outside ownsFiles' });
  }
  const findings = rows.filter(r => r.status !== 'OK');
  const idle = wave.filter(t => perTrack.get(t).files === 0);
  const noRecord = wave.filter(t => !perTrack.get(t).record && !fs.existsSync(path.join(repo, changesDir, `${t}.md`)));
  const bad = findings.length || idle.length || noRecord.length;

  if (flag('--json')) { console.log(JSON.stringify({ ok: !bad, changed: files.length, findings, idle, noRecord, perTrack: Object.fromEntries(perTrack) }, null, 2)); io.exit(bad ? 1 : 0); }
  console.log(`${files.length} changed file(s) against the ownership of ${wave.join(', ')}`);
  for (const t of wave) console.log(`  ${t.padEnd(30)} ${String(perTrack.get(t).files).padStart(4)} file(s)${perTrack.get(t).record || fs.existsSync(path.join(repo, changesDir, `${t}.md`)) ? '' : '   NO CHANGE RECORD'}`);
  for (const kind of ['CONTESTED', 'FOREIGN', 'UNOWNED']) {
    const list = findings.filter(r => r.status === kind);
    if (!list.length) continue;
    console.log(`\n${kind} (${list.length}): ${list[0].why}`);
    for (const r of list.slice(0, 60)) console.log(`  ${r.file}${r.track ? '   [' + r.track + ']' : ''}`);
  }
  if (idle.length) console.log(`\nNO FILE CHANGED by: ${idle.join(', ')} (did the track run? did it write somewhere else?)`);
  if (noRecord.length) console.log(`\nNO CHANGE RECORD (${changesDir}/<track>.md) from: ${noRecord.join(', ')}`);
  console.log(bad ? '\nOwnership NOT respected. For each file: move the edit into the owning track\'s gate patch, or record at the gate why the edit stays and who owns the file from now on.' : '\nOwnership respected: every changed file belongs to one track of the wave.');
  io.exit(bad ? 1 : 0);
}

module.exports = { main };
if (require.main === module) cli(main);
