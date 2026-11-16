// Shared helpers of the factory tools: no dependency, Node 18+.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

/** Arguments: flag('--x'), opt('--x', default). Positional arguments are what is left. */
function args(argv = process.argv.slice(2), valueFlags = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(argv[i - 1]));
  return { flag, opt, positional, argv };
}

/** factory.config.json of the project (optional): paths and the facts that fill the briefs. */
function loadConfig(repo) {
  const f = path.join(repo, 'factory.config.json');
  let c = {};
  if (fs.existsSync(f)) { try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`factory.config.json is not valid JSON: ${e.message}`); } }
  return { ROADMAP: 'docs/roadmap/roadmap.json', CHANGES_DIR: 'docs/changes', EVIDENCE_DIR: 'validation/evidence', VALIDATION_DIR: 'validation/build', OPEN_ITEMS: 'docs/roadmap/open-items.json', DB_PREFIX: 'app_', BASE_PORT: 3100, ...c };
}

/** A roadmap in either shape: { releases, gaps } or the discovery output { synth: { releases, mergedGaps } }. */
function loadRoadmap(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const road = raw.synth && raw.synth.releases ? raw.synth : raw;
  const releases = Array.isArray(road.releases) ? road.releases : [];
  const gaps = road.mergedGaps || road.gaps || [];
  const tracks = [];
  releases.forEach((r, ri) => (r.tracks || []).forEach(t => tracks.push({ ...t, ownsFiles: t.ownsFiles || [], dependsOn: t.dependsOn || [], gapIds: t.gapIds || [], release: r.name, releaseIndex: ri })));
  return { releases, gaps, tracks, byName: new Map(tracks.map(t => [t.track, t])), gapById: new Map(gaps.map(g => [g.id, g])) };
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); if (j > -1) { re += '(?:' + glob.slice(i + 1, j).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const matcher = (patterns) => { const res = patterns.map(globToRegex); return (f) => res.some(r => r.test(f)); };

const git = (repo, a, o = {}) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...o });
const gitTry = (repo, a) => { try { return git(repo, a).trim(); } catch { return null; } };
const isGit = (repo) => gitTry(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';

/** Files that differ from `base` (default HEAD): committed since base, modified, staged, deleted and untracked. */
function changedFiles(repo, base = 'HEAD') {
  const out = new Set();
  const st = git(repo, ['status', '--porcelain=v1', '-uall', '--no-renames']);
  for (const l of st.split('\n')) { if (!l.trim()) continue; out.add(l.slice(3).replace(/^"|"$/g, '')); }
  if (base !== 'HEAD') { const d = gitTry(repo, ['diff', '--name-only', '--no-renames', base, 'HEAD']); if (d) for (const f of d.split('\n')) if (f) out.add(f); }
  return [...out].sort();
}

/** Runs a sibling tool (by name) or any Node script (by absolute path); returns { code, out }. */
function tool(name, a, cwd) {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', name), ...a], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
/** RFC 4180: quoted fields may hold commas, quotes ("") and new lines. Returns rows of strings. */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const today = () => new Date().toISOString().slice(0, 10);
module.exports = { args, loadConfig, loadRoadmap, globToRegex, matcher, git, gitTry, isGit, changedFiles, tool, today, parseCsv };
