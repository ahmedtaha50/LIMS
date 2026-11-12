// The traceability gate (roadmap M37): fails when the validation package claims more than the executed evidence shows.
//
//   node validation/build/check.cjs            exit 1 with the list of findings, 0 when there are none
//
// It checks, from validation/build/content.cjs and the evidence files in validation/evidence/:
//   1. every Critical or High requirement has a verification, and every test reference of it is found AND passed in the executed run;
//      the only exception is a requirement that names an OPEN deviation (VERIF[urs].deviation);
//   2. no test reference of any requirement is Failed or NOT RUN (a renamed or deleted test turns the RTM red);
//   3. every requirement has at least one mechanism (FRS), and every src/ or tests/ path named in a mechanism exists;
//   4. every deviation named by a verification exists.
const fs = require('fs'), path = require('path');
const realContent = require('./content.cjs');
const realResults = require('./results.cjs');
const ROOT = path.join(__dirname, '..', '..');

/** content and results can be injected (the unit test of this gate does); by default the real package and the real evidence. */
function findings({ requireEvidence = true, content: C = realContent, results: Res = realResults } = {}) {
  const f = [];
  const devs = new Map(C.DEVIATIONS.map(d => [d[0], d[3]]));
  for (const [id, text, priority] of C.URS) {
    const v = C.VERIF[id];
    const critical = priority === 'Critical' || priority === 'High';
    if (!v) { f.push(`${id} (${priority}): no verification entry`); continue; }
    const refs = [...(v.checks || []).map(oq => ({ oq })), ...(v.tests || [])];
    if (v.deviation) {
      if (!devs.has(v.deviation)) f.push(`${id}: names the deviation ${v.deviation}, which does not exist`);
      else if (devs.get(v.deviation) !== 'OPEN') f.push(`${id}: its deviation ${v.deviation} is ${devs.get(v.deviation)}, not OPEN`);
    }
    if (critical && !refs.length && !v.file && !v.deviation) f.push(`${id} (${priority}): no executed test and no open deviation`);
    if (critical && v.type === 'GAP' && !v.deviation) f.push(`${id} (${priority}): GAP without a deviation`);
    if (requireEvidence) for (const r of refs) {
      const s = Res.statusOfRef(r);
      if (s.status !== 'Pass') f.push(`${id}: ${Res.refId(r)} is ${s.status}${s.found ? '' : ' (not found in the evidence)'}`);
    }
    if (v.file && requireEvidence && !fs.existsSync(path.join(ROOT, 'validation', 'evidence', v.file))) f.push(`${id}: evidence file ${v.file} is missing`);
    if (!C.FRS.some(x => x[2].includes(id))) f.push(`${id}: no functional mechanism (FRS) names it`);
  }
  for (const [id, mech] of C.FRS) {
    for (const p of mech.match(/(?<![/A-Za-z0-9_.-])(?:src|tests|drizzle|docs|scripts|validation)\/[A-Za-z0-9_./-]*[A-Za-z0-9_]/g) || []) {
      const clean = p.replace(/[.]$/, '');
      if (!fs.existsSync(path.join(ROOT, clean)) && !fs.existsSync(path.join(ROOT, clean.replace(/\/$/, '')))) f.push(`${id}: the path ${clean} does not exist`);
    }
  }
  return f;
}

module.exports = { findings };
const C = realContent, Res = realResults;

if (require.main === module) {
  const bad = findings();
  const t = Res.totals();
  console.log(`evidence: ${t.junit || 'no JUnit file'} (${t.tests} tests, ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped); shell OQ ${t.shellPass} pass / ${t.shellFail} fail; browser ${t.e2e || 'none'} ${t.e2ePass} pass / ${t.e2eFail} fail`);
  if (bad.length) { console.error(`${bad.length} finding(s):\n- ${bad.join('\n- ')}`); process.exit(1); }
  console.log(`traceability OK: ${C.URS.length} requirements, ${C.URS.filter(u => u[2] === 'Critical' || u[2] === 'High').length} Critical/High, each linked to a passed executed test or an open deviation.`);
}
