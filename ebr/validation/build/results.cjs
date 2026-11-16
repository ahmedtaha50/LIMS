// Execution results for the validation package: what was actually run, read from the evidence files, never typed in.
// Adapted from the kit of the gxp-software-factory skill (assets/kits/validation) for the EBR.
//
// Sources (the newest file of each kind in validation/evidence/, written by collect-evidence.sh):
//   junit-*.xml   Vitest JUnit of the whole suite on a fresh PostgreSQL database. classname = the test file (tests/...).
//   e2e-*.xml     Playwright JUnit of the browser tests of the built application, tablet and desktop projects.
//   perf-*.json   the capacity test (tests/perf/load.ts): its verdict and numbers.
//   ci-*.txt      results of CI jobs on GitHub Actions (another machine): copied with a header, never produced here.
//
// A reference that cannot be found is 'NOT RUN', never 'Pass': a renamed or deleted test turns the RTM red.
const fs = require('fs'), path = require('path');
const EV = process.env.VALIDATION_EVIDENCE || path.join(__dirname, '..', 'evidence');
const ROOT = path.join(__dirname, '..', '..');

const newest = prefix => {
  const f = fs.existsSync(EV) ? fs.readdirSync(EV).filter(x => x.startsWith(prefix)).sort().pop() : null;
  return f ? path.join(EV, f) : null;
};
const read = f => (f ? fs.readFileSync(f, 'utf8') : '');
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

/** Parses a JUnit file into [{ file, name, outcome: 'pass' | 'fail' | 'skip' }]. `prefix` puts Playwright's file names under tests/e2e/. */
function parseJunit(xml, prefix = '') {
  const out = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = k => { const a = attrs.match(new RegExp(`\\b${k}="([^"]*)"`)); return a ? unxml(a[1]) : ''; };
    const body = m[3] || '';
    const outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    let file = get('classname');
    if (prefix && !file.startsWith(prefix)) file = prefix + file.replace(/^.*?([^/]+\.spec\.ts).*$/, '$1');
    out.push({ file, name: get('name'), outcome });
  }
  return out;
}

function load() {
  const junitFile = newest('junit-'), e2eFile = newest('e2e-'), perfFile = newest('perf-'), ciFile = newest('ci-');
  // every ci-* file: in CI each job (compose, windows, the workflow itself) writes its own, all from the same run
  const ciFiles = fs.existsSync(EV) ? fs.readdirSync(EV).filter(x => x.startsWith('ci-')).sort().map(x => path.join(EV, x)) : [];
  const cases = [...parseJunit(read(junitFile)), ...parseJunit(read(e2eFile), 'tests/e2e/')];
  const perf = perfFile ? JSON.parse(read(perfFile)) : null;
  const ci = {};
  for (const f of ciFiles) read(f).split('\n').forEach(l => { const m = l.match(/^(PASS|FAIL) (\S+)/); if (m) (ci[m[2]] = ci[m[2]] || []).push(m[1]); });
  return { junitFile, e2eFile, perfFile, ciFile, cases, perf, ci };
}

const R = load();
const rel = f => (f ? path.relative(ROOT, f) : null);
const roll = outcomes => (!outcomes.length ? 'NOT RUN' : outcomes.every(o => o === 'pass' || o === 'PASS') ? 'Pass' : outcomes.some(o => o === 'fail' || o === 'FAIL') ? 'Fail' : 'NOT RUN');

/**
 * A reference: { file, match } (a test whose file is `file` and whose title contains `match`), { perf: 'verdict' } (the capacity
 * test), { ci: '<job>' } (a CI job result, recorded from another machine). Returns { status, found, names }.
 */
function statusOfRef(ref) {
  if (ref.perf) {
    if (!R.perf) return { status: 'NOT RUN', found: 0 };
    const ok = R.perf.verdict === 'PASS' && R.perf.failures.length === 0 && R.perf.recordedInDatabase === R.perf.expectedSteps;
    return { status: ok ? 'Pass' : 'Fail', found: 1 };
  }
  if (ref.ci) { const r = R.ci[ref.ci] || []; return { status: roll(r), found: r.length }; }
  const hits = R.cases.filter(c => c.file === ref.file && c.name.includes(ref.match));
  const executed = hits.filter(h => h.outcome !== 'skip');
  return { status: executed.length === 0 ? 'NOT RUN' : roll(executed.map(h => h.outcome)), found: hits.length, names: hits.map(h => h.name) };
}

/** A readable id for the RTM. */
const refId = ref => (ref.perf ? `capacity test (${rel(R.perfFile) || 'no result'})` : ref.ci ? `CI job ${ref.ci}` : `${ref.file.replace(/^tests\//, '')} :: ${ref.match}`);

/** The result of a verification: all of its references must pass. null when it has none. */
function statusOfVerif(v) {
  const refs = v.tests || [];
  if (!refs.length) return null;
  const rs = refs.map(r => statusOfRef(r).status);
  return rs.every(s => s === 'Pass') ? 'Pass' : rs.includes('Fail') ? 'Fail' : 'NOT RUN';
}

const totals = () => {
  const of = pre => R.cases.filter(c => (pre ? c.file.startsWith('tests/e2e/') : !c.file.startsWith('tests/e2e/')));
  const t = list => ({ tests: list.length, passed: list.filter(x => x.outcome === 'pass').length, failed: list.filter(x => x.outcome === 'fail').length, skipped: list.filter(x => x.outcome === 'skip').length });
  return { junit: rel(R.junitFile), ...t(of(false)), e2e: rel(R.e2eFile), e2eTotals: t(of(true)), perf: rel(R.perfFile), perfResult: R.perf, ci: rel(R.ciFile) };
};

module.exports = { statusOfRef, statusOfVerif, refId, totals, parseJunit, cases: R.cases, files: { junit: rel(R.junitFile), e2e: rel(R.e2eFile), perf: rel(R.perfFile), ci: rel(R.ciFile) } };
