#!/usr/bin/env node
// Checks a delivery roadmap before any agent is launched, and turns it into a wave plan.
//
//   node roadmap-lint.cjs [roadmap.json] [--repo <dir>] [--release <name|index>] [--max-parallel 4]
//                         [--db-prefix app_] [--base-port 3100] [--migrations-dir <dir>] [--plan <out.json>] [--json]
//
// A roadmap is { releases: [{ name, goal, tracks: [{ track, gapIds, ownsFiles, dependsOn, summary, migrations? }] }], gaps?: [...] }.
// The shape produced by the discovery workflow ({ synth: { releases, mergedGaps } }) is read as well.
//
// Why each check exists (all of them cost a wave when they were missing):
//   - two tracks of the SAME wave owning the same file: they overwrite each other in the shared working tree;
//   - a gap in two tracks or in none: built twice, or silently never built;
//   - a dependency on a track of the same or a later wave: the track builds on code that is not there yet;
//   - overlapping migration ranges: two tracks create the same migration number and the gate has to renumber by hand.
// Exit code 1 when an ERROR is found; warnings do not fail.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const VALUE_FLAGS = ['--repo', '--release', '--max-parallel', '--db-prefix', '--base-port', '--migrations-dir', '--plan'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
const file = path.resolve(positional[0] || 'docs/roadmap/roadmap.json');
const repo = opt('--repo') ? path.resolve(opt('--repo')) : null;
const maxParallel = Math.max(1, parseInt(opt('--max-parallel', '4'), 10) || 4);
const dbPrefix = opt('--db-prefix', 'app_');
const basePort = parseInt(opt('--base-port', '3100'), 10) || 3100;

if (!fs.existsSync(file)) { console.error(`roadmap-lint: ${file} does not exist`); process.exit(2); }
let raw;
try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`roadmap-lint: ${file} is not JSON: ${e.message}`); process.exit(2); }
const road = raw.synth && raw.synth.releases ? raw.synth : raw;
const releases = Array.isArray(road.releases) ? road.releases : [];
const gaps = road.mergedGaps || road.gaps || [];
if (!releases.length) { console.error('roadmap-lint: no releases[] found (expected { releases: [...] } or { synth: { releases: [...] } })'); process.exit(2); }

const errors = [], warnings = [], notes = [];
const E = (m) => errors.push(m), W = (m) => warnings.push(m), N = (m) => notes.push(m);

// ---------- globs ----------
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); if (j > -1) { re += '(?:' + glob.slice(i + 1, j).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const hasWild = (g) => /[*?{]/.test(g);

/** {a,b} alternatives written out (at most 64 patterns), so the comparison below only sees *, ** and ?. */
function braces(glob, limit = 64) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const out = [];
  for (const alt of m[1].split(',')) { for (const g of braces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length), limit)) { out.push(g); if (out.length >= limit) return out; } }
  return out;
}
function tokens(glob) {
  const t = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') i++; t.push({ k: 'any' }); } else t.push({ k: 'seg' }); }
    else if (c === '?') t.push({ k: 'one' });
    else t.push({ k: 'chr', c });
  }
  return t;
}
/** Can one path match both globs? A product walk over the two patterns (no file needed), slightly generous for "**\/". */
function globsIntersect(ga, gb) {
  for (const a of braces(ga)) for (const b of braces(gb)) if (intersect(tokens(a), tokens(b))) return true;
  return false;
}
function intersect(A, B) {
  // what one step of a token may consume: [class, next index]; class is a literal character, 'seg' (anything but "/") or 'any'
  const steps = (T, i) => {
    const t = T[i]; if (!t) return [];
    if (t.k === 'chr') return [[t.c, i + 1]];
    if (t.k === 'one') return [['seg', i + 1]];
    if (t.k === 'seg') return [['seg', i]];
    return [['any', i]];
  };
  const meet = (x, y) => {
    if (x === 'any' || y === 'any') return !(x === 'seg' && y === '/') && !(y === 'seg' && x === '/') ;
    if (x === 'seg' && y === 'seg') return true;
    if (x === 'seg') return y !== '/';
    if (y === 'seg') return x !== '/';
    return x === y;
  };
  const seen = new Set(), todo = [[0, 0]];
  while (todo.length) {
    const [i, j] = todo.pop();
    const key = i + ',' + j; if (seen.has(key)) continue; seen.add(key);
    if (i === A.length && j === B.length) return true;
    if (A[i] && (A[i].k === 'seg' || A[i].k === 'any')) todo.push([i + 1, j]);   // the wildcard matches nothing more
    if (B[j] && (B[j].k === 'seg' || B[j].k === 'any')) todo.push([i, j + 1]);
    for (const [ca, ni] of steps(A, i)) for (const [cb, nj] of steps(B, j)) if (meet(ca, cb)) todo.push([ni, nj]);
  }
  return false;
}

let repoFiles = null;
if (repo) {
  try {
    repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n').filter(Boolean);
  } catch {
    const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'dist', 'build', 'release'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(path.relative(repo, p).split(path.sep).join('/')); } return acc; };
    repoFiles = walk(repo);
  }
}
const expand = (patterns) => { const out = new Set(); if (!repoFiles) return out; const res = patterns.map(globToRegex); for (const f of repoFiles) if (res.some(r => r.test(f))) out.add(f); return out; };

/**
 * Do two ownership lists overlap?  files: existing files (or literal paths) both lists name: a certain conflict.
 * possible: pairs of patterns that can match the same NEW file although no existing file is shared.
 */
const overlapCache = new Map();
function overlap(a, b) {
  const key = a.track + '\u0000' + b.track;
  if (overlapCache.has(key)) return overlapCache.get(key);
  const files = new Set(), possible = [];
  if (repoFiles) { const A = expand(a.ownsFiles), B = expand(b.ownsFiles); for (const f of A) if (B.has(f)) files.add(f); }
  for (const pa of a.ownsFiles) for (const pb of b.ownsFiles) {
    if (pa === pb) { files.add(pa); continue; }
    if (!hasWild(pa) && !hasWild(pb)) continue;
    if (!hasWild(pa)) { if (globToRegex(pb).test(pa)) files.add(pa); continue; }
    if (!hasWild(pb)) { if (globToRegex(pa).test(pb)) files.add(pb); continue; }
    if (globsIntersect(pa, pb)) possible.push(`${pa}  ~  ${pb}`);
  }
  const res = { files: [...files].sort(), possible };
  overlapCache.set(key, res);
  return res;
}

// ---------- structure ----------
const allTracks = [];
releases.forEach((r, ri) => {
  if (!r.name) E(`release #${ri + 1} has no name`);
  if (!Array.isArray(r.tracks) || !r.tracks.length) { E(`release "${r.name || ri + 1}" has no tracks`); return; }
  r.tracks.forEach((t) => {
    t.ownsFiles = Array.isArray(t.ownsFiles) ? t.ownsFiles : [];
    t.dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    t.gapIds = Array.isArray(t.gapIds) ? t.gapIds : [];
    if (!t.track) { E(`a track of release "${r.name}" has no name`); return; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.track)) W(`track "${t.track}": use lower-case letters, digits and hyphens (it becomes a database name, a file name and a branch of every brief)`);
    if (!t.ownsFiles.length) E(`track "${t.track}" owns no files: it cannot run in a shared tree (give it ownsFiles, or merge it into the track that owns its files)`);
    if (!t.summary) W(`track "${t.track}" has no summary`);
    if (!t.gapIds.length) W(`track "${t.track}" names no gap: what is its acceptance?`);
    allTracks.push({ ...t, release: r.name, releaseIndex: ri });
  });
});
const byName = new Map();
for (const t of allTracks) { if (byName.has(t.track)) E(`track name "${t.track}" is used twice`); byName.set(t.track, t); }

// gaps: each in exactly one track; each with acceptance
const gapOwner = new Map();
for (const t of allTracks) for (const g of t.gapIds) { if (gapOwner.has(g)) E(`gap ${g} is in two tracks: ${gapOwner.get(g)} and ${t.track}`); else gapOwner.set(g, t.track); }
if (gaps.length) {
  const known = new Map(gaps.map(g => [g.id, g]));
  for (const g of gapOwner.keys()) if (!known.has(g)) E(`track "${gapOwner.get(g)}" names gap ${g}, which is not in the gap list`);
  for (const g of gaps) {
    if (!gapOwner.has(g.id)) W(`gap ${g.id} ("${String(g.title || '').slice(0, 70)}") is in no track: build it, or list it under droppedOrDeferred with the reason`);
    if (!Array.isArray(g.acceptance) || !g.acceptance.length) W(`gap ${g.id} has no acceptance criteria: the track cannot know when it is done and the gate cannot check it`);
  }
}

// dependencies and waves
for (const t of allTracks) for (const d of t.dependsOn) {
  if (!byName.has(d)) E(`track "${t.track}" depends on "${d}", which does not exist`);
  else if (byName.get(d).releaseIndex > t.releaseIndex) E(`track "${t.track}" (${t.release}) depends on "${d}" of a LATER release (${byName.get(d).release})`);
  else if (d === t.track) E(`track "${t.track}" depends on itself`);
}
const index = new Map(allTracks.map((t, i) => [t.track, i]));
const plan = [];
releases.forEach((r, ri) => {
  const tracks = allTracks.filter(t => t.releaseIndex === ri);
  const done = new Set(allTracks.filter(t => t.releaseIndex < ri).map(t => t.track));
  const left = new Map(tracks.map(t => [t.track, t]));
  const dependents = (name) => tracks.filter(t => t.dependsOn.includes(name)).length;
  const waves = [];
  while (left.size) {
    const ready = [...left.values()].filter(t => t.dependsOn.every(d => done.has(d) || !byName.has(d)));
    if (!ready.length) { E(`release "${r.name}": dependency cycle among ${[...left.keys()].join(', ')}`); break; }
    // a track that owns a file another ready track owns must not share its wave: take the one with more dependents first
    ready.sort((a, b) => dependents(b.track) - dependents(a.track) || index.get(a.track) - index.get(b.track));
    const wave = [];
    for (const t of ready) {
      if (wave.length >= maxParallel) break;
      const clash = wave.find(w => overlap(w, t).files.length);
      if (clash) { N(`${t.track} waits one wave: it shares files with ${clash.track} (${overlap(clash, t).files.slice(0, 3).join(', ')})`); continue; }
      wave.push(t);
    }
    for (const t of wave) { left.delete(t.track); }
    for (const t of wave) done.add(t.track);
    waves.push(wave);
  }
  plan.push({ release: r.name, waves });
});

// ownership inside each wave (errors), and shared files across a release (information for the gate)
for (const rel of plan) {
  rel.waves.forEach((wave, wi) => {
    for (let i = 0; i < wave.length; i++) for (let j = i + 1; j < wave.length; j++) {
      const o = overlap(wave[i], wave[j]);
      if (o.files.length) E(`${rel.release} wave ${wi + 1}: ${wave[i].track} and ${wave[j].track} both own ${o.files.slice(0, 5).join(', ')}${o.files.length > 5 ? ` (+${o.files.length - 5})` : ''}`);
      for (const p of o.possible) W(`${rel.release} wave ${wi + 1}: ${wave[i].track} and ${wave[j].track} may overlap: ${p}`);
    }
  });
  const tracks = rel.waves.flat();
  const shared = new Map();
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) for (const f of overlap(tracks[i], tracks[j]).files) {
    if (!shared.has(f)) shared.set(f, new Set()); shared.get(f).add(tracks[i].track); shared.get(f).add(tracks[j].track);
  }
  if (shared.size) N(`${rel.release}: ${shared.size} file(s) change hands between waves (ownership passes to the later track): ${[...shared.keys()].slice(0, 6).join(', ')}${shared.size > 6 ? ' ...' : ''}`);
}

// migration ranges
const ranges = [];
for (const t of allTracks) {
  if (t.migrations === undefined || t.migrations === null) continue;
  const m = /^(\d+)\s*(?:-|to|\.\.)\s*(\d+)$/.exec(String(t.migrations).trim()) || (/^(\d+)$/.exec(String(t.migrations).trim()) && [null, String(t.migrations).trim(), String(t.migrations).trim()]);
  if (!m) { E(`track "${t.track}": migrations "${t.migrations}" is not a range like "0320-0329"`); continue; }
  const from = parseInt(m[1], 10), to = parseInt(m[2], 10);
  if (to < from) { E(`track "${t.track}": migration range ${t.migrations} is backwards`); continue; }
  for (const r of ranges) if (from <= r.to && r.from <= to) E(`migration ranges overlap: ${t.track} (${from}-${to}) and ${r.track} (${r.from}-${r.to})`);
  ranges.push({ track: t.track, from, to, text: String(t.migrations) });
}
const MIG_DIRS = ['drizzle', 'migrations', 'db/migrate', 'db/migrations', 'prisma/migrations', 'alembic/versions', 'src/migrations'];
const migDir = opt('--migrations-dir') || (repo && MIG_DIRS.find(d => fs.existsSync(path.join(repo, d)))) || null;
const ownsMigrations = (t) => t.ownsFiles.some(p => (migDir ? [migDir] : MIG_DIRS).some(d => p.startsWith(d + '/')));
if (!ranges.length && !allTracks.some(ownsMigrations)) W('no track reserves migration numbers ("migrations": "0320-0329", or a pattern such as "migrations/032*" in ownsFiles): if tracks add database migrations in parallel, reserve a range per track');
if (migDir && repo && ranges.length) {
  const dir = path.join(repo, migDir);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)[_-]/.exec(f); if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!ranges.some(r => n >= r.from && n <= r.to)) N(`${migDir}/${f} is outside every reserved range (an earlier release, or an unplanned migration)`);
  }
}

// ---------- output ----------
const wanted = opt('--release');
const selected = plan.filter((p, i) => wanted === undefined || p.release === wanted || String(i) === wanted || String(i + 1) === wanted || p.release.toLowerCase().startsWith(String(wanted).toLowerCase()));
const out = {
  roadmap: path.relative(process.cwd(), file), tracks: allTracks.length, gaps: gaps.length || gapOwner.size, errors, warnings, notes,
  plan: selected.map(p => ({ release: p.release, waves: p.waves.map((w, wi) => ({ wave: wi + 1, tracks: w.map(t => ({
    track: t.track, db: dbPrefix + t.track.replace(/-/g, '_'), port: basePort + index.get(t.track), migrations: t.migrations || null, gapIds: t.gapIds, dependsOn: t.dependsOn, owns: t.ownsFiles.length,
  })) })) })),
};
if (opt('--plan')) fs.writeFileSync(path.resolve(opt('--plan')), JSON.stringify(out.plan, null, 2) + '\n');
if (flag('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(errors.length ? 1 : 0); }

console.log(`roadmap ${out.roadmap}: ${releases.length} release(s), ${allTracks.length} track(s), ${out.gaps} gap(s)${repoFiles ? `, ownership checked against ${repoFiles.length} files of ${path.basename(repo)}` : ' (no --repo: ownership compared by pattern only)'}`);
for (const p of out.plan) {
  console.log(`\n${p.release}`);
  for (const w of p.waves) {
    console.log(`  wave ${w.wave}: ${w.tracks.length} track(s) in parallel`);
    for (const t of w.tracks) console.log(`    ${t.track.padEnd(28)} db ${t.db.padEnd(30)} port ${t.port}${t.migrations ? '  migrations ' + t.migrations : ''}${t.dependsOn.length ? '  after ' + t.dependsOn.join(', ') : ''}`);
  }
}
if (notes.length) { console.log('\nNotes'); for (const n of notes) console.log('  - ' + n); }
if (warnings.length) { console.log(`\n${warnings.length} warning(s)`); for (const w of warnings) console.log('  ! ' + w); }
if (errors.length) { console.log(`\n${errors.length} ERROR(S): fix the roadmap before launching a wave`); for (const e of errors) console.log('  X ' + e); process.exit(1); }
console.log('\nroadmap OK: no ownership, gap, dependency or migration conflict found.');
