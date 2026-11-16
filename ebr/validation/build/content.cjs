// The one content source of the EBR validation package (shape of the kit of the gxp-software-factory skill).
//
// Requirements are NOT retyped: each URS row is an acceptance criterion of docs/roadmap/roadmap.json (gap E05, criterion 1 ->
// URS-E05-1), with the gap's GxP risk as its priority. Verifications are found, not typed: a test whose TITLE carries the criterion id
// (for example "... (E05#1)") is a reference of that requirement; EXTRA adds references for tests whose title does not carry it.
// Whether a reference passed is looked up in the executed evidence (results.cjs). Mechanisms (FRS), risk scores (GRA) and
// deviations are written here and are the author's proposal for QA review.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const roadmap = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/roadmap/roadmap.json'), 'utf8'));

const SYSTEM = 'B-Pharma EBR: electronic batch record and logbooks';
const PRIORITY = { High: 'High', Medium: 'Medium', Low: 'Low', Critical: 'Critical' };
const ursId = (gap, n) => `URS-${gap}-${n}`;

// URS: [id, text, priority, area]
const URS = roadmap.gaps.flatMap(g => g.acceptance.map((a, i) => [ursId(g.id, i + 1), a.replace(/`/g, ''), PRIORITY[g.gxpRisk] || 'Medium', `${g.id} ${g.title}`]));

// Test discovery: the titles of describe / it / test calls in the test sources.
const TEST_DIRS = ['tests/api', 'tests/deploy', 'tests/perf', 'tests/unit', 'tests/e2e'];
const TITLE = /\b(?:describe|it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
function discover() {
  const byTag = {};
  for (const d of TEST_DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => /\.(test|spec)\.ts$/.test(x)).sort()) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(TITLE)) for (const t of m[2].matchAll(/E(\d{2})#(\d+)/g)) {
        const id = ursId(`E${t[1]}`, t[2]);
        const ref = { file: `${d}/${f}`, match: `E${t[1]}#${t[2]}` };
        const list = (byTag[id] = byTag[id] || []);
        if (!list.some(r => r.file === ref.file)) list.push(ref);
      }
    }
  }
  return byTag;
}

// References for tests whose title does not carry the criterion id: { file, match: a fragment of the title }.
const EXTRA = {
  'URS-E01-1': [{ file: 'tests/api/core-migrate.test.ts', match: '' }, { file: 'tests/unit/harness.test.ts', match: 'E25#1' }],
  'URS-E08-3': [{ file: 'tests/e2e/mbr.spec.ts', match: '' }],
  'URS-E11-2': [{ file: 'tests/api/batch.test.ts', match: 'E11#1: a value outside its limits' }],   // the same test raises the deviation (line comment E11#2)
  'URS-E01-4': [{ ci: 'ci-workflow' }],
  'URS-E19-1': [{ ci: 'compose-up' }],
  'URS-E19-2': [{ ci: 'E24#1-installed' }, { ci: 'E24#1-signin' }],
  'URS-E24-1': [{ ci: 'E24#1-installed' }, { ci: 'E24#1-signin' }],
  'URS-E24-2': [{ ci: 'E24#2-restart' }, { ci: 'E24#2-uninstall' }],
  'URS-E16-1': [{ perf: 'verdict' }],
  'URS-E16-2': [{ perf: 'verdict' }],
};

// Requirements whose evidence is partly not an executed test of this package (P*) or that are not met (GAP), with the deviation.
const PARTIAL = {
  'URS-E01-4': { type: 'P*', deviation: 'DEV-2026-11-16-02', note: 'The workflow .github/workflows/ebr.yml runs lint and tests on GitHub Actions; its results are from another machine and are not produced by this package.' },
  'URS-E16-1': { type: 'P*', deviation: 'DEV-2026-11-16-03', note: 'The capacity test passed on a 4-core development machine shared by all parts; the reference server of the plant has not run it.' },
  'URS-E16-2': { type: 'P*', deviation: 'DEV-2026-11-16-03', note: 'Two instances behind a test proxy, one stopped halfway, no step lost; the plant proxy (deploy/proxy/nginx.conf) was not run.' },
  'URS-E19-1': { type: 'P*', deviation: 'DEV-2026-11-16-02', note: 'docker compose up and the first administrator sign-in run in the compose job of the CI workflow; there is no Docker on the machine that produced this package.' },
  'URS-E19-2': { type: 'P*', deviation: 'DEV-2026-11-16-02', note: 'The Windows service installation ran on a Windows Server 2025 runner of GitHub Actions (CI job windows, deploy/windows/ci-check.ps1); not yet on the plant server.' },
  'URS-E26-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E26-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E26-3': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E27-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E27-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E27-3': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E28-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E28-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E28-3': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E29-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E29-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E30-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E30-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E30-3': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E31-1': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E31-2': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E31-3': { type: 'GAP', deviation: 'DEV-2026-11-16-08', note: 'Release R5 is in progress: not built yet.' },
  'URS-E24-1': { type: 'P*', deviation: 'DEV-2026-11-16-02', note: 'CI job windows on Windows Server 2025 with PostgreSQL 16: installed, migrated, first administrator signs in (another machine).' },
  'URS-E24-2': { type: 'P*', deviation: 'DEV-2026-11-16-02', note: 'CI job windows: stop and start keep the data; uninstall removes the service and keeps the database (another machine).' },
};

// FRS: [id, mechanism (paths are checked to exist), [urs]]
const all = gap => URS.filter(u => u[0].startsWith(`URS-${gap}-`)).map(u => u[0]);
const FRS = [
  ['FRS-E01', 'A forward-only migration runner with a SHA-256 ledger under an advisory lock (server/migrate/runner.ts, migrations/); routes are mounted from the files of server/routes/ (server/routes/index.ts) with a route table snapshot (tests/route-table.json); the tests create a fresh PostgreSQL database per run (tests/helpers/global-setup.ts).', all('E01')],
  ['FRS-E02', 'Passwords hashed with scrypt, lockout after repeated failures, sessions stored in the database as SHA-256 of the token, TOTP (RFC 6238) for privileged roles (server/identity/); every route declares its permission and the authorizer refuses by default (server/core/route.ts, server/main.ts).', all('E02')],
  ['FRS-E03', 'writeAudit runs inside the transaction of the change (server/core/db.ts withTx, server/audit/); entries are append-only by trigger and chained by SHA-256 under an advisory transaction lock; verifyChain names the first altered entry (migrations/0020_audit.sql).', all('E03')],
  ['FRS-E04', 'A signature stores signer, meaning, server time, record version and the content hash; the password is re-entered and checked on the server; the two-person rule is enforced by the server (server/esign/).', all('E04')],
  ['FRS-E05', 'One React shell for tablet and desktop with touch-sized controls and an accessibility lint; a manifest and service worker that cache the shell only, never a record (client/).', all('E05')],
  ['FRS-E06', 'Equipment and rooms are master data retired, never deleted; logbook entries are signed, immutable, corrected by a new entry with a reason, and exported as a PDF (server/logbook/service.ts, server/logbook/pdf.ts).', all('E06')],
  ['FRS-E07', 'The status of an item is derived from its logbook entries, clean hold time and calibration due date at read time (server/logbook/status.ts); a status change by hand is a signed entry with a reason.', all('E07')],
  ['FRS-E08', 'The MBR design is validated on save: step types, limits, units, order and a safe formula parser that refuses a reference to a missing step (server/mbr/design.ts, server/mbr/formula.ts).', all('E08')],
  ['FRS-E09', 'MBR versions move draft, in review, approved, effective, retired; approval is a QA signature by someone other than the author; one effective version at a time (server/mbr/service.ts).', all('E09')],
  ['FRS-E10', 'Batches are created from an effective MBR version and keep its id; the engine enforces step order and phase start, stores performer, server time and version, and answers 409 to a stale version (server/batch/service.ts).', all('E10')],
  ['FRS-E11', 'A value outside limits is recorded and flagged as an exception that needs a comment and blocks closing; exceptions can carry a deviation number; calculated values are computed on the server (server/batch/service.ts, server/batch/steps.ts).', all('E11')],
  ['FRS-E12', 'Material steps accept a released, unexpired lot, check weights against tolerance, and reconcile materials and yield at batch end (server/materials/service.ts, server/steps/material/).', all('E12')],
  ['FRS-E13', 'Equipment steps are refused unless the item is clean and in calibration; use start and end write logbook entries with the batch number; release sets the item dirty (server/interlock/, server/steps/equipment/).', all('E13')],
  ['FRS-E14', 'Review by exception lists exceptions, corrections and late entries; completion is refused while an exception lacks a comment or a deviation link; review actions are signed (server/review/service.ts).', all('E14')],
  ['FRS-E15', 'Release or reject needs a QA signature after a complete review; the certified copy PDF is generated from the stored record and its SHA-256 is registered for later verification (server/review/service.ts).', all('E15')],
  ['FRS-E16', 'Stateless application instances with sessions in the database, behind a reverse proxy (deploy/proxy/nginx.conf); a database connection lost during a request fails that request only (server/core/db.ts); no user count anywhere (tests/perf/).', all('E16')],
  ['FRS-E17', 'Directory sign-in over LDAP with escaped user names, roles mapped from groups at each sign-in, local break-glass accounts when the directory is down (server/directory/).', all('E17')],
  ['FRS-E18', 'Sample steps request the sample in the LIMS with a stable external reference, looking it up before creating it, and keep the approved result on the batch (server/lims/client.ts, server/steps/sample/).', all('E18')],
  ['FRS-E19', 'A container image and compose file that migrate and create the first administrator once (Dockerfile, deploy/compose/docker-compose.yml); a Windows service script (deploy/windows/install-service.ps1); backup and restore scripts whose restore verifies the audit chain (deploy/backup/).', all('E19')],
  ['FRS-E20', 'This package: requirements read from the roadmap, references found in the test titles, results read from the executed evidence (validation/build/results.cjs), a gate that fails when a Critical or High requirement has no passed test and no open deviation (validation/build/check.cjs), documents generated by validation/build/build.cjs.', all('E20')],
  ['FRS-E22', 'Exports and certified copies are written by server/pdf/writer.ts: an embedded Unicode font (DejaVu Sans), Arabic joined by the font, each line in the order of the Unicode bidirectional algorithm, and each line carrying its stored text (ActualText) for copy and search; server/logbook/pdf.ts delegates to it.', all('E22')],
  ['FRS-E23', 'Any version is copied into a new master as version 1 in draft (server/mbr/copy.ts, POST /api/mbrs/:id/versions/:versionId/copy in server/routes/mbr-copy.ts): the design is checked again, based_on points to the source version, the audit entry names the source; the source is only read.', all('E23')],
  ['FRS-E24', 'The Windows service scripts: install-service.ps1 (pinned WinSW SHA-256, waits for the first start, shows the server error), uninstall-service.ps1 (database untouched), ci-check.ps1 (E24 end to end) in deploy/windows/.', all('E24')],
  ['FRS-E25', 'The global setup stops the run with the reason when PostgreSQL is not reachable (tests/helpers/global-setup.ts), and the helper refuses too (tests/helpers/db.ts); tests/unit/harness.test.ts runs the suite against an unreachable server.', all('E25')],
  ['FRS-E26', 'The client interface (client/).', all('E26')],
  ['FRS-E27', 'Sessions and sign-in (server/identity/sessions.ts, server/identity/index.ts).', all('E27')],
  ['FRS-E28', 'Logbook types and entries (server/logbook/service.ts).', all('E28')],
  ['FRS-E29', 'Yield at batch end (server/materials/service.ts).', all('E29')],
  ['FRS-E30', 'The LIMS client (server/lims/client.ts).', all('E30')],
  ['FRS-E31', 'Directory sign-in (server/directory/index.ts).', all('E31')],
  ['FRS-E21', 'Logbook types are versioned data with typed fields, approved by a QA signature from someone other than the author; entries are validated on the server against the type version they were written with (server/logbook/definition.ts, server/logbook/service.ts).', all('E21')],
];

// GRA: [area, Severity, Likelihood, Detectability, rationale, [urs]] (1-5 each; Detectability 5 = hard to detect)
const GRA = [
  ['Identity and access (E02, E17)', 5, 2, 3, 'A wrong person acting under another identity makes every record unattributable.', [...all('E02'), ...all('E17')]],
  ['Audit trail (E03)', 5, 2, 4, 'A change without its audit entry, or an altered entry, is hard to see afterwards.', all('E03')],
  ['Electronic signatures (E04)', 5, 2, 3, 'A signature not bound to the record version could be carried to a changed record.', all('E04')],
  ['Logbooks and equipment status (E06, E07, E21)', 4, 3, 3, 'A wrong status lets dirty or uncalibrated equipment be used in production.', [...all('E06'), ...all('E07'), ...all('E21')]],
  ['Master batch record (E08, E09)', 5, 2, 3, 'A wrong or unapproved recipe produces every batch made from it wrongly.', [...all('E08'), ...all('E09')]],
  ['Batch execution and exceptions (E10, E11)', 5, 3, 3, 'A value out of limits that is not flagged reaches release unnoticed.', [...all('E10'), ...all('E11')]],
  ['Materials and interlock (E12, E13)', 5, 3, 2, 'A wrong or expired lot, or unclean equipment, affects the product directly.', [...all('E12'), ...all('E13')]],
  ['Review and release (E14, E15)', 5, 2, 3, 'A batch released with an open exception, or a copy that differs from the record.', [...all('E14'), ...all('E15')]],
  ['Capacity, integration and delivery (E16, E18, E19)', 3, 3, 2, 'A lost step under load, a duplicated sample, or a restore that loses data.', [...all('E16'), ...all('E18'), ...all('E19')]],
  ['Platform and the package itself (E01, E05, E20, E25)', 3, 2, 2, 'A defect in the harness or the package hides defects elsewhere.', [...all('E01'), ...all('E05'), ...all('E20'), ...all('E25')]],
  ['Site settings and the directory (E27, E31)', 5, 2, 3, 'A weakened sign-in or session rule exposes every record; a wrong group map gives the wrong roles.', [...all('E27'), ...all('E31')]],
  ['Built-in logbooks and yield limits (E28, E29)', 4, 2, 3, 'An unreviewed definition records the wrong things; a wrong yield limit hides a loss.', [...all('E28'), ...all('E29')]],
  ['LIMS link and the interface language (E30, E26)', 3, 2, 2, 'A duplicated sample, or a label misread in another language.', [...all('E30'), ...all('E26')]],
  ['Exports and certified copies (E22)', 5, 3, 4, 'A character lost in a certified copy changes the record without anyone seeing it on screen.', all('E22')],
  ['Recipe copy and Windows installation (E23, E24)', 3, 2, 2, 'A copy that alters its source, or an installation that loses data on restart.', [...all('E23'), ...all('E24')]],
];

// Deviations: [id, description, action, status]
const DEVIATIONS = [
  ['DEV-2026-11-16-01', 'Part of a requirement is supported by reading the code, not by an executed test of this package (URS-E01-1).', 'Closed by tests/unit/harness.test.ts (E25#1): the suite run against an unreachable PostgreSQL exits non-zero with the reason and runs no test.', 'CLOSED'],
  ['DEV-2026-11-16-02', 'Evidence from GitHub Actions (another machine): the CI workflow, the docker compose job and the Windows service job (URS-E01-4, URS-E19-1, URS-E19-2, URS-E24-*).', 'Install on the plant server during IQ (Docker or the Windows service) and record it; the CI results stay supporting evidence.', 'OPEN'],
  ['DEV-2026-11-16-03', 'The capacity test ran on a development machine, not on the plant reference server (URS-E16-1, URS-E16-2).', 'Run npm run test:perf on the plant server and behind the plant proxy during OQ; record the numbers.', 'OPEN'],
  ['DEV-2026-11-16-04', 'The Windows service installer has not been run on a Windows Server (URS-E19-2).', 'Closed by the CI job windows (run 43872568098): install, migrate, sign in, restart, uninstall on Windows Server 2025; the plant server remains under DEV-2026-11-16-02.', 'CLOSED'],
  ['DEV-2026-11-16-05', 'IQ was executed in a development sandbox, not on the plant server; no end-user PQ was performed.', 'IQ on the plant server; PQ by representative users with the plant\'s own logbook types and MBRs.', 'OPEN'],
  ['DEV-2026-11-16-06', 'Directory sign-on and the LIMS link were tested against a test LDAP server and a stand-in LIMS, not the plant\'s directory and LIMS (URS-E17-*, URS-E18-*).', 'Repeat the directory and LIMS tests against the plant systems once their settings are decided (open items register).', 'OPEN'],
  ['DEV-2026-11-16-07', 'Release R4 (URS-E22 to URS-E25) is planned and not yet built.', 'Closed: R4 built; URS-E22, E23, E25 have executed tests, URS-E24 the CI evidence under DEV-2026-11-16-02.', 'CLOSED'],
  ['DEV-2026-11-16-08', 'Release R5 (URS-E26 to URS-E31) is planned and not yet built.', 'Build R5; each requirement moves to its executed tests.', 'OPEN'],
];

const VERIF = (() => {
  const found = discover();
  const out = {};
  for (const [id] of URS) {
    const p = PARTIAL[id] || {};
    const tests = [...(found[id] || []), ...(EXTRA[id] || [])];
    const type = p.type || (tests.length ? 'P' : 'GAP');
    const oq = `OQ-${id.split('-')[1]}`;
    out[id] = { type, ref: oq, tests, deviation: p.deviation, note: p.note };
  }
  return out;
})();

// OQ protocols: one per gap, its steps are the references of its requirements.
const OQ = roadmap.gaps.map(g => [`OQ-${g.id}`, g.title, 'Fresh PostgreSQL 16 database per run; the built application for the browser tests (tablet 820x1180 and desktop 1440x900).']);

module.exports = { SYSTEM, URS, FRS, GRA, DEVIATIONS, VERIF, OQ, discover };
