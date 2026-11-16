#!/usr/bin/env node
// Writes the briefs of one wave from the plan, so that no brief is typed from memory.
//
//   node make-briefs.cjs --release <name or number> --wave <n> --out <dir> [--repo .] [--context <file>] [--resume track-a,track-b] [--max-parallel 4]
//   node make-briefs.cjs --release <...> --wave <n> --out <dir> --gate --reports <dir-with-report-*.json>
//
// Reads factory.config.json (project facts, see assets/briefs/factory.config.example.json) and the roadmap. The first form
// writes <out>/prompt-<track>.txt for every track of the wave: database, port, migration range, the tracks it runs beside,
// what is already merged, the house rules, and the numbered acceptance criteria of its gaps (the ledger the report must answer).
// The second form writes <out>/gate-<wave>.txt with the digest of the reports, and refuses while reports-digest says "not ready".
// It refuses to write a brief when the roadmap has lint errors, when a project fact is missing or still TODO, or when a
// placeholder is left unfilled: a brief with a hole in it is how a track starts on the wrong database.
const fs = require('fs');
const path = require('path');
const { args, loadConfig, loadRoadmap, gitTry, tool } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;

  const { opt, flag } = args(argv, ['--release', '--wave', '--out', '--repo', '--context', '--resume', '--reports', '--max-parallel']);
  const repo = path.resolve(opt('--repo', '.'));
  const die = (m, code = 1) => { console.error('make-briefs: ' + m); io.exit(code); };
  if (!opt('--release') || !opt('--wave') || !opt('--out')) die('usage: node make-briefs.cjs --release <name|n> --wave <n> --out <dir> [--gate --reports <dir>] [--context file] [--resume a,b]', 2);
  if (!fs.existsSync(path.join(repo, 'factory.config.json'))) die(`no factory.config.json in ${repo}. Copy assets/briefs/factory.config.example.json there and fill the project facts.`);
  const cfg = loadConfig(repo);
  const NEED = ['PROJECT', 'BRANCH', 'ROADMAP', 'CHANGES_DIR', 'HOUSE_RULES_FILE', 'HOUSE_RULES_SUMMARY', 'DB_ENGINE', 'DB_ENV', 'DB_CREATE', 'DB_START', 'EVIDENCE_CHECKS', 'MUST_KEEP_WORKING', 'GATE_DB', 'GATE_PORT', 'CHECKS', 'SHARED_COUNTERS', 'DERIVED_FILES', 'TRAILERS'];
  const holes = NEED.filter(k => cfg[k] === undefined || cfg[k] === '' || /^\s*TODO\b/i.test(String(cfg[k])));
  if (holes.length) die(`factory.config.json: missing or TODO: ${holes.join(', ')}. Fill them from the repository; ask the user for what the repository does not say.`);
  if (!fs.existsSync(path.join(repo, cfg.HOUSE_RULES_FILE))) die(`the house rules file ${cfg.HOUSE_RULES_FILE} does not exist: every track reads it first.`);

  const roadmapFile = path.resolve(repo, cfg.ROADMAP);
  const lint = tool('roadmap-lint.cjs', [roadmapFile, '--repo', repo, '--json', '--db-prefix', String(cfg.DB_PREFIX), '--base-port', String(cfg.BASE_PORT), '--max-parallel', opt('--max-parallel', '4')], repo);
  let plan;
  try { plan = JSON.parse(lint.out); } catch { die('roadmap-lint did not answer: ' + lint.out.slice(0, 300)); }
  if (plan.errors.length) die(`the roadmap has ${plan.errors.length} error(s); fix them first:\n  - ` + plan.errors.join('\n  - '));
  const want = String(opt('--release'));
  const ri = plan.plan.findIndex((p, i) => p.release === want || String(i + 1) === want || p.release.toLowerCase().startsWith(want.toLowerCase()));
  if (ri < 0) die(`no release "${want}" (have: ${plan.plan.map(p => p.release).join(' | ')})`);
  const rel = plan.plan[ri];
  const wn = parseInt(opt('--wave'), 10);
  const wave = rel.waves.find(w => w.wave === wn);
  if (!wave) die(`release "${rel.release}" has waves 1 to ${rel.waves.length}`);
  const road = loadRoadmap(roadmapFile);
  const merged = [...plan.plan.slice(0, ri).flatMap(p => p.waves.flatMap(w => w.tracks.map(t => t.track))), ...rel.waves.filter(w => w.wave < wn).flatMap(w => w.tracks.map(t => t.track))];
  const head = gitTry(repo, ['rev-parse', '--short=10', 'HEAD']) || 'unknown';
  const outDir = path.resolve(opt('--out'));
  fs.mkdirSync(outDir, { recursive: true });
  const waveId = `${rel.release.split(/\s+/)[0].toLowerCase()}-w${wn}`;
  const template = (name) => fs.readFileSync(path.join(__dirname, '..', 'assets', 'briefs', name), 'utf8').replace(/^# .*\n+/, '').replace(/<!--[\s\S]*?-->\s*/g, '');
  function render(text, values, label) {
    const out = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
    const left = [...new Set(out.match(/\{\{[A-Z_]+\}\}/g) || [])];
    if (left.length) die(`${label}: unfilled ${left.join(', ')}`);
    return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  const common = { ...cfg, REPO: repo, RELEASE: rel.release, HEAD_SHA: head, MERGED: merged.length ? merged.join(', ') : '(none: this is the first wave)' };

  if (flag('--gate')) {
    if (!opt('--reports')) die('--gate needs --reports <dir>', 2);
    const names = wave.tracks.map(t => t.track);
    const dg = tool('reports-digest.cjs', [path.resolve(opt('--reports')), '--expect', names.join(','), '--roadmap', roadmapFile, '--repo', repo, '--for-gate'], repo);
    if (dg.code !== 0) { const why = tool('reports-digest.cjs', [path.resolve(opt('--reports')), '--expect', names.join(','), '--roadmap', roadmapFile, '--repo', repo], repo); die('the wave is not ready for the gate:\n' + why.out.split('\n').filter(l => /^\s+X |MISSING|BLOCKED|NOT ready/.test(l)).join('\n')); }
    const file = path.join(outDir, `gate-${waveId}.txt`);
    fs.writeFileSync(file, render(template('gate-brief.md'), { ...common, WAVE: `wave ${wn}`, WAVE_ID: waveId, WAVE_TRACKS: names.join(', '), REPORTS_JSON: dg.out.trim() }, 'gate brief'));
    console.log(`written ${file}\nLaunch ONE gate agent with it. Before that: node ownership-audit.cjs --tracks ${names.join(',')}`);
    io.exit(0);
  }

  const context = opt('--context') ? fs.readFileSync(path.resolve(opt('--context')), 'utf8').trim() : '';
  const resume = (opt('--resume', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const RESUME = 'RESUMED TRACK: an earlier attempt at this track was cut off. Its partial, uncommitted work is still in the working tree (git status: files under your ownsFiles and the tests you wrote). Review it critically, keep what is correct, and finish the track.';
  for (const t of wave.tracks) {
    const full = road.byName.get(t.track);
    const ledger = full.gapIds.flatMap(g => ((road.gapById.get(g) || {}).acceptance || []).map((c, i) => `  ${g}#${i + 1}: ${c}`));
    const db = t.db;
    const text = render(template('track-brief.md'), {
      ...common, TRACK: t.track, DB: db, PORT: t.port,
      MIGRATIONS: t.migrations || 'none reserved (add no migration; if the work needs one, stop and say so in the report)',
      WAVE_TRACKS: wave.tracks.filter(x => x.track !== t.track).map(x => x.track).join(', ') || '(none: you run alone)',
      DB_ENV: String(cfg.DB_ENV).replace(/<your db>/g, db), DB_CREATE: String(cfg.DB_CREATE).replace(/<your db>/g, db),
      REPORT_PATH: path.join(outDir, `report-${t.track}.json`),
      ACCEPTANCE: ledger.length ? ledger.join('\n') : '  (the roadmap gives this track no acceptance criterion: say in the report what you took as "done" and why)',
      CONTEXT: context ? 'CONTEXT FROM THE LEAD\n' + context : '', RESUME_NOTE: resume.includes(t.track) ? RESUME : '',
    }, `brief of ${t.track}`);
    fs.writeFileSync(path.join(outDir, `prompt-${t.track}.txt`), text);
    console.log(`written ${path.join(outDir, `prompt-${t.track}.txt`)}  (db ${db}, port ${t.port}${t.migrations ? ', migrations ' + t.migrations : ''}, ${ledger.length} acceptance line(s))`);
  }
  console.log(`\n${rel.release}, wave ${wn}: launch these ${wave.tracks.length} track(s) in ONE message, each with the path of its brief. Report schema: assets/briefs/report.schema.json (REPORT).`);
}

module.exports = { main };
if (require.main === module) cli(main);
