#!/usr/bin/env node
// The drill: proves on this machine that every guard of the factory lets good work through AND catches the fault it exists for.
//
//   node selftest.cjs [--verbose] [--keep]        (needs Node 18+ and git; nothing else; writes only in the temp folder)
//
// Each guard gets at least one clean case (must pass) and one planted fault (must be caught). A guard that was never seen
// failing is an assumption, so run this after installing the skill and after editing any tool: a change that makes a guard
// blind turns a "fault" line red here before it costs a wave.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const S = __dirname;
const verbose = process.argv.includes('--verbose'), keep = process.argv.includes('--keep');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-drill-'));
let n = 0;
const tmp = () => { const d = path.join(tmpRoot, 't' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };
const w = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n'); return f; };
const rm = (dir, rel) => fs.rmSync(path.join(dir, rel), { force: true });
const { invoke, sibling } = require('./lib/runtime.cjs');
/** Each tool runs as a function in this process (lib/runtime.cjs): the same code path as the command line, without a Node start per check. */
const run = (tool, args = [], input) => { const main = sibling(tool); if (!main) throw new Error(`${tool} does not export main()`); return invoke(main, args, { input }); };
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=drill', '-c', 'user.email=drill@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, msg, ...extra) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', ...extra, '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };

const results = [];
let section = '';
const sec = (s) => { section = s; };
const record = (kind, name, ok, detail) => { results.push({ section, kind, name, ok }); if (!ok || verbose) console.log(`${ok ? 'PASS ' : 'FAIL '} ${kind === 'fault' ? '[fault] ' : '        '}${section}: ${name}${ok ? '' : '\n        ' + String(detail || '').trim().split('\n').slice(-8).join('\n        ')}`); };
/** A clean case: the guard must let it through. */
const clean = (name, r, want = 0) => record('clean', name, r.code === want, `exit ${r.code}, want ${want}\n${r.out}`);
/** A planted fault: the guard must refuse it, and say why (the output must match `says`). */
const fault = (name, r, want, says) => record('fault', name, r.code === want && (!says || says.test(r.out)), `exit ${r.code}, want ${want}${says ? `, output must match ${says}` : ''}\n${r.out}`);
const is = (kind, name, got, want) => record(kind, name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---------- fixtures: a small project with a plan
const ROAD = {
  releases: [{ name: 'R1 Core', goal: 'drill', tracks: [
    { track: 'r1-alpha', gapIds: ['G01'], ownsFiles: ['src/alpha/**', 'tests/alpha/**'], dependsOn: [], migrations: '0010-0019', summary: 'sign-in' },
    { track: 'r1-beta', gapIds: ['G02'], ownsFiles: ['src/beta/**', 'tests/beta/**'], dependsOn: [], migrations: '0020-0029', summary: 'export' }] }],
  gaps: [
    { id: 'G01', title: 'Sign-in', acceptance: ['A wrong password is refused', 'The refusal is written to the audit trail'] },
    { id: 'G02', title: 'Export', acceptance: ['The export carries a signature'] }],
};
const CONFIG = { ...JSON.parse(fs.readFileSync(path.join(S, '..', 'assets', 'briefs', 'factory.config.example.json'), 'utf8')), TRAILERS: 'Reviewed-By: drill' };
function project() {
  const d = tmp();
  git(d, 'init', '-q');
  w(d, 'AGENTS.md', '# House rules\nStack: Node.\n');
  w(d, 'docs/roadmap/roadmap.json', ROAD);
  w(d, 'factory.config.json', { ...CONFIG, REPO: d });
  w(d, 'src/alpha/a.js', 'module.exports = 1;\n');
  w(d, 'src/beta/b.js', 'module.exports = 2;\n');
  w(d, 'tests/alpha/a.test.js', "it('a wrong password is refused', () => {});\n");
  commit(d, 'base');
  return d;
}
const waveInFlight = (d) => {
  fs.appendFileSync(path.join(d, 'src/alpha/a.js'), '// alpha work\n');
  fs.appendFileSync(path.join(d, 'src/beta/b.js'), '// beta work\n');
  w(d, 'docs/changes/r1-alpha.md', '# r1-alpha\n');
  w(d, 'docs/changes/r1-beta.md', '# r1-beta\n');
};
const report = (track, over = {}) => ({ track, status: 'complete', done: ['built'], notDone: [], filesChanged: ['src'], testsAdded: ['tests/alpha/a.test.js'], testEvidence: 'npm test: 12 passed, 0 failed, on a fresh database', decisionsForUser: [], needsFromOtherTracks: [], ...over });
const LEDGER_A = [{ gap: 'G01', n: 1, status: 'met', evidence: 'tests/alpha/a.test.js :: a wrong password is refused' }, { gap: 'G01', n: 2, status: 'met', evidence: 'tests/alpha/a.test.js :: audit entry' }];
const LEDGER_B = [{ gap: 'G02', n: 1, status: 'met', evidence: 'tests/alpha/a.test.js :: signature' }];
const roadOf = (d) => path.join(d, 'docs/roadmap/roadmap.json');

// ---------- 1. the plan itself
sec('roadmap-lint');
clean('accepts the example roadmap', run('roadmap-lint.cjs', [path.join(S, '..', 'assets', 'examples', 'roadmap.example.json')]));
fault('refuses the broken roadmap', run('roadmap-lint.cjs', [path.join(S, 'fixtures', 'roadmap.broken.json')]), 1);
{ let c = -1; try { c = JSON.parse(run('roadmap-lint.cjs', [path.join(S, 'fixtures', 'roadmap.broken.json'), '--json']).out).errors.length; } catch { /* reported below */ } is('fault', 'finds all 6 planted errors', c, 6); }

// ---------- 2. reports and the acceptance ledger
sec('reports-digest');
{
  const p = project(), R = tmp();
  const put = (r) => w(R, `report-${r.track}.json`, r);
  const dig = (...x) => run('reports-digest.cjs', [R, '--expect', 'r1-alpha', '--roadmap', roadOf(p), '--repo', p, ...x]);
  put(report('r1-alpha', { acceptance: LEDGER_A }));
  clean('a complete report that answers every criterion', dig());
  fault('a missing report stops the gate', run('reports-digest.cjs', [R, '--expect', 'r1-alpha,r1-beta']), 2, /MISSING REPORTS/);
  put(report('r1-alpha', { acceptance: [LEDGER_A[0], { ...LEDGER_A[1], evidence: '' }] }));
  fault('"met" without evidence', dig(), 2, /without evidence/);
  put(report('r1-alpha', { acceptance: [LEDGER_A[0]] }));
  fault('a criterion nobody answered', dig(), 2, /G01#2 not answered/);
  put(report('r1-alpha', { acceptance: [LEDGER_A[0], { gap: 'G01', n: 2, status: 'not-met' }] }));
  fault('"complete" with an unmet criterion', dig(), 2, /not met: the track is partial/);
  put(report('r1-alpha', { acceptance: [LEDGER_A[0], { ...LEDGER_A[1], evidence: 'tests/alpha/missing.test.js :: audit' }] }));
  fault('evidence that names a file that is not there', dig(), 2, /does not exist/);
  put(report('r1-alpha', { status: 'blocked', acceptance: LEDGER_A }));
  fault('a blocked track', dig(), 2, /BLOCKED/);
}

// ---------- 3. file ownership
sec('ownership-audit');
{
  const p = project(); waveInFlight(p);
  const audit = (tracks) => run('ownership-audit.cjs', ['--tracks', tracks, '--repo', p]);
  clean('every track inside its own files', audit('r1-alpha,r1-beta'));
  fault("a file of another track was edited", audit('r1-alpha'), 1, /FOREIGN/);
  w(p, 'src/shared/routes.js', '// edited directly\n');
  fault('a shared file edited directly instead of through a gate patch', audit('r1-alpha,r1-beta'), 1, /UNOWNED/);
  rm(p, 'src/shared/routes.js'); rm(p, 'docs/changes/r1-beta.md');
  fault('a track without a change record', audit('r1-alpha,r1-beta'), 1, /NO CHANGE RECORD/);
}

// ---------- 4. leftovers stay on a list
sec('open-items');
{
  const p = project(), R = tmp();
  w(R, 'report-r1-beta.json', report('r1-beta', { status: 'partial', notDone: ['Exports over 10,000 rows are not paged'], decisionsForUser: ['Retention of exports: five years assumed'], acceptance: [{ gap: 'G02', n: 1, status: 'not-met' }] }));
  const oi = (...a) => run('open-items.cjs', [...a, '--repo', p]);
  let r = oi('add-reports', R, '--roadmap', roadOf(p));
  is('clean', 'three leftovers of a report become three items', /^3 item\(s\) added/.test(r.out), true);
  r = oi('add-reports', R);
  is('fault', 'the same report imported twice adds nothing', /^0 item\(s\) added/.test(r.out), true);
  clean('the register is consistent', oi('check'));
  fault('closing an item without a reference', oi('resolve', 'OI-0001'), 2, /needs --by/);
  fault('an agent dropping planned work without a named person', oi('drop', 'OI-0001', '--reason', 'not needed any more'), 2, /decided-by/);
  clean('closing an item with a reference', oi('resolve', 'OI-0001', '--by', 'commit abc1234: paging added'));
  clean('one item added by hand', oi('add', '--kind', 'not-done', '--source', 'gate r1-w1', 'r1-alpha.gate.patch not applied: waits for the pinned archive'));
  const f = path.join(p, 'docs/roadmap/open-items.json'), reg = JSON.parse(fs.readFileSync(f, 'utf8'));
  reg.items[1].status = 'resolved'; fs.writeFileSync(f, JSON.stringify(reg));
  fault('an item closed by editing the file, with no reference', oi('check'), 1, /resolved without a reference/);
}

// ---------- 5. evidence belongs to a commit
sec('evidence-fresh');
{
  const p = project(), sha = git(p, 'rev-parse', 'HEAD');
  fault('evidence that does not say which commit it belongs to', run('evidence-fresh.cjs', ['--repo', p]), 1, /UNKNOWN/);
  w(p, 'validation/evidence/iq-sandbox-2026-01-01.txt', `IQ record\ngit ${sha}\n`); commit(p, 'evidence');
  clean('only documents changed since the evidence run', run('evidence-fresh.cjs', ['--repo', p]));
  fs.appendFileSync(path.join(p, 'src/alpha/a.js'), '// fixed after the evidence run\n'); commit(p, 'fix');
  fault('source changed after the evidence run', run('evidence-fresh.cjs', ['--repo', p]), 1, /STALE/);
}

// ---------- 6. regulatory citations
sec('citation-check');
{
  const p = tmp();
  const cite = (text, ...x) => { w(p, 'doc.md', text + '\n'); return run('citation-check.cjs', ['doc.md', '--repo', p, ...x]); };
  clean('clauses that exist', cite('Audit trail per 21 CFR 11.10(e) and EU GMP Annex 11 clause 9; software is GAMP category 5.'));
  fault('a paragraph that does not exist', cite('Controls per 21 CFR 11.10(z).'), 1, /INVALID/);
  fault('a section that does not exist', cite('Signatures per 21 CFR 11.20.'), 1, /INVALID/);
  fault('an Annex 11 clause that does not exist', cite('Archiving per Annex 11 clause 23.'), 1, /INVALID/);
  fault('a GAMP category that was withdrawn', cite('The firmware is GAMP category 2.'), 1, /INVALID/);
  clean('a citation outside the list is reported, not judged', cite('Equipment per 21 CFR 211.68.'));
  fault('strict mode: an unlisted citation needs a person', cite('Equipment per 21 CFR 211.68.', '--strict'), 1, /UNLISTED/i);
}

// ---------- 7. what is about to be committed
sec('precommit-guard');
{
  const p = tmp(); git(p, 'init', '-q');
  w(p, 'src/a.js', 'function start() {\n  return 1;\n}\nmodule.exports = start;\n'); w(p, 'tests/a.test.js', "it('starts', () => { expect(1).toBe(1); });\n"); commit(p, 'base');
  const guard = (...x) => run('precommit-guard.cjs', ['--repo', p, ...x]);
  const reset = () => { git(p, 'checkout', '-q', '--', '.'); git(p, 'clean', '-fdxq'); };
  fs.appendFileSync(path.join(p, 'src/a.js'), 'const ready = true;\n');
  clean('an ordinary change', guard()); reset();
  fs.appendFileSync(path.join(p, 'src/a.js'), "if (process.platform === 'win32') {} // FACTORY" + "-TEMP force the Windows path\n");
  fault('a temporary edit carrying the marker', guard(), 1, /TEMP/); reset();
  w(p, 'AGENTS.md', 'Temporary edits carry the marker `FACTORY' + '-TEMP` and are never committed.\n');
  clean('a manual that names the marker is not a temporary edit', guard()); reset();
  w(p, 'docs/notes.md', 'FACTORY' + '-TEMP remove this paragraph before the release\n');
  fault('a temporary paragraph in a document', guard(), 1, /TEMP/); reset();
  fs.appendFileSync(path.join(p, 'src/a.js'), 'if (true) { start(); }\n');
  fault('a forced branch left from an experiment', guard(), 1, /TEMP/); reset();
  fs.appendFileSync(path.join(p, 'tests/a.test.js'), "it." + "only('one', () => {});\n");
  fault('a focused test (the rest of the suite stops running)', guard(), 1, /FOCUSED/); reset();
  fs.appendFileSync(path.join(p, 'tests/a.test.js'), "it." + "skip('later', () => {});\n");
  fault('a skipped test', guard(), 1, /SKIPPED/);
  clean('a skipped test, when the gate allows and records it', guard('--allow-skip')); reset();
  w(p, '.env', 'DB_PASSWORD=x\n');
  fault('an environment file', guard(), 1, /JUNK/); reset();
  w(p, 'src/key.js', "const k = `-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEow\n-----END " + "RSA PRIVATE KEY-----`;\n");
  fault('a private key', guard(), 1, /SECRET/); reset();
  fault('a bare project argument is refused, not ignored (it once checked the whole repository)', run('precommit-guard.cjs', [p]), 2, /unexpected argument/);
  w(p, '.gitignore', 'build/\n'); for (let i = 0; i < 45; i++) w(p, `src/build/f${i}.js`, 'x\n');
  fault('swallowed files beyond the list are counted, never dropped', guard(), 0, /5 more/); reset(); fs.rmSync(path.join(p, '.gitignore'), { force: true });
  w(p, '.gitignore', 'build/\n'); commit(p, 'ignore build');
  w(p, 'kits/val/ci/job.yml', 'jobs: {}\n'); w(p, 'kits/val/validation/build/check.cjs', 'module.exports = 1;\n'); w(p, 'app/dist/server/main.js', 'x\n');
  fault('a kit folder hidden by "build/" while the rest of the kit is committed', guard(), 1, /HIDDEN\s+kits\/val\/validation\/build\//);
  w(p, '.gitignore', 'build/\n!kits/*/validation/build/\n');
  clean('re-included; the build output of a project in a subfolder (app/dist/) is not a finding', guard()); reset();
}

// ---------- 8. briefs come from the plan
sec('make-briefs');
{
  const p = project(), out = tmp();
  const mk = () => run('make-briefs.cjs', ['--release', '1', '--wave', '1', '--out', out, '--repo', p]);
  const r = mk();
  clean('one brief per track of the wave', r);
  const brief = fs.existsSync(path.join(out, 'prompt-r1-alpha.txt')) ? fs.readFileSync(path.join(out, 'prompt-r1-alpha.txt'), 'utf8') : '';
  is('clean', 'the brief carries the numbered acceptance criteria and no hole', /G01#1/.test(brief) && /G01#2/.test(brief) && !/\{\{/.test(brief), true);
  w(p, 'factory.config.json', { ...CONFIG, REPO: p, DB_ENV: 'TODO' });
  fault('a project fact that is still TODO', mk(), 1, /TODO/);
  rm(p, 'factory.config.json');
  fault('no project facts at all', mk(), 1, /factory\.config\.json/);
}

// ---------- 9. reading a failure
sec('ci-log-digest');
{
  const verdict = (log, ...x) => { try { return JSON.parse(run('ci-log-digest.cjs', ['-', '--json', ...x], log).out)[0].verdict; } catch { return 'no answer'; } };
  is('clean', 'a clean log', verdict('##[group]Run npm test\nok\n'), 'OK');
  is('clean', 'a green local run', verdict(' Test Files  3 passed (3)\n      Tests  20 passed (20)\n', '--local'), 'OK');
  is('fault', 'a job that never started', verdict(''), 'NEVER_STARTED');
  is('fault', 'a download that answered 504', verdict('##[group]Run build\n  x cannot resolve https://example.com/a.zip: status code 504\n##[error]Process completed with exit code 1.\n'), 'INFRA_DOWNLOAD');
  is('fault', 'a failing test', verdict('##[group]Run npm test\nnot ok 2 - saves the record\n# pass 5\n# fail 1\n##[error]Process completed with exit code 1.\n'), 'TEST_FAILURE');
  is('fault', 'a green suite that exits 1', verdict('##[group]Run npm test\nUnhandled Error\n Tests  20 passed (20)\n Errors  1 error\n##[error]Process completed with exit code 1.\n'), 'UNHANDLED_AFTER_GREEN');
  is('fault', 'a step that timed out', verdict("##[group]Run smoke\nstarting\n##[error]The action 'Smoke' has timed out after 8 minutes.\n"), 'TIMEOUT');
  is('fault', 'local: the database service is down (environment, not product)', verdict('Error: connect ECONNREFUSED 127.0.0.1:5432\n', '--local'), 'ENV_SERVICE_DOWN');
  is('fault', 'local: a missing database', verdict('error: database "app_x" does not exist\n', '--local'), 'ENV_DB_SETUP');
  is('fault', 'local: a configuration value refused at start-up', verdict('Error: JWT_SECRET: must be at least 32 characters in production\n', '--local'), 'ENV_CONFIG');
  is('fault', 'local: a busy port', verdict('Error: listen EADDRINUSE: address already in use :::3000\n', '--local'), 'ENV_PORT_BUSY');
  is('fault', 'local: a tool that is not installed', verdict('xvfb-run: command not found\n', '--local'), 'ENV_TOOL_MISSING');
  is('fault', 'local: a real failing test is not blamed on the environment', verdict('FAIL tests/a.test.ts > x\nAssertionError: expected 1 to be 2\n Tests  1 failed | 19 passed (20)\n', '--local'), 'TEST_FAILURE');
}

// ---------- 10. known debt can only shrink
sec('ratchet');
{
  const b = path.join(tmp(), 'baseline.json'), rat = (input, ...x) => run('ratchet.cjs', ['--baseline', b, ...x], input);
  clean('a first baseline, with a reason', rat('a\nb\n', '--update', '--allow-grow', '--reason', 'first'));
  clean('nothing new', rat('a\nb\n'));
  fault('a new finding', rat('a\nb\nc\n'), 1);
  fault('a baseline that tries to grow silently', rat('a\nb\nc\n', '--update'), 1);
  fault('strict mode: an entry that is fixed must leave the baseline', rat('a\n', '--strict-stale'), 1);
}

// ---------- 11. the agent manual
sec('manual-check');
{
  const p = tmp();
  w(p, 'package.json', { dependencies: { express: '1', zod: '1' } }); w(p, 'src/a.ts', "import express from 'express'; import { z } from 'zod';\n");
  w(p, 'AGENTS.md', 'Stack: Express, Zod.\n');
  clean('a manual that matches the code', run('manual-check.cjs', ['--repo', p]));
  w(p, 'AGENTS.md', 'Stack: Express, Zod, Firebase Auth, RabbitMQ.\n');
  fault('a manual naming what is not installed', run('manual-check.cjs', ['--repo', p]), 1);
  w(p, 'AGENTS.md', 'Stack: Express, Zod. Not used, do not add: any cloud identity service (Firebase included).\n');
  clean('a ban written as a list after a colon is understood as a ban', run('manual-check.cjs', ['--repo', p]));
  w(p, 'package.json', { dependencies: { express: '1', zod: '1', react: '19' } }); w(p, 'client/main.tsx', "import { StrictMode } from 'react';\n");
  w(p, 'AGENTS.md', 'Stack: Express, Zod, React.\n');
  clean('a client folder is read for imports', run('manual-check.cjs', ['--repo', p]));
}

// ---------- 12. the conductor: status and the exit gate of every station
sec('factory');
{
  const p = project(), remote = tmp(), R = tmp();
  git(remote, 'init', '-q', '--bare'); git(p, 'remote', 'add', 'origin', remote); git(p, 'push', '-q', '-u', 'origin', 'main');
  const fac = (...a) => run('factory.cjs', [...a, '--repo', p]);
  const line = (r, re) => re.test(r.out);

  is('clean', 'status: a plan with nothing built sends you to the waves', line(fac('status'), /NEXT: 2 Waves/), true);
  clean('exit discovery: a committed, lint-clean plan with a manual and project facts', fac('exit', 'discovery'));
  fs.appendFileSync(roadOf(p), '\n');
  fault('exit discovery: a roadmap that is not committed', fac('exit', 'discovery'), 1, /FAIL +the roadmap is committed/);
  git(p, 'checkout', '-q', '--', 'docs/roadmap/roadmap.json');

  waveInFlight(p);
  w(R, 'report-r1-alpha.json', report('r1-alpha', { acceptance: LEDGER_A })); w(R, 'report-r1-beta.json', report('r1-beta', { acceptance: LEDGER_B }));
  is('clean', 'status: a wave in flight is not interrupted', line(fac('status'), /NEXT: finish what is in flight/), true);
  clean('exit wave: both tracks reported, answered the plan and stayed in their files', fac('exit', 'wave', '--tracks', 'r1-alpha,r1-beta', '--reports', R));
  const keepB = fs.readFileSync(path.join(R, 'report-r1-beta.json'), 'utf8'); rm(R, 'report-r1-beta.json');
  fault('exit wave: a report is missing', fac('exit', 'wave', '--tracks', 'r1-alpha,r1-beta', '--reports', R), 1, /FAIL +every track reported/);
  fs.writeFileSync(path.join(R, 'report-r1-beta.json'), keepB);
  w(p, 'src/shared/routes.js', '// edited directly\n');
  fault('exit wave: a file outside every track', fac('exit', 'wave', '--tracks', 'r1-alpha,r1-beta', '--reports', R), 1, /FAIL +every track stayed inside its files/);
  rm(p, 'src/shared/routes.js');

  w(p, 'docs/changes/r1-w1-gate.md', '# R1 wave 1 gate\nMerged by hand: nothing. Checks: 12 passed.\n');
  run('open-items.cjs', ['add-reports', R, '--roadmap', roadOf(p), '--repo', p]);
  const MSG = 'R1 wave 1: r1-alpha, r1-beta\n\nReviewed-By: drill';
  commit(p, MSG);
  clean('exit gate: one commit with its record, trailers and register', fac('exit', 'gate'));
  git(p, 'commit', '-q', '--amend', '-m', 'R1 wave 1');
  fault('exit gate: the commit lost its trailers', fac('exit', 'gate'), 1, /FAIL +the gate commit carries the required trailers/);
  w(p, 'docs/changes/r1-alpha.gate.patch', '--- a/src/shared/routes.js\n+++ b/src/shared/routes.js\n@@ -1 +1,2 @@\n // routes\n+// alpha\n');
  commit(p, MSG, '--amend');
  fault('exit gate: a gate patch left behind', fac('exit', 'gate'), 1, /FAIL +no gate patch is left behind unaccounted/);
  run('open-items.cjs', ['add', '--kind', 'not-done', '--source', 'gate r1-w1', 'r1-alpha.gate.patch not applied: waits for the shared route file', '--repo', p]);
  commit(p, MSG, '--amend');
  is('clean', 'exit gate: a patch deferred on purpose is accepted once it is on the list', line(fac('exit', 'gate'), /PASS +no gate patch is left behind unaccounted +\(r1-alpha\.gate\.patch is deferred as OI-/), true);

  fault('exit report: commits that are not pushed', fac('exit', 'report'), 1, /FAIL +HEAD is pushed/);
  git(p, 'push', '-q', '-f', 'origin', 'main');
  clean('exit report: clean, pushed, leftovers on the list', fac('exit', 'report'));
  is('clean', 'status: a built plan no longer points at the waves', line(fac('status'), /next wave +none/), true);

  const good = w(R, 'job-good.log', '##[group]Run npm test\n Tests  20 passed (20)\n'), red = w(R, 'job-red.log', '##[group]Run npm test\nnot ok 2 - saves the record\n# pass 5\n# fail 1\n##[error]Process completed with exit code 1.\n');
  clean('exit ci: the log of the run was digested and is clean', fac('exit', 'ci', '--log', good));
  fault('exit ci: the log holds a failing test', fac('exit', 'ci', '--log', red), 1, /TEST_FAILURE/);

  const pkg = { name: 'drill', build: { afterPack: 'scripts/release/after-pack.cjs', asar: false } };
  const WF = (first, second) => `jobs:\n  build:\n    steps:\n      - name: ${first}\n      - name: ${second}\n`;
  const SMOKE = 'Installed application starts (gui-smoke)\n        run: pwsh tests/installer/gui-smoke.ps1', PUBLISH = 'Publish the pre-release\n        uses: softprops/action-gh-release@v2';
  w(p, 'package.json', pkg); w(p, '.github/workflows/build.yml', WF(SMOKE, PUBLISH)); w(p, 'desktop/pg-bundle.json', { version: '16', sha256: 'a'.repeat(64) });
  commit(p, 'installer'); git(p, 'push', '-q', 'origin', 'main');
  clean('exit installer: manifest hook, visible files, pinned database, smoke test before publishing', fac('exit', 'installer', '--log', good));
  w(p, 'package.json', { ...pkg, build: { ...pkg.build, asar: true } });
  fault('exit installer: the integrity check cannot see the files', fac('exit', 'installer', '--log', good), 1, /FAIL +the integrity check can see the installed files/);
  w(p, 'package.json', { ...pkg, build: { asar: false } });
  fault('exit installer: the manifest is not written from the packaged files', fac('exit', 'installer', '--log', good), 1, /FAIL +the release manifest is written from the packaged files/);
  w(p, 'package.json', pkg); w(p, '.github/workflows/build.yml', WF(PUBLISH, SMOKE));
  fault('exit installer: published before the application was started', fac('exit', 'installer', '--log', good), 1, /FAIL +the real application is started on the target OS before publishing/);
  w(p, '.github/workflows/build.yml', WF(SMOKE, PUBLISH)); w(p, 'desktop/pg-bundle.json', { version: '16', sha256: '' });
  fault('exit installer: the database bundle is not pinned', fac('exit', 'installer', '--log', good), 1, /FAIL +the database bundle is pinned by SHA-256/);
  w(p, 'desktop/pg-bundle.json', { version: '16', sha256: 'a'.repeat(64) });

  w(p, 'validation/build/check.cjs', "console.log('traceability OK: 3 requirements');\n");
  w(p, 'validation/evidence/iq-sandbox-2026-01-01.txt', `IQ record\ngit ${git(p, 'rev-parse', 'HEAD')}\n`);
  commit(p, 'validation package');
  clean('exit validation: gate green, evidence about this code, citations real', fac('exit', 'validation'));
  w(p, 'docs/note.md', 'Electronic signatures follow 21 CFR 11.75.\n');
  fault('exit validation: a document cites a clause that does not exist', fac('exit', 'validation'), 1, /FAIL +no regulatory clause that cannot exist/);
  rm(p, 'docs/note.md');
  w(p, 'validation/build/check.cjs', "console.error('X URS-003 (Critical): no passed test and no open deviation'); process.exit(1);\n");
  fault('exit validation: the package claims more than was executed', fac('exit', 'validation'), 1, /FAIL +traceability/);
  git(p, 'checkout', '-q', '--', 'validation/build/check.cjs');
  fs.appendFileSync(path.join(p, 'src/beta/b.js'), '// fixed after the evidence run\n'); commit(p, 'fix after evidence');
  fault('exit validation: the code changed after the evidence was collected', fac('exit', 'validation'), 1, /FAIL +the evidence is about the code that is checked in +\(STALE/);
  fault('an unknown station', fac('exit', 'everything'), 2);
}

// ---------- 12b. a project that is a folder inside a larger repository (found when the skill was first tried on a new project)
sec('subfolder project');
{
  const top = tmp(); git(top, 'init', '-q');
  w(top, 'README.md', '# monorepo\n'); w(top, '.github/workflows/ci.yml', 'jobs: {}\n');
  const p = path.join(top, 'ebr');
  w(p, 'AGENTS.md', '# House rules\n'); w(p, 'docs/roadmap/roadmap.json', ROAD); w(p, 'factory.config.json', { ...CONFIG, REPO: p });
  w(p, 'src/alpha/a.js', 'module.exports = 1;\n'); w(p, 'src/beta/b.js', 'module.exports = 2;\n');
  commit(top, 'base');
  fs.appendFileSync(path.join(top, 'README.md'), 'changed outside the project\n');
  is('clean', 'status counts only the changes inside the project folder', /tree +clean/.test(run('factory.cjs', ['status', '--repo', p]).out), true);
  is('clean', 'status sees the workflows at the top of the repository', /CI +1 workflow file/.test(run('factory.cjs', ['status', '--repo', p]).out), true);
  clean('the pre-commit guard ignores changes outside the project folder', run('precommit-guard.cjs', ['--repo', p]));
  fs.appendFileSync(path.join(p, 'src/alpha/a.js'), '// alpha work\n'); w(p, 'docs/changes/r1-alpha.md', '# r1-alpha\n');
  clean('ownership is judged on paths relative to the project folder', run('ownership-audit.cjs', ['--tracks', 'r1-alpha', '--repo', p]));
  fs.appendFileSync(path.join(p, 'src/beta/b.js'), '// edited by alpha\n');
  fault('a foreign edit inside the project folder is still caught', run('ownership-audit.cjs', ['--tracks', 'r1-alpha', '--repo', p]), 1, /FOREIGN/);
  git(top, 'checkout', '-q', '--', '.'); fs.rmSync(path.join(p, 'docs/changes'), { recursive: true, force: true }); fs.writeFileSync(path.join(top, 'README.md'), '# monorepo\n');
  w(p, 'docs/changes/r1-w1-gate.md', '# gate\n'); git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'R1 wave 1\n\nReviewed-By: drill');
  is('clean', 'the gate record is found in a commit made from the top of the repository', /PASS +the gate commit contains a gate record/.test(run('factory.cjs', ['exit', 'gate', '--repo', p]).out), true);
  w(p, 'src/alpha/t.js', 'if (true) { run(); }\n');
  fault('a forced branch inside the project folder is still caught', run('precommit-guard.cjs', ['--repo', p]), 1, /TEMP/);
}

// ---------- 12b. checked-commit: never a commit after a failing check
sec('checked-commit');
{
  const p = tmp(); git(p, 'init', '-q'); w(p, 'src/a.js', 'module.exports = 1;\n'); commit(p, 'base');
  const cfg = { TRAILERS: 'Reviewed-By: drill', CHECK_COMMANDS: ['node -e "process.exit(0)"'] };
  w(p, 'factory.config.json', cfg); commit(p, 'config');
  // checked-commit runs git itself: the identity of the drill's commits comes from the environment
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'drill'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'drill@example.invalid';
  w(p, 'src/a.js', 'module.exports = 2;\n');
  const before = git(p, 'rev-parse', 'HEAD');
  fault('a failing check: nothing is committed', run('checked-commit.cjs', ['--repo', p, '--all', '-m', 'change', '--check', 'node -e "process.exit(3)"']), 1, /NOT committed/);
  is('fault', 'HEAD did not move after the failing check', git(p, 'rev-parse', 'HEAD'), before);
  w(p, 'src/b.js', 'if (true) { start(); } // FACTORY-TEMP\n');
  fault('a temporary edit: the guard stops the commit after the checks pass', run('checked-commit.cjs', ['--repo', p, '--all', '-m', 'change']), 1, /precommit-guard/);
  rm(p, 'src/b.js'); git(p, 'add', '-A');
  fault('no check configured or given: refused', run('checked-commit.cjs', ['--repo', tmp(), '-m', 'x']), 2, /not a git repository|no check/);
  fault('a bare argument is refused, not ignored', run('checked-commit.cjs', ['--repo', p, 'change', '-m', 'x']), 2, /unexpected argument/);
  const top = tmp(); git(top, 'init', '-q'); w(top, 'proj/factory.config.json', cfg); w(top, 'proj/a.js', '1\n'); git(top, 'add', '-A');
  fault('no trailers at the top of the repository: refused, not committed without them', run('checked-commit.cjs', ['--repo', top, '-m', 'x', '--check', 'node -e 0']), 2, /no TRAILERS/);
  clean('--config reads the project in the subfolder, with its trailers', run('checked-commit.cjs', ['--repo', top, '--config', path.join(top, 'proj/factory.config.json'), '-m', 'x', '--check', 'node -e 0']));
  is('clean', 'the subfolder project\'s trailer is in the commit', /^Reviewed-By: drill$/m.test(git(top, 'log', '-1', '--format=%B')), true);
  clean('the checks and the guard pass: committed with the trailers', run('checked-commit.cjs', ['--repo', p, '--all', '-m', 'change']));
  is('clean', 'the commit carries the configured trailer', /^Reviewed-By: drill$/m.test(git(p, 'log', '-1', '--format=%B')), true);
}

// ---------- 12c. ci-head: the CI result read is HEAD's
sec('ci-head');
{
  const remote = tmp(); git(remote, 'init', '-q', '--bare');
  const p = tmp(); git(p, 'init', '-q'); w(p, 'a.txt', '1\n'); const old = commit(p, 'one');
  git(p, 'remote', 'add', 'origin', remote); git(p, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/main'); git(p, 'branch', '-q', '--set-upstream-to=origin/main');
  w(p, 'a.txt', '2\n'); const head = commit(p, 'two'); git(p, 'push', '-q');
  const runs = w(p, '../runs.json', { workflow_runs: [{ head_sha: old, status: 'completed', conclusion: 'success', created_at: '2026-01-01' }] });
  fault('a green run of an EARLIER commit is not the result of HEAD', run('ci-head.cjs', [runs, '--repo', p]), 1, /no run of HEAD/);
  fault('the run of HEAD failed', run('ci-head.cjs', ['--repo', p, '--sha', head, '--conclusion', 'failure']), 1, /ended failure/);
  fault('the run of HEAD is still running: green is not known', run('ci-head.cjs', ['--repo', p, '--sha', head, '--status', 'in_progress']), 1, /in_progress/);
  clean('the completed, successful run of HEAD', run('ci-head.cjs', ['--repo', p, '--sha', head, '--conclusion', 'success']));
  w(p, 'a.txt', '3\n'); const local = commit(p, 'three');
  fault('HEAD not pushed: CI has not run on it', run('ci-head.cjs', ['--repo', p, '--sha', local, '--conclusion', 'success']), 1, /not pushed/);
}

// ---------- 12d. screen-coverage: every function a person can call has a screen
sec('screen-coverage');
{
  const p = tmp();
  w(p, 'routes.json', [{ method: 'GET', path: '/api/users' }, { method: 'POST', path: '/api/users' }, { method: 'POST', path: '/api/users/:id/lock' }, { method: 'GET', path: '/api/health' }]);
  w(p, 'client/users.tsx', "const list = () => api(`/api/users?${q}`);\nconst add = (b) => api('/api/users', { method: 'POST', body: b });\nconst act = (id, a) => api(`/api/users/${id}/${a}`, { method: 'POST' });\n");
  w(p, 'client/i18n/ar.ts', "export default { '/api/health': 'x' };\n");
  const cfg = (ex) => w(p, 'factory.config.json', { SCREENS: { routeTable: 'routes.json', clientDir: 'client', exceptions: ex } });
  cfg({ 'GET /api/health': 'called by the load balancer' });
  fault('a route no screen calls (the action chosen at run time is never named)', run('screen-coverage.cjs', ['--repo', p]), 1, /NOSCREEN\s+POST \/api\/users\/:id\/lock/);
  w(p, 'client/users.tsx', fs.readFileSync(path.join(p, 'client/users.tsx'), 'utf8') + "const ACTIONS = ['lock'];\n");
  clean('every route called with its method, the rest named with a reason', run('screen-coverage.cjs', ['--repo', p]));
  cfg({ 'GET /api/health': 'called by the load balancer', 'GET /api/gone': 'old' });
  fault('an exception for a route that does not exist', run('screen-coverage.cjs', ['--repo', p]), 1, /STALE/);
  cfg({ 'GET /api/health': '' });
  fault('an exception without its reason', run('screen-coverage.cjs', ['--repo', p]), 1, /NOREASON/);
  cfg({});
  fault('a translation file naming a path is not a screen', run('screen-coverage.cjs', ['--repo', p]), 1, /GET \/api\/health/);
}

// ---------- 12e. ps1-lint: the PowerShell mistakes a Linux run cannot show
sec('ps1-lint');
{
  const p = tmp();
  w(p, 'deploy/ok.ps1', "$app = 'ebr'\nWrite-Host \"${app}: started on $env:COMPUTERNAME\"\n& $psql -v ON_ERROR_STOP=1 -c 'select 1' 'postgres://u@h/db'\n# \"$app:\" in a comment is not code\n");
  clean('scope prefixes, ${name}:, options before the address', run('ps1-lint.cjs', ['--repo', p]));
  w(p, 'deploy/bad1.ps1', "Write-Host \"$app: started\"\n");
  fault('"$app:" in a double-quoted string', run('ps1-lint.cjs', ['--repo', p, 'deploy/bad1.ps1']), 1, /VARCOLON/);
  w(p, 'deploy/bad2.ps1', "& $psql 'postgres://u@h/db' -v ON_ERROR_STOP=1 -c 'create database x'\n");
  fault('psql options after the connection address', run('ps1-lint.cjs', ['--repo', p, 'deploy/bad2.ps1']), 1, /PSQLORDER/);
  w(p, 'deploy/bad3.ps1', "& 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe' -c 'create database x' 'postgres://u@h/db'\n");
  fault('psql runs SQL without ON_ERROR_STOP', run('ps1-lint.cjs', ['--repo', p, 'deploy/bad3.ps1']), 1, /PSQLSTOP/);
  w(p, 'deploy/bad4.ps1', "& \"$pgBin\\pg_ctl.exe\" start -D $data -w -l $log | Out-Null\n");
  fault('pg_ctl start piped to Out-Null (the server keeps the pipe; the call never returns)', run('ps1-lint.cjs', ['--repo', p, 'deploy/bad4.ps1']), 1, /PGCTLPIPE/);
  w(p, 'deploy/ok2.ps1', "$ctl = Start-Process -FilePath \"$pgBin\\pg_ctl.exe\" -PassThru -ArgumentList 'start', '-D', $data -RedirectStandardOutput a.out -RedirectStandardError a.err\n& \"$pgBin\\pg_ctl.exe\" stop -D $data -m immediate | Out-Null\n");
  clean('pg_ctl started with Start-Process to files; a piped stop is fine', run('ps1-lint.cjs', ['--repo', p, 'deploy/ok2.ps1']));
}

// ---------- 12f. the kit validation-roadmap, copied into an empty project: requirements from the roadmap, tests found by tag
sec('kit validation-roadmap');
{
  const p = tmp();
  fs.cpSync(path.join(S, '..', 'assets', 'kits', 'validation-roadmap', 'validation'), path.join(p, 'validation'), { recursive: true });
  w(p, 'docs/roadmap/roadmap.json', { releases: [], gaps: [{ id: 'G01', title: 'Sign-in', gxpRisk: 'High', acceptance: ['A wrong password is refused', 'The refusal is audited'] }] });
  w(p, 'src/a.js', 'module.exports = 1;\n');
  w(p, 'tests/a.test.js', "describe('sign-in', () => {\n  it('G01#1: a wrong password is refused', () => {});\n  it('G01#2: the refusal is audited', () => {});\n  it('X99#1: a tag of no gap', () => {});\n});\n");
  const gate = () => { const r = spawnSync(process.execPath, [path.join(p, 'validation/build/check.cjs')], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const junit = (fail) => w(p, 'validation/evidence/junit-2026-01-01.xml', `<testsuites><testsuite><testcase classname="tests/a.test.js" name="sign-in &gt; G01#1: a wrong password is refused"/><testcase classname="tests/a.test.js" name="sign-in &gt; G01#2: the refusal is audited">${fail ? '<failure/>' : ''}</testcase></testsuite></testsuites>`);
  junit(false);
  fault('as copied: the mechanisms are still placeholders, so the gate is red', gate(), 1, /placeholder/);
  const cf = path.join(p, 'validation/build/content.cjs');
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace(/const FRS = gaps\.map\([^\n]*\n/, "const FRS = [['FRS-G01', 'src/a.js refuses and audits.', all('G01')]];\n"));
  clean('filled in: both High requirements found by their tags and passed in the evidence', gate());
  junit(true);
  fault('a referenced test failed in the evidence', gate(), 1, /URS-G01-2: .* is Fail/);
  junit(false);
  w(p, 'tests/a.test.js', "it('G01#1: a wrong password is refused', () => {});\n");
  fault('a High requirement whose test lost its tag: no test, no deviation', gate(), 1, /URS-G01-2 \(High\): no executed test and no open deviation/);
}

// ---------- 13. the skill itself
sec('skill-lint');
{
  clean('this skill: every path it names exists, every kit is complete', run('skill-lint.cjs'));
  const d = path.join(tmp(), 'mini-skill');
  w(d, 'SKILL.md', '---\nname: mini-skill\ndescription: a drill\n---\n# Mini\nRun `scripts/tool.cjs`.\n'); w(d, 'scripts/tool.cjs', "req" + "uire('./lib/gone.cjs');\n");   // split so that the lint of this skill does not read it as a real dependency
  fault('a tool whose require does not ship', run('skill-lint.cjs', [d]), 1, /REQUIRE/);
  w(d, 'scripts/tool.cjs', 'module.exports = 1;\n'); w(d, 'SKILL.md', '---\nname: mini-skill\ndescription: a drill\n---\n# Mini\nRun `scripts/tool.cjs`, then read `references/gone.md`.\n');
  fault('a manual that points at a file that is not there', run('skill-lint.cjs', [d]), 1, /PATH/);
}

// ---------- 14. the unit tests of the shared libraries (node:test; randomised cases print the seed that reproduces them)
sec('unit tests');
{
  const dir = path.join(S, 'tests'), files = fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs')).map(f => path.join(dir, f));
  const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const count = (k) => Number((new RegExp('^# ' + k + ' (\\d+)', 'm').exec(r.stdout || '') || [])[1] || 0);
  record('clean', `${count('pass')} unit test(s) in ${files.length} file(s), ${count('fail')} failed`, r.status === 0 && count('pass') > 0 && count('fail') === 0, (r.stdout || '') + (r.stderr || ''));
}

// ---------- summary
if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = results.filter(r => !r.ok), faults = results.filter(r => r.kind === 'fault');
const sections = [...new Set(results.map(r => r.section))];
console.log(`\n${sections.map(s => { const rs = results.filter(r => r.section === s); return `${s} ${rs.filter(r => r.ok).length}/${rs.length}`; }).join('   ')}`);
console.log(failed.length
  ? `selftest FAILED: ${failed.length} of ${results.length} checks. Do not rely on the factory on this machine until they pass.${keep ? ' Fixtures kept in ' + tmpRoot : ''}`
  : `selftest OK: ${results.length} checks, ${faults.length} planted faults caught, ${results.length - faults.length} clean cases passed.`);
process.exit(failed.length ? 1 : 0);
