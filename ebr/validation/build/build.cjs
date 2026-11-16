// Generates the EBR validation package (Word documents and CSV) from content.cjs and the executed evidence (results.cjs).
//
//   node validation/build/build.cjs      writes validation/docs/: VP, URS, GRA, FRS, RTM, IQ, OQ, VSR (.docx), RTM.csv, deviations.csv
//
// No result is typed here or in content.cjs: every Pass, Fail and NOT RUN comes from results.cjs, which reads the evidence files.
// Nothing here is an approval or a signature: the documents are drafts with blank approval tables.
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
module.exports = { rtmRows };

if (require.main === module) {
  const S = require('./docx_styles.cjs');
  const { Document, Packer, TableOfContents } = require('docx');
  const C = require('./content.cjs');
  const Res = require('./results.cjs');
  const T = Res.totals();
  const ROOT = path.join(__dirname, '..', '..');
  const OUT = path.join(__dirname, '..', 'docs'); fs.mkdirSync(OUT, { recursive: true });
  const EV = path.join(__dirname, '..', 'evidence');
  if (!T.junit) { console.error('no evidence: run bash validation/build/collect-evidence.sh first'); process.exit(1); }
  const EXEC_DATE = T.junit.match(/\d{4}-\d{2}-\d{2}/)[0];
  const iqFile = fs.readdirSync(EV).filter(x => x.startsWith('iq-sandbox-')).sort().pop();
  const iqLines = iqFile ? fs.readFileSync(path.join(EV, iqFile), 'utf8').split('\n').filter(l => l && !l.startsWith('#')) : [];
  const gitLine = iqLines.find(l => l.startsWith('git ')) || 'git unknown';

  const DOC = n => `VAL/EBR/${n}/001`;
  const hdr = (type, full, title) => S.titleBlock({ docType: type, docTypeFull: full, docNumber: DOC(type), title, version: '0.1 DRAFT', effectiveDate: 'Pending approval', system: C.SYSTEM });
  const toc = () => [S.h1('Contents'), new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' })];
  const draftBox = () => S.calloutBox('DRAFT. No approval signatures have been applied. The requirement identifiers were created by this package from the acceptance criteria of the roadmap (no approved URS existed); the System Owner must review and approve them. Technical execution recorded here was performed by an AI assistant (Claude); a qualified human reviewer must review the evidence and countersign.');
  const save = async (type, children) => {
    const doc = new Document({ styles: S.docDefaults(), numbering: S.numberingConfig(), sections: [{ properties: S.pageSetup(), headers: { default: S.docHeader(DOC(type), C.SYSTEM) }, footers: { default: S.docFooter(DOC(type)) }, children }] });
    fs.writeFileSync(path.join(OUT, `${DOC(type).replace(/\//g, '-')}.docx`), await Packer.toBuffer(doc));
  };
  const rows = rtmRows(C, Res);
  const resultOf = id => rows.find(r => r[0] === id)[5];
  const open = C.DEVIATIONS.filter(d => d[3] === 'OPEN');
  const count = t => Object.values(C.VERIF).filter(v => v.type === t).length;
  const pf = s => (s === 'Pass' ? 'P' : s === 'Fail' ? 'F' : 'NOT RUN');
  const evidenceList = [`${T.junit} (Vitest JUnit, ${T.tests} tests)`, `${T.e2e || 'no browser evidence'} (Playwright JUnit, ${T.e2eTotals.tests} tests)`, `${T.perf || 'no capacity result'} (capacity test)`, `validation/evidence/${iqFile || 'no IQ record'} (sandbox IQ record)`];

  (async () => {
    await save('VP', [...hdr('VP', 'Validation Plan', 'Validation Plan: B-Pharma EBR'), draftBox(), ...toc(),
      S.h1('1. Purpose'), S.p('This plan defines how the B-Pharma EBR (electronic batch record and logbooks, one web application for tablets and desktops on the factory server) is validated for GxP use following a GAMP 5 risk-based approach, with the controls expected by 21 CFR Part 11 and EU GMP Annex 11, and states what was and was not verified.'),
      S.h1('2. Scope'), ...S.bullets(['In scope: the requirements URS-E01-1 to URS-E21-4 (releases R1 to R3): platform, identity, audit trail, electronic signatures, the shell, configurable logbooks and equipment status, the master batch record, batch execution and exceptions, materials, the equipment interlock, review by exception, release and the certified copy, capacity, directory sign-on, the LIMS link, on-premises delivery and this package.', 'Out of scope: qualification of the server hardware, the network and the PostgreSQL server (site IT programme); the plant directory and the LIMS themselves.']),
      S.h1('3. System description'), S.p('A Node.js and Express server with a React client, served from the factory server and used from tablets and desktops while online (no offline recording). PostgreSQL holds every record; audit entries form a SHA-256 hash chain and the audit and signature tables are append-only by database triggers. Installed with Docker Compose or as a Windows service.'),
      S.h1('4. GAMP category'), S.p('Category 5, custom application. PostgreSQL, Node.js and the operating system are infrastructure (Category 1).'),
      S.h1('5. Approach'), S.p(`V-model: URS, risk assessment (GRA), FRS, IQ, OQ, traceability (RTM), summary (VSR). The URS rows are the acceptance criteria of the roadmap (docs/roadmap/roadmap.json). A test whose title carries the criterion id is a reference of that requirement; results are read from the evidence of an executed run (${EXEC_DATE}) and never typed. The gate node validation/build/check.cjs fails when a Critical or High requirement has no passed test and no open deviation, or when any referenced test failed or was not found.`),
      S.h1('6. Roles'), S.simpleTable(['Role', 'Responsibility', 'Name'], [['System Owner', 'Approves the URS, accepts residual risk', ''], ['QA', 'Approves the package, reviews deviations', ''], ['IT', 'IQ on the plant server, backups', ''], ['Technical execution', 'Automated OQ run (AI assistant, Claude)', 'Claude (AI)'], ['End users', 'PQ', '']], [2500, 5000, 2500]),
      S.h1('7. Deliverables'), S.simpleTable(['Document', 'Number'], [['Validation Plan', DOC('VP')], ['User Requirements Specification', DOC('URS')], ['GxP Risk Assessment', DOC('GRA')], ['Functional Requirements Specification', DOC('FRS')], ['Requirements Traceability Matrix (also RTM.csv)', DOC('RTM')], ['Installation Qualification', DOC('IQ')], ['Operational Qualification', DOC('OQ')], ['Validation Summary Report (deviations also in deviations.csv)', DOC('VSR')]], [6000, 4000]),
      S.h1('8. Acceptance criteria'), ...S.bullets(['Every Critical or High requirement has a passed executed test, or an open deviation that QA accepts in writing.', 'Every deviation is closed, or risk-accepted in writing, before GxP use.', 'IQ executed on the plant server; PQ performed by representative users.']),
      S.h1('9. Deviations and change control'), S.p('Deviations are numbered DEV-YYYY-MM-DD-NN and listed in the VSR and deviations.csv. After any change the evidence is collected again (bash validation/build/collect-evidence.sh) and the package regenerated; the build is identified by its git commit and hashes (IQ).'),
      S.h1('Approval'), S.approvalTable()]);

    const areas = [...new Set(C.URS.map(r => r[3]))];
    await save('URS', [...hdr('URS', 'User Requirements Specification', 'User Requirements Specification'), draftBox(), ...toc(),
      ...areas.flatMap(a => [S.h1(a), S.reqTable(C.URS.filter(r => r[3] === a).map(r => [r[0], r[1], r[2]]))]), S.h1('Approval'), S.approvalTable()]);

    const rpn = g => g[1] * g[2] * g[3];
    const level = n => (n >= 50 ? 'High' : n >= 15 ? 'Medium' : 'Low');
    await save('GRA', [...hdr('GRA', 'GxP Risk Assessment', 'GxP Risk Assessment'), draftBox(), ...toc(),
      S.h1('1. Method'), S.p('RPN = Severity x Likelihood x Detectability (each 1 to 5; Detectability 5 = hard to detect). RPN 50 or more High, 15 to 49 Medium, below 15 Low. The scores are the author\'s proposal and need QA confirmation.'),
      S.h1('2. Assessment'), S.simpleTable(['Area', 'S', 'L', 'D', 'RPN', 'Level', 'Rationale'], C.GRA.map(g => [g[0], String(g[1]), String(g[2]), String(g[3]), String(rpn(g)), level(rpn(g)), g[4]]), [2300, 450, 450, 450, 650, 800, 4900]),
      S.h1('3. Requirements per area'), ...S.bullets(C.GRA.map(g => `${g[0]}: ${g[5].length} requirements, ${level(rpn(g))}`)), S.h1('Approval'), S.approvalTable()]);

    await save('FRS', [...hdr('FRS', 'Functional Requirements Specification', 'Functional Requirements Specification'), draftBox(), ...toc(),
      S.h1('1. Architecture'), S.p('The server is the only authority for identity, role, state, record version, time and signatures; the client collects and displays. Each change runs in one database transaction with its audit entry.'),
      S.h1('2. Mechanisms'), S.simpleTable(['FRS', 'Mechanism', 'Addresses'], C.FRS.map(f => [f[0], f[1], f[2].join(', ')]), [900, 7000, 2100]), S.h1('Approval'), S.approvalTable()]);

    const q = x => `"${String(x).replace(/"/g, '""')}"`;
    fs.writeFileSync(path.join(OUT, 'RTM.csv'), ['URS,Priority,FRS,OQ,Type,Result,Executed references or note', ...rows.map(r => r.map(q).join(','))].join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'deviations.csv'), ['Deviation,Description,Action,Status', ...C.DEVIATIONS.map(d => d.map(q).join(','))].join('\n') + '\n');
    await save('RTM', [...hdr('RTM', 'Requirements Traceability Matrix', 'Requirements Traceability Matrix'), draftBox(),
      S.p('P = executed automated test; P* = partly supported by evidence from another machine or by reading, under an open deviation; GAP = not met, under an open deviation. Every result is looked up in the executed evidence; a test that cannot be found is NOT RUN. The executed test ids are in RTM.csv.'),
      S.simpleTable(['URS', 'Pri', 'FRS', 'OQ / type', 'Result'], rows.map(r => [r[0], r[1], r[2], `${r[3]} (${r[4]})`, r[5]]), [1300, 900, 1100, 1700, 5000]), S.h1('Approval'), S.approvalTable()]);

    await save('IQ', [...hdr('IQ', 'Installation Qualification', 'Installation Qualification'), draftBox(),
      S.calloutBox('IQ-S below was executed in a Linux DEVELOPMENT SANDBOX. It shows that the build and the database set-up work; it does NOT qualify the plant server. IQ-P must be executed on the plant server (DEV-2026-11-16-05).'),
      S.h1(`IQ-S Sandbox record (${EXEC_DATE})`), S.testCaseHeader('IQ-S-01', 'Record the environment, the migrations and the hashes of the build.', 'npm run build; fresh PostgreSQL database.'),
      S.testSteps(iqLines.map((l, i) => [String(i + 1), `Record ${l.split(' ')[0]}`, 'Value recorded', l, 'Recorded'])),
      S.p('Executed by: Claude (AI assistant), technical execution. Reviewer countersignature outstanding.', { italics: true }), S.execSignoffFilled('Claude (AI assistant)', EXEC_DATE, '', ''),
      S.h1('IQ-P Plant server (NOT EXECUTED)'), S.testCaseHeader('IQ-P-01', 'Install on the plant server and verify the installation.', 'Docker Compose (deploy/compose) or the Windows service (deploy/windows); a PostgreSQL 16 database.'),
      S.testSteps([['1', 'Record the release commit and the hashes of the image or build.', 'They match this record or the release record.', '', ''], ['2', 'Start the application; migrations apply; the first administrator signs in and must change the password.', 'As expected.', '', ''], ['3', 'As the application database role, try to UPDATE and DELETE audit_log.', 'Both refused.', '', ''], ['4', 'Run deploy/backup/backup.sh and restore into an empty database with restore.sh.', 'The restored audit chain verifies.', '', ''], ['5', 'Run npm run test:perf against the plant server behind the plant proxy.', 'PASS (DEV-2026-11-16-03).', '', '']]),
      S.execSignoff(), S.h1('Approval'), S.approvalTable()]);

    const oq = [...hdr('OQ', 'Operational Qualification', 'Operational Qualification'), draftBox(),
      S.calloutBox(`Executed on ${EXEC_DATE} (${gitLine}). Each step is a test of the automated suite on a fresh PostgreSQL database (${T.junit}: ${T.tests} tests, ${T.passed} passed, ${T.failed} failed, ${T.skipped} skipped), a browser test of the built application at tablet and desktop size (${T.e2e || 'not run'}: ${T.e2eTotals.passed} passed, ${T.e2eTotals.failed} failed), or the capacity test (${T.perf || 'not run'}). Each status is looked up in that evidence; a test not found is NOT RUN.`)];
    for (const [oqId, title, pre] of C.OQ) {
      const steps = [];
      for (const [urs, v] of Object.entries(C.VERIF)) {
        if (v.ref !== oqId) continue;
        for (const r of v.tests || []) {
          const s = Res.statusOfRef(r);
          steps.push([String(steps.length + 1), `Execute ${Res.refId(r)}${s.names && s.names.length > 1 ? ` (${s.names.length} runs)` : ''}`, `The behaviour required by ${urs} is demonstrated.`, urs, pf(s.status)]);
        }
        if (!(v.tests || []).length) steps.push([String(steps.length + 1), `${urs}: ${v.note || 'no executed test'}`, 'Requirement met.', v.deviation || '', v.type === 'GAP' ? 'NOT MET' : 'Not executed']);
      }
      oq.push(S.h1(`${oqId} ${title}`), S.testCaseHeader(oqId, title, pre), S.testSteps(steps), S.execSignoffFilled('Claude (AI assistant)', EXEC_DATE, '', ''));
    }
    oq.push(S.h1('Approval'), S.approvalTable());
    await save('OQ', oq);

    const notPassed = rows.filter(r => ['Fail', 'NOT RUN'].includes(r[5])).length;
    await save('VSR', [...hdr('VSR', 'Validation Summary Report', 'Validation Summary Report'), draftBox(), ...toc(),
      S.h1('1. Summary of execution'), S.simpleTable(['Item', 'Result'], [['Requirements', String(C.URS.length)], ['Critical or High', String(C.URS.filter(u => ['Critical', 'High'].includes(u[2])).length)], ['Verified by executed test (P)', String(count('P'))], ['Partly verified, under a deviation (P*)', String(count('P*'))], ['Not met (GAP)', String(count('GAP'))], ['Referenced test failed or not found', String(notPassed)], ['Automated suite (Vitest, PostgreSQL)', `${T.passed} passed / ${T.failed} failed / ${T.skipped} skipped of ${T.tests}`], ['Browser tests (Playwright, built application)', `${T.e2eTotals.passed} passed / ${T.e2eTotals.failed} failed of ${T.e2eTotals.tests}`], ['Capacity test', T.perfResult ? `${T.perfResult.verdict}: ${T.perfResult.users} users, ${T.perfResult.recordedInDatabase} of ${T.perfResult.expectedSteps} steps in the database, step p95 ${T.perfResult.byOperation.step_record.p95} ms` : 'not run'], ['Deviations', `${C.DEVIATIONS.length} raised, ${open.length} open`], ['Build', gitLine]], [4500, 5500]),
      S.h1('2. Evidence'), ...S.bullets(evidenceList),
      S.h1('3. Deviations'), S.simpleTable(['ID', 'Description', 'Action', 'Status'], C.DEVIATIONS, [1700, 4200, 3200, 900]),
      S.h1('4. Conclusion'), S.calloutBox(`CONDITIONAL. ${count('P')} of ${C.URS.length} requirements are verified by executed tests that passed${notPassed ? `; ${notPassed} referenced test(s) failed or were not found` : ''}. The system is NOT released for GxP use while ${open.length} deviation(s) are open: ${open.map(d => `${d[0]} (${d[1].replace(/\.$/, '')})`).join('; ')}. Release needs each closed or risk-accepted in writing by QA.`),
      S.h1('5. Statement on execution'), S.p(`Technical execution was performed by an AI assistant (Claude) on ${EXEC_DATE}. This report is a draft until a qualified reviewer has examined the evidence and signed.`),
      S.h1('Approval'), S.approvalTable()]);
    console.log(`built in ${path.relative(ROOT, OUT)}:\n${fs.readdirSync(OUT).sort().join('\n')}`);
  })().catch(e => { console.error(e); process.exit(1); });
}
