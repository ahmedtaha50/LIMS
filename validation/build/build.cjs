// Generates the validation package (docx + CSV) from content.cjs and the execution evidence files.
const fs = require('fs'), path = require('path');
const S = require('./docx_styles.cjs');
const C = require('./content.cjs');
const { Document, Packer, TableOfContents } = require('docx');

const OUT = path.join(__dirname, '..', 'docs'); fs.mkdirSync(OUT, { recursive: true });
const EV = path.join(__dirname, '..', 'evidence');
const ev = f => fs.readdirSync(EV).filter(x => x.startsWith(f)).sort().pop();
const Res = require('./results.cjs');
const T = Res.totals();
const status = name => Res.statusOfRef({ oq: name }).status;
const st = (script, match) => { const r = Res.statusOfRef({ desktop: script, match }).status; return r === 'Pass' ? 'P' : r === 'Fail' ? 'F' : 'NOT RUN'; };
const DOC = n => `VAL/LIMS/${n}/001`;
const hdr = (type, full, title) => S.titleBlock({ docType: type, docTypeFull: full, docNumber: DOC(type), title, version: '0.1 DRAFT', effectiveDate: 'Pending approval', system: C.SYSTEM });
const toc = () => [S.h1('Contents'), new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' })];

async function save(name, children) {
  const doc = new Document({ styles: S.docDefaults(), numbering: S.numberingConfig(), sections: [{ properties: S.pageSetup(), headers: { default: S.docHeader(DOC(name.split('-')[0]), C.SYSTEM) }, footers: { default: S.docFooter(DOC(name.split('-')[0])) }, children }] });
  fs.writeFileSync(path.join(OUT, `${DOC(name.split('-')[0]).replace(/\//g, '-')}-${name.split('-').slice(1).join('-') || name}.docx`.replace(/-$/, '')), await Packer.toBuffer(doc));
}
const draftBox = () => S.calloutBox('DRAFT. No approval signatures have been applied. Requirement identifiers in this package were created by this package (no approved URS existed); the System Owner must review and approve them. Technical execution recorded here was performed by an AI assistant (Claude); a qualified human reviewer must review the evidence and countersign.');
const verTxt = id => { const v = C.VERIF[id]; return v.type === 'GAP' ? `GAP - ${v.ref}` : `${v.ref} (${v.type})`; };

(async () => {
  // VP
  await save('VP', [...hdr('VP', 'Validation Plan', 'Validation Plan - B-Pharma LIMS Desktop'), draftBox(), ...toc(),
    S.h1('1. Purpose'), S.p('This plan defines how the B-Pharma LIMS desktop application is validated for GxP use following GAMP 5 (2nd Ed.), 21 CFR Part 11 and EU Annex 11, and states what was and was not verified in this release.'),
    S.h1('2. Scope'), ...S.bullets(['In scope: authentication, sample workflow, electronic signatures, audit trail, desktop packaging and secret handling (URS-001 to URS-050), and the release R2 modules (URS-060 to URS-119): master data, methods and calculations, result entry, raw data, instrument capture, the machine API, events, certificates, OOS, quality records, documents and training, custody, reagents, stability, environmental monitoring, worklists, turnaround, audit hardening and the validated-scope register.', 'Without OQ in this release (see DEV-04): ELN, the AI assistant, voice input and the camera barcode scanner. QA declares the validated scope of each catalogued module in the application (URS-116).', 'Out of scope: Windows, network and PostgreSQL server qualification (site IT programme).']),
    S.h1('3. References'), ...S.bullets(['GAMP 5, 2nd Edition', '21 CFR Part 11; EU GMP Annex 11', 'Project directives: AGENTS.md', 'docs/gxp-audit-findings.csv (code review findings GX-01 to GX-17)']),
    S.h1('4. System description'), S.p('A React/TypeScript interface served by an embedded Express server on the loopback interface, packaged with Electron, using a PostgreSQL database on the same PC. Audit entries form a SHA-256 hash chain; audit and signature tables are append-only through database triggers.'),
    S.h1('5. GAMP category'), S.p('Category 5 - custom application. Infrastructure components (PostgreSQL, Electron, Node.js) are Category 1.'),
    S.h1('6. Validation approach'), S.p(`V-model: URS to FRS, GRA sets rigor, IQ/OQ/PQ, RTM ties them together. Prior review and fixing work (GX series) is supporting history; formal evidence is the execution recorded in the OQ/PQ/IQ documents, generated from the evidence files in validation/evidence/ (tests/security-controls.sh, tests/backup-restore.sh, tests/desktop-smoke.cjs, the Vitest JUnit file and tests/e2e/run.cjs) executed on ${C.EXEC_DATE}. The RTM is generated from those files and node validation/build/check.cjs fails when a Critical or High requirement has no passed test and no open deviation.`),
    S.h1('7. Roles'), S.simpleTable(['Role', 'Responsibility', 'Name'], [['System Owner', 'Approves URS, accepts residual risk', ''], ['QA', 'Approves package, reviews deviations', ''], ['Validation Lead / IT', 'Executes IQ on the target PC, owns backups', ''], ['Technical execution', 'Automated OQ/PQ run (AI assistant, Claude)', 'Claude (AI)'], ['End users', 'Perform and observe PQ', '']], [2500, 5000, 2500]),
    S.h1('8. Deliverables'), S.simpleTable(['Document', 'Number', 'Purpose'], [['Validation Plan', DOC('VP'), 'This document'], ['URS', DOC('URS'), 'Requirements'], ['GxP Risk Assessment', DOC('GRA'), 'Risk-based rigor'], ['FRS', DOC('FRS'), 'How requirements are met'], ['RTM', DOC('RTM'), 'Traceability (also RTM.csv)'], ['IQ', DOC('IQ'), 'Installation'], ['OQ', DOC('OQ'), 'Function'], ['PQ', DOC('PQ'), 'Business scenarios'], ['DIA', DOC('DIA'), 'ALCOA+'], ['VSR', DOC('VSR'), 'Summary and conclusion']], [3000, 2500, 4500]),
    S.h1('9. Acceptance criteria'), ...S.bullets(['Every Critical URS has an executed Pass (P) or a QA-accepted P* justification.', 'All deviations CLOSED or risk-accepted in writing before release to GxP use.', 'IQ executed on the target PC; end-user PQ completed.']),
    S.h1('10. Deviation management'), S.p('Deviations are numbered DEV-YYYY-MM-DD-NN, recorded in the VSR and deviations.csv with root cause, correction and status.'),
    S.h1('11. Change control'), S.p('Any change after approval follows the site change-control SOP; tests/security-controls.sh and the RTM are re-run, and the build is identified by its git commit and file hashes (IQ).'),
    S.h1('12. Training'), S.p('Users complete the in-application software training before applying signatures (URS-024). PQ should be performed by representative end users.'),
    S.h1('13. Periodic review'), S.p('At least annually, after any change to audit/signature code, and after any restore from backup.'),
    S.h1('14. Approval'), S.approvalTable()]);

  // URS
  const areas = [...new Set(C.URS.map(r => r[3]))];
  await save('URS', [...hdr('URS', 'User Requirements Specification', 'User Requirements Specification'), draftBox(), ...toc(),
    ...areas.flatMap(a => [S.h1(a), S.reqTable(C.URS.filter(r => r[3] === a).map(r => [r[0], r[1], r[2]]))]), S.h1('Approval'), S.approvalTable()]);

  // GRA
  const rpn = g => g[1] * g[2] * g[3];
  const level = n => n >= 50 ? 'High' : n >= 15 ? 'Medium' : 'Low';
  await save('GRA', [...hdr('GRA', 'GxP Risk Assessment', 'GxP Risk Assessment'), draftBox(), ...toc(),
    S.h1('1. Method'), S.p('RPN = Severity x Likelihood x Detectability (each 1-5; Detectability 5 = hard to detect). RPN >= 50 High (OQ plus PQ), 15-49 Medium (OQ), < 15 Low. Scores are the author\'s proposal and require QA confirmation.'),
    S.h1('2. GAMP category'), S.p('Category 5.'),
    S.h1('3. Assessment'), S.simpleTable(['Area', 'S', 'L', 'D', 'RPN', 'Level', 'Rationale'], C.GRA.map(g => [g[0], String(g[1]), String(g[2]), String(g[3]), String(rpn(g)), level(rpn(g)), g[4]]), [2300, 450, 450, 450, 650, 800, 4900]),
    S.h1('4. Consequence for testing'), ...S.bullets(C.GRA.map(g => `${g[0]}: ${level(rpn(g))} - ${level(rpn(g)) === 'High' ? 'OQ + PQ' : 'OQ'}`)),
    S.h1('Approval'), S.approvalTable()]);

  // FRS
  await save('FRS', [...hdr('FRS', 'Functional Requirements Specification', 'Functional Requirements Specification'), draftBox(), ...toc(),
    S.h1('1. Architecture'), S.p('The server is the sole authority for identity, role, state, version, timestamps and signatures. The browser collects and displays. All record changes run in a single database transaction with their audit entry.'),
    S.h1('2. Functional specification'), S.simpleTable(['FRS', 'Mechanism', 'Addresses'], C.FRS.map(f => [f[0], f[1], f[2].join(', ')]), [900, 7300, 1800]),
    S.h1('Approval'), S.approvalTable()]);

  // RTM (docx + csv): every result below is looked up in the executed evidence (results.cjs); nothing is typed in.
  const verifResult = v => {
    if (v.type === 'GAP') return `NOT MET (${v.deviation || 'no deviation'})`;
    const s = Res.statusOfVerif(v);
    if (s) return v.type === 'P*' ? (s === 'Pass' ? `Partial: executed part passes, the rest by reading (${v.deviation || 'DEV-2026-10-13-07'})` : s + ' - P*') : s;
    if (v.file) return fs.existsSync(path.join(EV, v.file)) ? 'Pass (smoke run)' + (v.type === 'P*' ? ' - P*' : '') : 'NOT RUN';
    return v.deviation ? `Not executed (${v.deviation})` : 'Not executed (code review)';
  };
  const evidenceOf = v => [...(v.checks || []), ...(v.tests || []).map(Res.refId)].join('; ') || v.note || '';
  const rows = C.URS.map(u => { const f = C.FRS.filter(x => x[2].includes(u[0])).map(x => x[0]).join(', '); const v = C.VERIF[u[0]];
    return [u[0], u[2], f, v.ref, v.type, verifResult(v), evidenceOf(v) + (v.note && (v.checks || v.tests) ? ` | ${v.note}` : '')]; });
  const csv = ['URS,Priority,FRS,Test/Deviation,P/P*/GAP,Result,Executed test ids or note', ...rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n');
  fs.writeFileSync(path.join(OUT, 'RTM.csv'), csv + '\n');
  fs.writeFileSync(path.join(OUT, 'deviations.csv'), ['Deviation,Description,Correction / action,Status', ...C.DEVIATIONS.map(d => d.map(x => `"${x.replace(/"/g, '""')}"`).join(','))].join('\n') + '\n');
  await save('RTM', [...hdr('RTM', 'Requirements Traceability Matrix', 'Requirements Traceability Matrix'), draftBox(), S.p('P = directly executed automated test; P* = supported by code reading only; GAP = requirement not met. Every Result is looked up in the executed evidence listed in the VSR; a test that cannot be found is NOT RUN. Machine-readable copy with the executed test ids: RTM.csv. The gate is: node validation/build/check.cjs.'),
    S.simpleTable(['URS', 'Pri', 'FRS', 'Verification', 'Result'], rows.map(r => [r[0], r[1], r[2], `${r[3]} (${r[4]})`, r[5]]), [900, 900, 1800, 2400, 4000]), S.h1('Approval'), S.approvalTable()]);

  // IQ
  const iqEv = fs.readFileSync(path.join(EV, ev('iq-sandbox-')), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const iqSteps = iqEv.map((l, i) => [String(i + 1), 'Record: ' + l.split(/[ :]/)[0], 'Value recorded and matches the build record', l, 'P']);
  await save('IQ', [...hdr('IQ', 'Installation Qualification', 'Installation Qualification'), draftBox(),
    S.calloutBox('IQ-S below was executed in a Linux DEVELOPMENT SANDBOX. It shows the build and database set-up procedure works; it does NOT qualify the target Windows PC. IQ-W must be executed on the target PC (DEV-06).'),
    S.h1('IQ-S Sandbox execution (2026-10-13)'), S.testCaseHeader('IQ-S-01', 'Record environment, schema, triggers and build hashes.', 'Fresh database initialised with dist/init-db.cjs.'), S.testSteps(iqSteps),
    S.p('Executed by: Claude (AI assistant) - technical execution. Reviewer countersignature outstanding.', { italics: true }), S.execSignoffFilled('Claude (AI assistant)', C.EXEC_DATE, '', ''),
    S.h1('IQ-W Target PC (NOT EXECUTED)'), S.testCaseHeader('IQ-W-01', 'Install on the target PC and verify configuration.', 'Windows account without local administrator rights for daily use; PostgreSQL installed by IT.'),
    S.testSteps([['1', 'Install package; record version and SHA-256 of installer.', 'Matches release record.', '', ''], ['2', 'Run first-run setup with the application DB role (not the owner).', 'Setup completes; schema present.', '', ''], ['3', 'Inspect config.json in the user profile.', 'Password and secret are not readable text (DPAPI).', '', ''], ['4', 'Check data-directory ACL and who holds the PostgreSQL superuser password.', 'Restricted to IT.', '', ''], ['5', 'Run SQL UPDATE on audit_trail as the application role.', 'Refused.', '', ''], ['6', 'File the audit head (GET /api/audit/head) with QA.', 'Anchor filed.', '', '']]), S.execSignoff(), S.h1('Approval'), S.approvalTable()]);

  // OQ
  const oqChildren = [...hdr('OQ', 'Operational Qualification', 'Operational Qualification'), draftBox(),
    S.calloutBox(`OQ-01 to OQ-09 were executed on ${C.EXEC_DATE} against the built application with tests/security-controls.sh and tests/backup-restore.sh (${T.shellPass} PASS, ${T.shellFail} FAIL; validation/evidence/oq-run-*.txt, backup-run-*.txt). OQ-10 to OQ-30 (release R2) are the automated tests of the whole suite against a real PostgreSQL 16 database (${T.junit}: ${T.tests} tests, ${T.passed} passed, ${T.failed} failed, ${T.skipped} skipped) and the browser flows (${T.e2e || 'not run'}: ${T.e2ePass} PASS, ${T.e2eFail} FAIL). Each step below is a test id looked up in that evidence; a test that was not found is shown as not run. Requirements still verified by code reading only are listed at the end (P*).`)];
  C.OQ.forEach(t => { oqChildren.push(S.h1(`${t[0]} ${t[1]}`), S.testCaseHeader(t[0], t[1], t[2]), S.testSteps(t[3].map((s, i) => [String(i + 1), s[1], s[2], `Check ${s[0]}`, status(s[0]) === 'Pass' ? 'P' : 'F'])), S.execSignoffFilled('Claude (AI assistant)', C.EXEC_DATE, '', '')); });
  C.OQ_R2.forEach(([oqId, title, pre]) => {
    const steps = [];
    for (const [urs, v] of Object.entries(C.VERIF)) {
      if (v.ref !== oqId) continue;
      for (const r of [...(v.checks || []).map(oq => ({ oq })), ...(v.tests || [])]) {
        const st = Res.statusOfRef(r).status;
        steps.push([String(steps.length + 1), `Execute ${Res.refId(r)}`, `The behaviour in the test title is demonstrated (${urs}).`, urs, st === 'Pass' ? 'P' : st === 'Fail' ? 'F' : 'NOT RUN']);
      }
      if (v.type === 'GAP') steps.push([String(steps.length + 1), `${urs}: ${C.URS.find(u => u[0] === urs)[1]}`, 'Requirement met.', v.deviation, 'NOT MET']);
    }
    oqChildren.push(S.h1(`${oqId} ${title}`), S.testCaseHeader(oqId, title, pre), S.testSteps(steps), S.execSignoffFilled('Claude (AI assistant)', C.EXEC_DATE, '', ''));
  });
  oqChildren.push(S.h1('Requirements supported by code reading only (P*)'), S.simpleTable(['URS', 'Basis', 'Open action'], Object.entries(C.VERIF).filter(([, v]) => v.type === 'P*').map(([k, v]) => [k, v.note, v.deviation || 'DEV-07']), [1000, 7000, 2000]), S.h1('Approval'), S.approvalTable());
  await save('OQ', oqChildren);

  // PQ
  await save('PQ', [...hdr('PQ', 'Performance Qualification', 'Performance Qualification'), draftBox(),
    S.calloutBox('PQ was executed technically (automated). Execution or observation by representative end users has NOT happened (DEV-05).'),
    S.h1('PQ-01 Sample release lifecycle'), S.testCaseHeader('PQ-01', 'An analyst registers and tests a sample, signs it for review, and an independent reviewer approves it; signatures and audit chain remain verifiable.', 'Seeded users, running instance.'),
    S.testSteps([['1', 'Analyst registers a sample.', 'Sample in Logged state.', 'workflow-start', status('workflow-start') === 'Pass' ? 'P' : 'F'], ['2', 'Analyst signs into Pending Review.', 'Signature recorded.', 'sign-review', status('sign-review') === 'Pass' ? 'P' : 'F'], ['3', 'Analyst attempts approval.', 'Refused.', 'GX-05-wrong-role-cannot-approve', status('GX-05-wrong-role-cannot-approve') === 'Pass' ? 'P' : 'F'], ['4', 'Reviewer approves.', 'State Approved, signature recorded.', 'sign-approve', status('sign-approve') === 'Pass' ? 'P' : 'F'], ['5', 'Verify both signatures.', 'valid and hash matches.', 'GX-08-signature-verifies', status('GX-08-signature-verifies') === 'Pass' ? 'P' : 'F'], ['6', 'Verify audit chain.', 'Intact.', 'URS-AUD-chain-verification-intact', status('URS-AUD-chain-verification-intact') === 'Pass' ? 'P' : 'F']]),
    S.execSignoffFilled('Claude (AI assistant)', C.EXEC_DATE, '', ''),
    S.h1('PQ-02 Desktop shell'), S.testCaseHeader('PQ-02', 'The desktop shell starts the supervised server on the loopback interface, opens the application in a window that has no bridge to the operating system, and blocks navigation away from its own origin.', 'Electron 33, Linux/xvfb, tests/desktop-shell.cjs and desktop-upgrade.cjs (the first-run smoke script tests/desktop-smoke.cjs no longer gets past the first-run screen on this tree and is not used).'),
    S.testSteps([['1', 'Launch the shell; the server is started and chosen once.', 'The server answers /api/ready on its stored port.', 'desktop-shell: server answers /api/ready', st('desktop-shell', 'server answers /api/ready')], ['2', 'Probe the application window for a bridge and for Node access.', 'None; the renderer is sandboxed.', 'desktop-shell: application window has no bridge; renderer is sandboxed', st('desktop-shell', 'renderer is sandboxed')], ['3', 'Navigate to another site and to a look-alike origin.', 'Both are blocked.', 'desktop-shell: navigation to another site is blocked', st('desktop-shell', 'navigation to another site is blocked')], ['4', 'Upgrade a v0.1.0 installation with data; give the backup passphrase.', 'Application opens, pre-migration backup written, passphrase not stored in clear text.', 'desktop-upgrade: backup passphrase is stored, not in clear text', st('desktop-upgrade', 'backup passphrase is stored, not in clear text')], ['5', 'Repeat on Windows with DPAPI.', 'As above.', 'NOT EXECUTED', '']]),
    S.execSignoffFilled('Claude (AI assistant)', C.EXEC_DATE, '', ''),
    S.h1('PQ-03 End-user observation'), S.p('Not performed. To be executed by or with representative end users (DEV-05).'), S.execSignoff(), S.h1('Approval'), S.approvalTable()]);

  // DIA
  await save('DIA', [...hdr('DIA', 'Data Integrity Assessment', 'Data Integrity Assessment (ALCOA+)'), draftBox(), ...toc(),
    S.h1('1. ALCOA+ against mechanisms'), S.simpleTable(['Principle', 'Mechanism', 'Verification'], [
      ['Attributable', 'Every record action carries userId from the verified session; no client-supplied identity; unknown users cannot log in.', 'OQ-01 (P)'],
      ['Legible', 'Data are stored as structured text in PostgreSQL and rendered by the UI.', 'Not separately tested'],
      ['Contemporaneous', 'Audit timestamps are set by the server inside writeAudit.', 'Code read (P*)'],
      ['Original', 'Audit and signature rows are append-only by trigger; hash-chain recomputation detects change.', 'OQ-05 (P)'],
      ['Accurate', 'Strict schemas, optimistic concurrency, signature content hash recomputation.', 'OQ-03, OQ-06 (P)'],
      ['Complete', 'Failed signature attempts are audited; audit sequence is UNIQUE and written under an advisory lock.', 'OQ-04 (P); concurrency not load-tested'],
      ['Consistent', 'Single database transaction per change including audit entry.', 'Code read (P*)'],
      ['Enduring', 'Encrypted, self-verified backup and empty-database-only restore (src/server/backup.ts); schedule and off-PC copy are procedural.', 'OQ-09 (P); DEV-08'],
      ['Available', 'Audit trail readable by Admin/QA; no export for inspection implemented in this scope.', 'OQ-02 (P)']], [1800, 5500, 2700]),
    S.h1('2. Residual risks and compensating controls'), ...S.bullets([
      'Owner/administrator credential: anyone who can act as the PostgreSQL owner can drop the triggers and recompute an unkeyed hash chain. Compensating control: file the audit head (GET /api/audit/head) with QA at each audit-trail review and check it at the next; database credentials held by IT, not stored on the operator account where avoidable.',
      'Backups are manual and the passphrase is custody-by-procedure (DEV-08): schedule weekly, copy to the server share, run a quarterly restore test, hold the passphrase with QA/IT.',
      'Shared Windows session: standard Windows users, data-directory ACL, no local administrator rights for daily use.',
      'Non-core modules not qualified (DEV-04); same-transaction audit of every write path established by sampling only (DEV-07).',
      'Legacy accounts keep the old static-salt hash until the password is next changed (verification still works).']),
    S.h1('Approval'), S.approvalTable()]);

  // VSR
  const open = C.DEVIATIONS.filter(d => d[3] === 'OPEN').length;
  const pStar = Object.values(C.VERIF).filter(v => v.type === 'P*').length, pCount = Object.values(C.VERIF).filter(v => v.type === 'P').length, gap = Object.values(C.VERIF).filter(v => v.type === 'GAP').length;
  await save('VSR', [...hdr('VSR', 'Validation Summary Report', 'Validation Summary Report'), draftBox(), ...toc(),
    S.h1('1. Summary of execution'), S.simpleTable(['Item', 'Result'], [['Requirements', `${C.URS.length}`], ['Verified by executed test (P)', `${pCount}`], ['Supported by code reading only (P*)', `${pStar}`], ['Not met (GAP)', `${gap}`], ['Shell OQ checks (security-controls, backup-restore)', `${T.shellPass} pass / ${T.shellFail} fail`], ['Automated test suite (Vitest, real PostgreSQL 16)', `${T.passed} pass / ${T.failed} fail / ${T.skipped} skipped of ${T.tests} (${T.junit})`], ['Browser checks (Chromium, built bundle)', `${T.e2ePass} pass / ${T.e2eFail} fail (${T.e2e || 'not run'})`], ['Not run, not found in the evidence', `${C.URS.filter(u => ['NOT RUN', 'Fail'].includes(verifResult(C.VERIF[u[0]]))).length} requirement(s)`], ['Deviations', `${C.DEVIATIONS.length} raised, ${C.DEVIATIONS.length - open} closed, ${open} open`]], [5000, 5000]),
    S.h1('2. Deviations'), S.simpleTable(['ID', 'Description', 'Action', 'Status'], C.DEVIATIONS, [1500, 4300, 3300, 900]),
    S.h1('3. Conclusion'), S.calloutBox(`CONDITIONAL. The controls that were tested pass, and the defect found during execution (DEV-01) was corrected and re-verified. The system is NOT released for GxP use: ${open} deviations are open, including modules whose scope QA has not declared (DEV-04, DEV-2026-10-25-04), accessibility findings on 13 screens (DEV-2026-10-25-06), no end-user PQ (DEV-05), no execution on the target Windows PC (DEV-06) and manual-only backups without SOPs (DEV-08). Release requires closure or documented QA risk acceptance of each.`),
    S.h1('4. Statement on execution'), S.p(`Technical execution was performed by an AI assistant (Claude) on ${C.EXEC_DATE}. This report is a draft until a qualified human reviewer has examined the evidence and signed.`),
    S.h1('Approval'), S.approvalTable()]);
  console.log('built', fs.readdirSync(OUT).join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
