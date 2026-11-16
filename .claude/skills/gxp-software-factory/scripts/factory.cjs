#!/usr/bin/env node
// The conductor of the factory: where the project stands, and whether a station may be called done.
//
//   node factory.cjs status [--repo .]
//       Reads the repository (manual, roadmap, change records, open items, validation, installer, CI files) and says which
//       station comes next. Start here whenever you enter a project or the user says "continue".
//
//   node factory.cjs exit <station> [--repo .] [--tracks a,b] [--reports <dir>] [--log <file>[,<file>]]
//       stations: discovery | wave | gate | ci | installer | validation | report
//       The exit gate of a station. PASS and FAIL lines are checked by tools; MANUAL lines are for you to confirm, each with
//       what counts as proof. Exit code 1 when anything FAILS.
//
// Why: "done" is the most expensive word in regulated work. A station is done when its exit gate passes, not when the work
// feels finished; the gate's output is the receipt you show the user. A FAIL is fixed, or reported as not done: it is never
// argued away, and no check is removed or loosened to turn it green.
const fs = require('fs');
const path = require('path');
const { args, loadConfig, loadRoadmap, gitTry, isGit, tool, parseCsv } = require('./lib/common.cjs');

const { opt, positional } = args(process.argv.slice(2), ['--repo', '--tracks', '--reports', '--log']);
const [cmd, station] = positional;
const repo = path.resolve(opt('--repo', '.'));
const STATIONS = ['discovery', 'wave', 'gate', 'ci', 'installer', 'validation', 'report'];
if (!['status', 'exit'].includes(cmd) || (cmd === 'exit' && !STATIONS.includes(station))) {
  console.error(`usage: node factory.cjs status [--repo .]\n       node factory.cjs exit <${STATIONS.join('|')}> [--repo .] [--tracks a,b] [--reports dir] [--log file]`);
  process.exit(2);
}
if (!isGit(repo)) { console.error(`factory: ${repo} is not a git repository`); process.exit(2); }
let cfg;
try { cfg = loadConfig(repo); } catch (e) { console.error('factory: ' + e.message); process.exit(2); }
const has = (p) => fs.existsSync(path.join(repo, p));
const hasConfig = has('factory.config.json');
const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const tail = (s, n = 6) => s.trim().split('\n').slice(-n).map(l => '        ' + l.slice(0, 200)).join('\n');

// ---------- facts ----------
function repoState() {
  const dirty = (gitTry(repo, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
  const upstream = gitTry(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead = null, behind = null;
  if (upstream) { const c = gitTry(repo, ['rev-list', '--left-right', '--count', '@{u}...HEAD']); if (c) [behind, ahead] = c.split(/\s+/).map(Number); }
  return { head: gitTry(repo, ['rev-parse', '--short=10', 'HEAD']), branch: gitTry(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty, upstream, ahead, behind };
}
function planState() {
  if (!has(cfg.ROADMAP)) return null;
  const lint = jsonOf(tool('roadmap-lint.cjs', [path.join(repo, cfg.ROADMAP), '--repo', repo, '--json', '--db-prefix', String(cfg.DB_PREFIX), '--base-port', String(cfg.BASE_PORT)], repo));
  if (!lint) return { broken: true };
  const tracked = new Set((gitTry(repo, ['ls-files', cfg.CHANGES_DIR]) || '').split('\n'));
  const merged = (t) => tracked.has(`${cfg.CHANGES_DIR}/${t}.md`);       // a track is merged when its change record is committed
  const releases = lint.plan.map(p => ({ release: p.release, waves: p.waves.map(w => ({ wave: w.wave, tracks: w.tracks.map(t => ({ ...t, merged: merged(t.track) })) })) }));
  let next = null;
  for (const r of releases) { for (const w of r.waves) { const open = w.tracks.filter(t => !t.merged); if (open.length) { next = { release: r.release, wave: w.wave, tracks: open.map(t => t.track) }; break; } } if (next) break; }
  return { lint, releases, next };
}
function deviations() {
  const f = cfg.DEVIATIONS_CSV || 'validation/docs/deviations.csv';
  if (!has(f)) return null;
  const rows = parseCsv(fs.readFileSync(path.join(repo, f), 'utf8')).slice(1).filter(r => r.length >= 4 && r[0]);
  return { file: f, open: rows.filter(r => /^open$/i.test(r[3].trim())).length, closed: rows.filter(r => !/^open$/i.test(r[3].trim())).length };
}
function installer() {
  if (!has('package.json')) return null;
  let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch { return null; }
  if (!pkg.build) return null;
  let pin = null;
  const pb = ['desktop/pg-bundle.json', 'pg-bundle.json'].find(has);
  if (pb) { try { pin = JSON.parse(fs.readFileSync(path.join(repo, pb), 'utf8')).sha256; } catch { pin = undefined; } }
  let smokeBeforePublish = null;
  for (const w of workflows()) {
    const t = fs.readFileSync(path.join(repo, '.github', 'workflows', w), 'utf8');
    const smoke = t.search(/gui-smoke|smoke[-_ ]?test|Installed application starts/i), publish = t.search(/action-gh-release|gh release (?:create|upload)|Publish .*release/i);
    if (publish > -1) smokeBeforePublish = smokeBeforePublish === true || (smoke > -1 && smoke < publish);
  }
  return { afterPack: pkg.build.afterPack || null, asar: pkg.build.asar, bundleFile: pb || null, pin, smokeBeforePublish };
}
function workflows() {
  const d = path.join(repo, '.github', 'workflows');
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.ya?ml$/.test(f)).sort() : [];
}
// A gate patch still in the changes folder: was it merged, and is it on the list?
function leftoverPatches() {
  const files = (gitTry(repo, ['ls-files', '--cached', '--others', '--exclude-standard', cfg.CHANGES_DIR]) || '').split('\n').filter(f => /\.gate\.patch$/.test(f));
  let open = [];
  if (has(cfg.OPEN_ITEMS)) { try { open = JSON.parse(fs.readFileSync(path.join(repo, cfg.OPEN_ITEMS), 'utf8')).items.filter(i => i.status === 'open'); } catch { /* reported by open-items check */ } }
  return files.map(f => {
    const applies = (extra) => { try { require('child_process').execFileSync('git', ['apply', '--check', ...extra, f], { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; } };
    const item = open.find(i => `${i.text} ${i.source}`.includes(path.basename(f)));
    const state = applies([]) ? 'NOT merged (it still applies)' : applies(['--reverse']) ? 'already in the tree' : 'neither applies nor reverses (merged by hand, or the tree moved on)';
    return { file: f, state, item: item ? item.id : null };
  });
}

// ---------- status ----------
if (cmd === 'status') {
  const st = repoState(), plan = planState(), dev = deviations(), inst = installer();
  const line = (k, v) => console.log(`  ${k.padEnd(13)} ${v}`);
  console.log(`FACTORY STATUS  ${path.basename(repo)} @ ${st.head} (${st.branch})`);
  line('tree', st.dirty ? `${st.dirty} uncommitted change(s): a wave or an edit is in flight` : 'clean');
  line('remote', !st.upstream ? 'no upstream branch' : st.ahead ? `${st.ahead} commit(s) not pushed` : st.behind ? `${st.behind} commit(s) behind ${st.upstream}` : `in step with ${st.upstream}`);
  const manual = ['AGENTS.md', 'CLAUDE.md'].find(has);
  const mc = manual ? tool('manual-check.cjs', ['--repo', repo], repo) : null;
  line('manual', !manual ? 'MISSING: no AGENTS.md / CLAUDE.md (every track reads it first)' : mc.code === 0 ? `${manual}: matches the code` : mc.code === 1 ? `${manual}: differs from the code (node scripts/manual-check.cjs)` : `${manual}: present (not a Node project: not compared)`);
  line('config', hasConfig ? 'factory.config.json present' : 'no factory.config.json (needed to generate briefs)');
  if (!plan) line('roadmap', `MISSING: ${cfg.ROADMAP}`);
  else if (plan.broken) line('roadmap', 'unreadable: run scripts/roadmap-lint.cjs');
  else {
    line('roadmap', `${plan.lint.tracks} track(s), ${plan.lint.gaps} gap(s); lint: ${plan.lint.errors.length} error(s), ${plan.lint.warnings.length} warning(s)`);
    for (const r of plan.releases) { const all = r.waves.flatMap(w => w.tracks); line('', `${r.release}: ${all.filter(t => t.merged).length}/${all.length} track(s) merged`); }
    line('next wave', plan.next ? `${plan.next.release}, wave ${plan.next.wave}: ${plan.next.tracks.join(', ')}` : 'none: every track of the roadmap has a committed change record');
  }
  if (has(cfg.OPEN_ITEMS)) line('open items', tool('open-items.cjs', ['check', '--repo', repo], repo).out.trim().split('\n')[0].replace(/^.*?: /, ''));
  else line('open items', `no register (${cfg.OPEN_ITEMS}): leftovers of earlier waves are not on a list`);
  let fresh = null;
  if (has(path.join(cfg.VALIDATION_DIR, 'check.cjs'))) {
    fresh = jsonOf(tool('evidence-fresh.cjs', ['--repo', repo, '--json'], repo));
    const gate = tool(path.join(repo, cfg.VALIDATION_DIR, 'check.cjs'), [], repo);
    line('validation', `traceability gate ${gate.code === 0 ? 'passes' : 'FAILS'}; evidence ${fresh ? fresh.verdict : '?'}${fresh && fresh.changed && fresh.changed.length ? ` (${fresh.changed.length} source file(s) changed since ${String(fresh.evidenceCommit).slice(0, 10)})` : ''}`);
  } else line('validation', 'no validation package (assets/kits/validation)');
  if (dev) line('deviations', `${dev.open} open, ${dev.closed} closed (${dev.file})`);
  if (inst) line('installer', `afterPack ${inst.afterPack ? 'registered' : 'NOT registered'}; asar ${inst.asar === false ? 'off' : 'ON (the integrity check cannot see the files)'}${inst.bundleFile ? `; database bundle ${/^[0-9a-f]{64}$/.test(String(inst.pin)) ? 'pinned' : 'NOT pinned'}` : ''}; smoke test before publish: ${inst.smokeBeforePublish === null ? 'no publishing workflow' : inst.smokeBeforePublish ? 'yes' : 'NO'}`);
  else line('installer', 'no electron-builder configuration');
  const wf = workflows();
  line('CI', wf.length ? `${wf.length} workflow file(s). The state of the last run is not visible from here: read it.` : 'no workflow files (assets/kits/ci)');
  const left = leftoverPatches().filter(p => !p.item);
  if (left.length) line('gate patches', `${left.length} left in ${cfg.CHANGES_DIR} and not on the open-items list: ${left.map(p => `${path.basename(p.file)}: ${p.state}`).join('; ')}`);

  let next, why;
  if (st.dirty) [next, why] = ['finish what is in flight', 'uncommitted changes: if a wave is running, wait for its reports (exit wave), then the gate; otherwise complete or revert the edit before starting anything'];
  else if (!manual) [next, why] = ['1 Discovery', 'write the agent manual first (references/discovery.md)'];
  else if (!plan) [next, why] = ['1 Discovery', 'there is no roadmap (references/discovery.md)'];
  else if (plan.broken || plan.lint.errors.length) [next, why] = ['1 Discovery', 'the roadmap has errors: fix them before any agent starts'];
  else if (plan.next) [next, why] = ['2 Waves', `build ${plan.next.release}, wave ${plan.next.wave} (references/waves.md; node scripts/make-briefs.cjs --release "${plan.next.release.split(' ')[0]}" --wave ${plan.next.wave} --out <dir>)`];
  else if (st.ahead) [next, why] = ['3 CI', 'commits are not pushed: push, then read the run (references/ci.md)'];
  else if (fresh && fresh.verdict !== 'FRESH') [next, why] = ['5 Validation', 'the evidence is older than the code: collect again and regenerate (references/validation.md)'];
  else [next, why] = ['6 Reporting, or what the user asks next', 'the plan is built and the evidence is current; read the last CI run before saying so'];
  console.log(`\nNEXT: ${next}\n      ${why}`);
  process.exit(0);
}

// ---------- exit gates ----------
const results = [];
const add = (s, name, detail = '') => results.push({ s, name, detail });
const st = repoState();
const tracks = (opt('--tracks', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const logs = (opt('--log', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const pushed = () => { if (!st.upstream) add('FAIL', 'HEAD is pushed', 'the branch has no upstream'); else if (st.ahead) add('FAIL', 'HEAD is pushed', `${st.ahead} commit(s) not pushed`); else add('PASS', 'HEAD is pushed', st.upstream); };
const clean = () => add(st.dirty ? 'FAIL' : 'PASS', 'working tree is clean', st.dirty ? `${st.dirty} uncommitted change(s)` : '');
const digestLogs = () => {
  if (!logs.length) { add('MANUAL', 'the CI log of HEAD was digested', `save the job log and pass --log <file>; proof: VERDICT OK from scripts/ci-log-digest.cjs for the run of ${st.head}`); return; }
  for (const l of logs) { const r = jsonOf(tool('ci-log-digest.cjs', [path.resolve(l), '--json'], repo)); if (!r) add('FAIL', `log ${path.basename(l)}`, 'could not be read'); else for (const j of r) add(j.verdict === 'OK' ? 'PASS' : 'FAIL', `log ${j.job}: ${j.verdict}`, j.verdict === 'OK' ? `${j.tests.map(t => `${t.passed} passed`).join(', ')}` : j.advice); }
};

if (station === 'discovery') {
  if (!has(cfg.ROADMAP)) add('FAIL', 'the roadmap exists', cfg.ROADMAP);
  else {
    const dirtyRoadmap = (gitTry(repo, ['status', '--porcelain', '--', cfg.ROADMAP]) || '').trim();
    add(dirtyRoadmap ? 'FAIL' : 'PASS', 'the roadmap is committed', dirtyRoadmap ? 'tracks read it from the repository: commit it' : cfg.ROADMAP);
    const lint = jsonOf(tool('roadmap-lint.cjs', [path.join(repo, cfg.ROADMAP), '--repo', repo, '--json'], repo));
    if (!lint) add('FAIL', 'roadmap-lint', 'no answer');
    else {
      add(lint.errors.length ? 'FAIL' : 'PASS', 'roadmap-lint: ownership, gaps, dependencies, migrations', lint.errors.length ? lint.errors.slice(0, 5).join(' | ') : `${lint.tracks} tracks, ${lint.plan.reduce((n, p) => n + p.waves.length, 0)} waves`);
      const noAcc = lint.warnings.filter(w => /no acceptance criteria|names no gap/.test(w));
      add(noAcc.length ? 'FAIL' : 'PASS', 'every track has gaps with acceptance criteria', noAcc.length ? noAcc.slice(0, 4).join(' | ') : 'this is what tracks test first and reports answer');
    }
  }
  const manual = ['AGENTS.md', 'CLAUDE.md'].find(has);
  if (!manual) add('FAIL', 'the agent manual exists', 'AGENTS.md or CLAUDE.md');
  else { const mc = tool('manual-check.cjs', ['--repo', repo], repo); add(mc.code === 1 ? 'FAIL' : 'PASS', 'the agent manual describes the code that exists', mc.code === 1 ? tail(mc.out, 4).trim() : manual); }
  add(hasConfig ? 'PASS' : 'FAIL', 'project facts are written down', hasConfig ? 'factory.config.json' : 'copy assets/briefs/factory.config.example.json to factory.config.json and fill it');
  add('MANUAL', 'the fact-check verdicts were applied', 'proof: every gap judged "partly" or "refuted" was corrected or removed in the roadmap');
  add('MANUAL', 'the user saw the plan', 'proof: a message with the releases, what was dropped and why, and the decisions that are theirs');
}
if (station === 'wave') {
  if (!tracks.length || !opt('--reports')) add('FAIL', 'arguments', 'exit wave needs --tracks a,b and --reports <dir>');
  else {
    const dg = tool('reports-digest.cjs', [path.resolve(opt('--reports')), '--expect', tracks.join(','), ...(has(cfg.ROADMAP) ? ['--roadmap', path.join(repo, cfg.ROADMAP), '--repo', repo] : [])], repo);
    add(dg.code === 0 ? 'PASS' : 'FAIL', 'every track reported and answered its acceptance criteria', dg.code === 0 ? dg.out.trim().split('\n').pop() : '\n' + dg.out.split('\n').filter(l => /^\s+X |MISSING|BLOCKED/.test(l)).slice(0, 8).map(l => '        ' + l.trim()).join('\n'));
    const oa = tool('ownership-audit.cjs', ['--tracks', tracks.join(','), '--repo', repo], repo);
    add(oa.code === 0 ? 'PASS' : 'FAIL', 'every track stayed inside its files', oa.code === 0 ? oa.out.trim().split('\n')[0] : '\n' + tail(oa.out, 10));
    add('MANUAL', 'no agent of the wave is still writing', 'proof: each sent its one final report; an agent that keeps waking was told to stop');
  }
}
if (station === 'gate') {
  clean();
  const msg = gitTry(repo, ['log', '-1', '--format=%B']) || '';
  const want = String(cfg.TRAILERS || '').split('\n').map(l => l.split(':')[0].trim()).filter(k => k && !k.startsWith('<'));
  if (!want.length) add('SKIP', 'commit trailers', 'none configured (TRAILERS in factory.config.json)');
  else { const miss = want.filter(k => !new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':', 'm').test(msg)); add(miss.length ? 'FAIL' : 'PASS', 'the gate commit carries the required trailers', miss.length ? 'missing: ' + miss.join(', ') : want.join(', ')); }
  const inHead = (gitTry(repo, ['show', '--name-only', '--format=', 'HEAD']) || '').split('\n');
  const rec = inHead.filter(f => f.startsWith(cfg.CHANGES_DIR + '/') && /gate[^/]*\.md$/i.test(f));
  add(rec.length ? 'PASS' : 'FAIL', 'the gate commit contains a gate record', rec.length ? rec.join(', ') : `no ${cfg.CHANGES_DIR}/*gate*.md in HEAD: write what was merged by hand, each fix, the evidence`);
  const patches = leftoverPatches(), loose = patches.filter(p => !p.item);
  add(loose.length ? 'FAIL' : 'PASS', 'no gate patch is left behind unaccounted', loose.length
    ? '\n' + loose.map(p => `        ${p.file}: ${p.state}. Delete it once its additions are in the tree; if it is deferred on purpose, put it on the list: open-items.cjs add --kind not-done --source gate "${path.basename(p.file)} not applied: <why>"`).join('\n')
    : patches.length ? patches.map(p => `${path.basename(p.file)} is deferred as ${p.item}`).join(', ') : '');
  if (!gitTry(repo, ['rev-parse', '--verify', '--quiet', 'HEAD~1'])) add('SKIP', 'the commit holds no temporary edit, focused or skipped test, secret or junk', 'first commit of the repository');
  else { const pg = tool('precommit-guard.cjs', ['--repo', repo, '--base', 'HEAD~1'], repo); add(pg.code === 0 ? 'PASS' : 'FAIL', 'the commit holds no temporary edit, focused or skipped test, secret or junk', pg.code === 0 ? '' : '\n' + tail(pg.out, 8)); }
  add(has(cfg.OPEN_ITEMS) ? 'PASS' : 'FAIL', 'the leftovers of the wave are in the open-items register', has(cfg.OPEN_ITEMS) ? cfg.OPEN_ITEMS : `node scripts/open-items.cjs add-reports <reports dir> --roadmap ${cfg.ROADMAP}`);
  add('MANUAL', 'every check ran on a fresh database, under CI conditions', 'proof: the gate report lists each check with its command and totals');
  add('MANUAL', 'shared counters were summed and derived files regenerated once', 'proof: named in the gate record');
}
if (station === 'ci') { pushed(); digestLogs(); add('MANUAL', 'the digested log is the run of HEAD', `proof: the run's commit is ${st.head}, not an earlier one`); add('MANUAL', 'informative steps were read too', 'proof: the digest shows no step with an error, or each one is explained'); }
if (station === 'installer') {
  const inst = installer();
  if (!inst) add('SKIP', 'installer configuration', 'no electron-builder "build" section in package.json');
  else {
    add(inst.afterPack ? 'PASS' : 'FAIL', 'the release manifest is written from the packaged files', inst.afterPack ? `afterPack: ${inst.afterPack}` : 'register an afterPack hook (assets/kits/release)');
    add(inst.asar === false ? 'PASS' : 'FAIL', 'the integrity check can see the installed files', inst.asar === false ? 'asar: false' : 'asar is on');
    if (inst.bundleFile) add(/^[0-9a-f]{64}$/.test(String(inst.pin)) ? 'PASS' : 'FAIL', 'the database bundle is pinned by SHA-256', inst.bundleFile + (/^[0-9a-f]{64}$/.test(String(inst.pin)) ? '' : ': sha256 is not set, so the installer ships without a database'));
    else add('SKIP', 'database bundle', 'no pg-bundle.json');
    add(inst.smokeBeforePublish === null ? 'SKIP' : inst.smokeBeforePublish ? 'PASS' : 'FAIL', 'the real application is started on the target OS before publishing', inst.smokeBeforePublish === null ? 'no publishing workflow found' : inst.smokeBeforePublish ? 'smoke step precedes the publish step' : 'the publish step comes first, or there is no smoke step');
  }
  pushed(); digestLogs();
  add('MANUAL', 'the user gets the link only after the green job was read', 'proof: the message names the build, what the smoke test covered and what is still untested');
}
if (station === 'validation') {
  const check = path.join(cfg.VALIDATION_DIR, 'check.cjs');
  if (!has(check)) add('FAIL', 'the traceability gate exists', `${check} (assets/kits/validation)`);
  else { const g = tool(path.join(repo, check), [], repo); add(g.code === 0 ? 'PASS' : 'FAIL', 'traceability: every Critical/High requirement has a passed test or an open deviation', g.code === 0 ? g.out.trim().split('\n').pop().slice(0, 160) : '\n' + tail(g.out, 8)); }
  const ef = jsonOf(tool('evidence-fresh.cjs', ['--repo', repo, '--json'], repo));
  add(ef && ef.verdict === 'FRESH' ? 'PASS' : 'FAIL', 'the evidence is about the code that is checked in', ef ? `${ef.verdict}${ef.changed && ef.changed.length ? `: ${ef.changed.length} source file(s) changed since ${String(ef.evidenceCommit).slice(0, 10)} (${ef.changed.slice(0, 4).join(', ')}${ef.changed.length > 4 ? ', ...' : ''})` : ''}${ef.verdict === 'UNKNOWN' ? ': ' + ef.message : ''}` : 'no answer');
  const cc = tool('citation-check.cjs', ['--repo', repo], repo);
  add(cc.code === 0 ? 'PASS' : 'FAIL', 'no regulatory clause that cannot exist', cc.out.trim().split('\n')[0]);
  const docs = cfg.VALIDATION_DOCS || 'validation/docs';
  if (has(docs) && has(cfg.VALIDATION_DIR)) {
    const sources = fs.readdirSync(path.join(repo, cfg.VALIDATION_DIR)).filter(f => /^content.*\.(c|m)?js$/.test(f)).map(f => path.join(cfg.VALIDATION_DIR, f));
    const tDocs = parseInt(gitTry(repo, ['log', '-1', '--format=%ct', '--', docs]) || '0', 10);
    const tSrc = parseInt(gitTry(repo, ['log', '-1', '--format=%ct', '--', ...sources, cfg.EVIDENCE_DIR]) || '0', 10);
    add(tDocs && tDocs >= tSrc ? 'PASS' : 'FAIL', 'the documents were generated after the last change of their sources', tDocs && tDocs >= tSrc ? docs : 'requirements or evidence changed in a later commit than the documents: regenerate');
  } else add('SKIP', 'generated documents', `${docs} not found`);
  const dev = deviations();
  if (dev) add('INFO', `deviations: ${dev.open} open, ${dev.closed} closed`, dev.open ? 'the summary report stays CONDITIONAL while one is open' : '');
  add('MANUAL', 'the package says what it is', 'proof: draft banner; "executed by an AI assistant"; reviewer and approval fields blank; requirement ids await System Owner approval');
  add('MANUAL', 'one generated document was opened and looked at', 'proof: converted to PDF and a page viewed');
}
if (station === 'report') {
  clean(); pushed();
  if (has(cfg.OPEN_ITEMS)) { const oi = tool('open-items.cjs', ['check', '--repo', repo], repo); add(oi.code === 0 ? 'PASS' : 'FAIL', 'the open-items register is consistent', oi.out.trim().split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' ').slice(0, 220)); }
  else add('FAIL', 'the open-items register exists', `${cfg.OPEN_ITEMS}: what is not done must be on a list, not in memory`);
  add('MANUAL', 'every claim names its receipt', 'proof: for each "works / passed / fixed": verified here (totals), verified in CI on <OS> (job read), or "not verified"');
  add('MANUAL', 'failures and your own mistakes come first', 'proof: the first lines of the message');
  add('MANUAL', 'what is not done and the decisions for the user are listed', 'proof: taken from the open-items register, not from memory');
  add('MANUAL', 'what happens next is stated', 'proof: the next step, and when you will check a running job again');
}

const failed = results.filter(r => r.s === 'FAIL').length, manual = results.filter(r => r.s === 'MANUAL').length;
console.log(`EXIT GATE: ${station}   ${path.basename(repo)} @ ${st.head}`);
for (const r of results) console.log(`  ${r.s.padEnd(6)} ${r.name}${r.detail ? (r.detail.startsWith('\n') ? r.detail : '  (' + r.detail + ')') : ''}`);
console.log(failed
  ? `\nRESULT: NOT PASSED (${failed} failed). Do not report this station as done: fix each FAIL, or tell the user it is not done and why.`
  : `\nRESULT: PASSED${manual ? `, with ${manual} line(s) for you to confirm. A MANUAL line you cannot prove is reported as "not verified".` : '.'}`);
process.exit(failed ? 1 : 0);
