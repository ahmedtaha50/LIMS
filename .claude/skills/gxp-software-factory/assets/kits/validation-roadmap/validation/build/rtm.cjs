// The RTM rows and the CSV files of the package (kit validation-roadmap of the gxp-software-factory skill; proven on the EBR project).
//
//   node validation/build/rtm.cjs        writes validation/docs/RTM.csv and validation/docs/deviations.csv
//
// No result is typed here or in content.cjs: every Pass, Fail and NOT RUN comes from results.cjs, which reads the evidence files.
// The Word documents (VP, URS, GRA, FRS, RTM, IQ, OQ, VSR) come from build.cjs and docx_styles.cjs of the kit validation/,
// fed with these same rows; its VSR conclusion is computed from the OPEN deviations, never typed.
const fs = require('fs'), path = require('path');

/** The RTM rows: [URS, priority, FRS, OQ, type, result, executed references or note]. `Res` is results.cjs or a stand-in. */
function rtmRows(C, Res) {
  return C.URS.map(([id, , priority]) => {
    const v = C.VERIF[id];
    const frs = C.FRS.filter(x => x[2].includes(id)).map(x => x[0]).join(', ');
    const s = Res.statusOfVerif(v);
    let result;
    if (v.type === 'GAP') result = `NOT MET (${v.deviation || 'no deviation'})`;
    else if (s && v.type === 'P*') result = s === 'Pass' ? `Partial: the executed part passes (${v.deviation})` : s;
    else if (s) result = s;
    else result = v.deviation ? `Not executed (${v.deviation})` : 'Not executed';
    const refs = (v.tests || []).map(r => Res.refId(r)).join('; ');
    return [id, priority, frs, v.ref, v.type, result, [refs, v.note].filter(Boolean).join(' | ')];
  });
}

const csv = rows => rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';

module.exports = { rtmRows, csv };

if (require.main === module) {
  const C = require('./content.cjs'), Res = require('./results.cjs');
  if (!Res.files.junit) { console.error('no evidence: run bash validation/build/collect-evidence.sh first'); process.exit(1); }
  const OUT = path.join(__dirname, '..', 'docs'); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'RTM.csv'), csv([['URS', 'Priority', 'FRS', 'OQ', 'Type', 'Result', 'Executed references / note'], ...rtmRows(C, Res)]));
  fs.writeFileSync(path.join(OUT, 'deviations.csv'), csv([['Id', 'Description', 'Action', 'Status'], ...C.DEVIATIONS]));
  const open = C.DEVIATIONS.filter(d => d[3] === 'OPEN').length;
  console.log(`validation/docs: RTM.csv (${C.URS.length} requirements), deviations.csv (${open} open); evidence ${Object.values(Res.files).filter(Boolean).join(', ')}`);
}
