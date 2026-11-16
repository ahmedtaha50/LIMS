// @ts-check
// Shared helpers of the factory tools: no dependency, Node 18+. Data shapes: lib/types.d.ts.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { invoke, sibling } = require('./runtime.cjs');

/** @typedef {import('./types').Config} Config @typedef {import('./types').Roadmap} Roadmap @typedef {import('./types').Track} Track */

/**
 * Arguments: flag('--x'), opt('--x', default). Positional arguments are what is left.
 * @param {string[]} [argv]
 * @param {readonly string[]} [valueFlags] flags that take a value (so the value is not read as a positional argument)
 */
function args(argv = process.argv.slice(2), valueFlags = []) {
  const flag = (/** @type {string} */ n) => argv.includes(n);
  /** @type {{ (n: string): string | undefined; (n: string, d: string): string }} */
  // @ts-ignore -- one implementation for both overloads
  const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(argv[i - 1]));
  return { flag, opt, positional, argv };
}

/**
 * factory.config.json of the project (optional): paths and the facts that fill the briefs.
 * @param {string} repo
 * @returns {Config}
 */
function loadConfig(repo) {
  const f = path.join(repo, 'factory.config.json');
  /** @type {Record<string, unknown>} */
  let c = {};
  if (fs.existsSync(f)) { try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`factory.config.json is not valid JSON: ${e instanceof Error ? e.message : e}`); } }
  return { ROADMAP: 'docs/roadmap/roadmap.json', CHANGES_DIR: 'docs/changes', EVIDENCE_DIR: 'validation/evidence', VALIDATION_DIR: 'validation/build', OPEN_ITEMS: 'docs/roadmap/open-items.json', DB_PREFIX: 'app_', BASE_PORT: 3100, ...c };
}

/**
 * A roadmap in either shape: { releases, gaps } or the discovery output { synth: { releases, mergedGaps } }.
 * @param {string} file
 * @returns {Roadmap}
 */
function loadRoadmap(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const road = raw.synth && raw.synth.releases ? raw.synth : raw;
  /** @type {import('./types').Release[]} */
  const releases = Array.isArray(road.releases) ? road.releases : [];
  /** @type {import('./types').Gap[]} */
  const gaps = road.mergedGaps || road.gaps || [];
  /** @type {Track[]} */
  const tracks = [];
  releases.forEach((r, ri) => (r.tracks || []).forEach((t) => tracks.push({ ...t, ownsFiles: t.ownsFiles || [], dependsOn: t.dependsOn || [], gapIds: t.gapIds || [], release: r.name, releaseIndex: ri })));
  return { releases, gaps, tracks, byName: new Map(tracks.map(t => [t.track, t])), gapById: new Map(gaps.map(g => [g.id, g])) };
}

const { globToRegex, matcher } = require('./glob.cjs');

/** @param {string} repo @param {string[]} a @param {import('child_process').ExecFileSyncOptions} [o] @returns {string} */
const git = (repo, a, o = {}) => /** @type {string} */ ( execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...o }));
/** @param {string} repo @param {string[]} a @returns {string | null} the output, trimmed; null when git fails */
const gitTry = (repo, a) => { try { return git(repo, a).trim(); } catch { return null; } };
/** @param {string} repo */
const isGit = (repo) => gitTry(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';

/**
 * Files that differ from `base` (default HEAD): committed since base, modified, staged, deleted and untracked.
 * @param {string} repo
 * @param {string} [base]
 * @returns {string[]}
 */
function changedFiles(repo, base = 'HEAD') {
  /** @type {Set<string>} */
  const out = new Set();
  const st = git(repo, ['status', '--porcelain=v1', '-uall', '--no-renames']);
  for (const l of st.split('\n')) { if (!l.trim()) continue; out.add(l.slice(3).replace(/^"|"$/g, '')); }
  if (base !== 'HEAD') { const d = gitTry(repo, ['diff', '--name-only', '--no-renames', base, 'HEAD']); if (d) for (const f of d.split('\n')) if (f) out.add(f); }
  return [...out].sort();
}

/**
 * Runs a sibling tool (by file name) in this process, or any other Node script (by absolute path) as a child process.
 * @param {string} name
 * @param {string[]} a
 * @param {string} [cwd]
 * @returns {{ code: number, out: string }}
 */
function tool(name, a, cwd) {
  const main = sibling(name);
  if (main) return invoke(main, a, { cwd });
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', name), ...a], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
/**
 * RFC 4180: quoted fields may hold commas, quotes ("") and new lines.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cur = '', q = false;
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
/** @returns {string} the date of today, YYYY-MM-DD (UTC) */
const today = () => new Date().toISOString().slice(0, 10);
module.exports = { args, loadConfig, loadRoadmap, globToRegex, matcher, git, gitTry, isGit, changedFiles, tool, today, parseCsv };
