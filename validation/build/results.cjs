// Execution results for the validation package: what was actually run, read from the evidence files, never typed in.
//
// Sources (the newest file of each kind in validation/evidence/):
//   junit-*.xml      Vitest JUnit output of the whole suite (real PostgreSQL 16). A test is named by its file and a fragment of its title.
//   oq-run-*.txt     tests/security-controls.sh, one "PASS|FAIL <check id>" line per check, against the built bundle.
//   backup-run-*.txt tests/backup-restore.sh, same format.
//   e2e-run-*.txt    tests/e2e/run.cjs, one "PASS|FAIL <script> <check id> <text>" line per browser check.
//   desktop-run-*.txt tests/desktop-shell.cjs and desktop-upgrade.cjs (Electron under xvfb), one "PASS|FAIL <script> <text>" line per check.
//
// A reference to a test that cannot be found is 'NOT RUN', never 'Pass': a renamed or deleted test turns the RTM red.
const fs = require('fs'), path = require('path');
const EV = path.join(__dirname, '..', 'evidence');

const newest = prefix => {
  const f = fs.existsSync(EV) ? fs.readdirSync(EV).filter(x => x.startsWith(prefix)).sort().pop() : null;
  return f ? path.join(EV, f) : null;
};
const read = f => (f ? fs.readFileSync(f, 'utf8') : '');
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

/** Parses a Vitest JUnit file into [{ file, name, outcome: 'pass' | 'fail' | 'skip' }]. */
function parseJunit(xml) {
  const out = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = k => { const a = attrs.match(new RegExp(`\\b${k}="([^"]*)"`)); return a ? unxml(a[1]) : ''; };
    const body = m[3] || '';
    const outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    out.push({ file: get('classname'), name: get('name'), outcome });
  }
  return out;
}

function load() {
  const junitFile = newest('junit-');
  const shell = ['oq-run-', 'backup-run-'].map(p => newest(p)).filter(Boolean);
  const e2eFile = newest('e2e-run-');
  const cases = parseJunit(read(junitFile));
  const shellResults = {};
  for (const f of shell) read(f).split('\n').forEach(l => { const m = l.match(/^(PASS|FAIL) (\S+)/); if (m) (shellResults[m[2]] = shellResults[m[2]] || []).push(m[1]); });
  const desktop = [];
  read(newest('desktop-run-')).split('\n').forEach(l => { const m = l.match(/^(PASS|FAIL) (\S+) (.*)$/); if (m) desktop.push({ script: m[2], outcome: m[1], text: m[3] }); });
  const e2eResults = {};
  read(e2eFile).split('\n').forEach(l => { const m = l.match(/^(PASS|FAIL) (\S+) (\S+)/); if (m) (e2eResults[`${m[2]} ${m[3]}`] = e2eResults[`${m[2]} ${m[3]}`] || []).push(m[1]); });
  return { junitFile, shell, e2eFile, cases, shellResults, e2eResults, desktop, desktopFile: newest('desktop-run-') };
}

const R = load();
const rel = f => (f ? path.relative(path.join(__dirname, '..', '..'), f) : null);
const roll = outcomes => (!outcomes.length ? 'NOT RUN' : outcomes.every(o => o === 'pass' || o === 'PASS') ? 'Pass' : outcomes.some(o => o === 'fail' || o === 'FAIL') ? 'Fail' : 'NOT RUN');

/** A test reference: { file, match } (Vitest), { oq } (shell check), { e2e, id } (browser check). Returns { status, found } */
function statusOfRef(ref) {
  if (ref.oq) { const r = R.shellResults[ref.oq] || []; return { status: roll(r), found: r.length }; }
  if (ref.desktop) { const r = R.desktop.filter(d => d.script === ref.desktop && d.text.includes(ref.match)).map(d => d.outcome); return { status: roll(r), found: r.length }; }
  if (ref.e2e) { const r = R.e2eResults[`${ref.e2e} ${ref.id}`] || []; return { status: roll(r), found: r.length }; }
  const hits = R.cases.filter(c => c.file === ref.file && c.name.includes(ref.match));
  const executed = hits.filter(h => h.outcome !== 'skip');
  return { status: executed.length === 0 ? 'NOT RUN' : roll(executed.map(h => h.outcome)), found: hits.length, names: hits.map(h => h.name) };
}

/** A readable id for the RTM: the file and the title fragment, the shell check id, or the browser check. */
const refId = ref => (ref.oq ? ref.oq : ref.desktop ? `${ref.desktop} :: ${ref.match}` : ref.e2e ? `e2e:${ref.e2e}/${ref.id}` : `${ref.file.replace(/^tests\//, '')} :: ${ref.match}`);

/** The result of a verification entry of content.cjs: all of its references must pass. */
function statusOfVerif(v) {
  const refs = [...(v.checks || []).map(oq => ({ oq })), ...(v.tests || [])];
  if (!refs.length) return null;
  const rs = refs.map(r => statusOfRef(r).status);
  return rs.every(s => s === 'Pass') ? 'Pass' : rs.includes('Fail') ? 'Fail' : 'NOT RUN';
}

const totals = () => {
  const c = R.cases.filter(x => x.outcome !== 'skip');
  return { junit: rel(R.junitFile), tests: R.cases.length, passed: c.filter(x => x.outcome === 'pass').length, failed: c.filter(x => x.outcome === 'fail').length, skipped: R.cases.length - c.length,
    shellPass: Object.values(R.shellResults).flat().filter(x => x === 'PASS').length, shellFail: Object.values(R.shellResults).flat().filter(x => x === 'FAIL').length,
    desktop: rel(R.desktopFile), desktopPass: R.desktop.filter(d => d.outcome === 'PASS').length, desktopFail: R.desktop.filter(d => d.outcome === 'FAIL').length, e2ePass: Object.values(R.e2eResults).flat().filter(x => x === 'PASS').length, e2eFail: Object.values(R.e2eResults).flat().filter(x => x === 'FAIL').length, e2e: rel(R.e2eFile) };
};

module.exports = { statusOfRef, statusOfVerif, refId, totals, parseJunit, shellResults: R.shellResults, e2eResults: R.e2eResults, files: { junit: rel(R.junitFile), shell: R.shell.map(rel), e2e: rel(R.e2eFile) } };
