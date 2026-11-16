// The one content source of the validation package (kit validation-roadmap of the gxp-software-factory skill).
// Proven on the EBR project: 94 requirements derived from its roadmap, gate green in CI over the evidence of every job.
//
// Requirements are NOT retyped: each URS row is an acceptance criterion of the roadmap (gap G05, criterion 1 -> URS-G05-1),
// with the gap's GxP risk as its priority. Verifications are FOUND, not typed: a test whose TITLE carries the criterion tag
// (for example "it('G05#1: a wrong password is refused', ...)") is a reference of that requirement; EXTRA adds references for
// tests whose title does not carry it, for CI jobs and for the capacity test. Whether a reference passed is looked up in the
// executed evidence (results.cjs). Mechanisms (FRS), risk scores (GRA) and deviations are written here and are the author's
// proposal for QA review.
//
// CHANGE IN A NEW PROJECT: SYSTEM, ROADMAP, TEST_DIRS, the rows of EXTRA, PARTIAL, FRS, GRA and DEVIATIONS. Keep the shapes.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ROADMAP = 'docs/roadmap/roadmap.json';
const roadmap = JSON.parse(fs.readFileSync(path.join(ROOT, ROADMAP), 'utf8'));
const gaps = (roadmap.synth && roadmap.synth.mergedGaps) || roadmap.mergedGaps || roadmap.gaps || [];

const SYSTEM = '<SYSTEM NAME: what it is, in one line>';
const PRIORITY = { Critical: 'Critical', High: 'High', Medium: 'Medium', Low: 'Low' };
const ursId = (gap, n) => `URS-${gap}-${n}`;
/** Every requirement of a gap: all('G05') -> ['URS-G05-1', 'URS-G05-2', ...]. */
const all = gap => { const g = gaps.find(x => x.id === gap); return g ? g.acceptance.map((_, i) => ursId(gap, i + 1)) : []; };

// URS: [id, text, priority, area]
const URS = gaps.flatMap(g => (g.acceptance || []).map((a, i) => [ursId(g.id, i + 1), String(a).replace(/`/g, ''), PRIORITY[g.gxpRisk] || 'Medium', `${g.id} ${g.title}`]));

// Test discovery: the titles of describe / it / test calls in the test sources carry tags "<gap id>#<criterion number>".
const TEST_DIRS = ['tests'];
const TEST_FILE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const TITLE = /\b(?:describe|it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const GAP_IDS = new Set(gaps.map(g => g.id));
const TAG = /\b([A-Z][A-Z0-9]*\d)#(\d+)\b/g;
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
function discover() {
  const byTag = {};
  for (const d of TEST_DIRS) {
    if (!fs.existsSync(path.join(ROOT, d))) continue;
    for (const abs of walk(path.join(ROOT, d)).filter(f => TEST_FILE.test(f)).sort()) {
      const file = path.relative(ROOT, abs).split(path.sep).join('/');
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(TITLE)) for (const t of m[2].matchAll(TAG)) {
        if (!GAP_IDS.has(t[1])) continue;                      // a tag of no gap is not a reference (and not a silent pass)
        const id = ursId(t[1], t[2]);
        const list = (byTag[id] = byTag[id] || []);
        if (!list.some(r => r.file === file)) list.push({ file, match: `${t[1]}#${t[2]}` });
      }
    }
  }
  return byTag;
}

// References the titles do not carry: { file, match: a fragment of the title }, { ci: '<name>' } (a PASS/FAIL line of a ci-*.txt
// evidence file), { perf: 'verdict' } (the capacity test).
const EXTRA = {
  // 'URS-G01-4': [{ ci: 'ci-workflow' }],
  // 'URS-G16-1': [{ perf: 'verdict' }],
};

// Requirements whose evidence is partly not an executed test of this package (P*) or that are not met (GAP), with the deviation.
// A release that is planned and not built yet: mark its rows GAP under ONE open deviation ("Release R4 is planned and not yet
// built"), close the deviation when its tests pass. The gate stays honest while the roadmap is ahead of the code.
const PARTIAL = {
  // 'URS-G19-1': { type: 'P*', deviation: 'DEV-YYYY-MM-DD-01', note: 'Runs in the CI job compose (another machine); not on the plant server.' },
};

// FRS: [id, mechanism with the paths that hold it, [urs ids]]. Every path named must exist (the gate checks it).
const FRS = gaps.map(g => [`FRS-${g.id}`, `<the mechanism of ${g.title}: name the files, e.g. src/... and tests/...>`, all(g.id)]);

// GRA: [area, Severity, Likelihood, Detectability, rationale, [urs ids]] (1-5 each; Detectability 5 = hard to detect)
const GRA = [
  ['<area (gap ids)>', 3, 2, 2, '<what goes wrong for the patient or the record>', URS.map(u => u[0])],
];

// Deviations: [id, description, action, status OPEN | CLOSED]
const DEVIATIONS = [
  // ['DEV-YYYY-MM-DD-01', 'Evidence from GitHub Actions (another machine): ...', 'Repeat on the plant server during IQ.', 'OPEN'],
];

const VERIF = (() => {
  const found = discover();
  const out = {};
  for (const [id] of URS) {
    const p = PARTIAL[id] || {};
    const tests = [...(found[id] || []), ...(EXTRA[id] || [])];
    out[id] = { type: p.type || (tests.length ? 'P' : 'GAP'), ref: `OQ-${id.split('-')[1]}`, tests, deviation: p.deviation, note: p.note };
  }
  return out;
})();

// OQ protocols: one per gap; its steps are the references of its requirements.
const OQ = gaps.map(g => [`OQ-${g.id}`, g.title, '<test conditions: fresh database per run, the built application, viewports>']);

module.exports = { SYSTEM, URS, FRS, GRA, DEVIATIONS, VERIF, OQ, discover, all };
