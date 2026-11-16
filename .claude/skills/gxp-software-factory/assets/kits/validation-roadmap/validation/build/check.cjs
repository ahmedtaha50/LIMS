// The traceability gate: fails when the validation package claims more than the executed evidence shows.
//
//   node validation/build/check.cjs            (VALIDATION_EVIDENCE=<dir> to read another folder, e.g. the CI artifacts)  exit 1 with the list of findings, 0 when there are none
//
// From content.cjs and the evidence in validation/evidence/:
//   1. every Critical or High requirement has a passed executed test, or names an OPEN deviation;
//   2. no reference of any requirement Failed or is NOT RUN (a renamed or deleted test turns the package red);
//   3. a requirement that is P* or GAP names an OPEN deviation that exists;
//   4. every requirement has a mechanism (FRS), and every path a mechanism names exists;
//   5. every requirement is scored in the risk assessment (GRA).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// the folders a mechanism may name; CHANGE IN A NEW PROJECT to the project's own top-level folders
const PATH_ROOTS = ['src', 'server', 'client', 'tests', 'migrations', 'deploy', 'docs', 'validation', 'scripts', '.github'];

/** content and results can be injected (the unit test of this gate does); by default the real package and the real evidence. */
function findings({ requireEvidence = true, content: C = require('./content.cjs'), results: Res = requireEvidence ? require('./results.cjs') : null } = {}) {
  const f = [];
  const devs = new Map(C.DEVIATIONS.map(d => [d[0], d[3]]));
  for (const [id, , priority] of C.URS) {
    const v = C.VERIF[id];
    const critical = priority === 'Critical' || priority === 'High';
    if (!v) { f.push(`${id} (${priority}): no verification entry`); continue; }
    const refs = v.tests || [];
    if (v.deviation) {
      if (!devs.has(v.deviation)) f.push(`${id}: names the deviation ${v.deviation}, which does not exist`);
      else if (devs.get(v.deviation) !== 'OPEN') f.push(`${id}: its deviation ${v.deviation} is ${devs.get(v.deviation)}, not OPEN`);
    }
    if ((v.type === 'P*' || v.type === 'GAP') && !v.deviation) f.push(`${id} (${priority}): ${v.type} without a deviation`);
    if (critical && !refs.length && !v.deviation) f.push(`${id} (${priority}): no executed test and no open deviation`);
    if (requireEvidence) for (const r of refs) {
      const s = Res.statusOfRef(r);
      if (s.status !== 'Pass') f.push(`${id}: ${Res.refId(r)} is ${s.status}${s.found ? '' : ' (not found in the evidence)'}`);
    }
    if (!C.FRS.some(x => x[2].includes(id))) f.push(`${id}: no functional mechanism (FRS) names it`);
    if (C.GRA && !C.GRA.some(g => g[5].includes(id))) f.push(`${id}: not scored in the risk assessment (GRA)`);
  }
  for (const [id, mech] of C.FRS) {
    if (/<[^>]+>/.test(mech)) f.push(`${id}: the mechanism is still a placeholder`);
    for (const p of mech.match(new RegExp(`(?<![/A-Za-z0-9_.-])(?:${PATH_ROOTS.map(r => r.replace('.', '\\.')).join('|')})\\/[A-Za-z0-9_./-]*[A-Za-z0-9_/]`, 'g')) || []) {
      const clean = p.replace(/[.]$/, '');
      // a project in a subfolder of its repository finds .github/ one or more levels up
      const at = [ROOT, path.join(ROOT, '..'), path.join(ROOT, '..', '..')].map(r => path.join(r, clean));
      if (!at.some(a => fs.existsSync(a))) f.push(`${id}: the path ${clean} does not exist`);
    }
  }
  return f;
}

module.exports = { findings };

if (require.main === module) {
  const C = require('./content.cjs'), Res = require('./results.cjs');
  const bad = findings();
  const t = Res.totals();
  console.log(`evidence: ${t.junit || 'no JUnit file'} (${t.tests} tests, ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped); browser ${t.e2e || 'none'} (${t.e2eTotals.passed} passed, ${t.e2eTotals.failed} failed); capacity ${t.perf ? t.perfResult.verdict : 'not run'}`);
  if (bad.length) { console.error(`${bad.length} finding(s):\n- ${bad.join('\n- ')}`); process.exit(1); }
  const hi = C.URS.filter(u => u[2] === 'Critical' || u[2] === 'High').length;
  console.log(`traceability OK: ${C.URS.length} requirements, ${hi} Critical/High, each linked to a passed executed test or an open deviation.`);
}
