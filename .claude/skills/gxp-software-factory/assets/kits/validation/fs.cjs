// Generates the Functional Specification (VAL/LIMS/FS/001) of the whole system from the repository, not from typed text:
//   requirements and mechanisms   validation/build/content*.cjs (the same source as the URS, FRS and RTM)
//   permissions and their routes  docs/permission-matrix.csv (generated from src/lib/permissions.ts and the route table)
//   API surface                   tests/route-table.json
//   signature meanings, tables, record states, scheduled jobs   validation/build/data/*.json (validation/build/fs-data.sh refreshes them)
//   open deviations               content*.cjs
//   node validation/build/fs.cjs
const fs = require('fs'), path = require('path');
const S = require('./docx_styles.cjs');
const C = require('./content.cjs');
const { Document, Packer, TableOfContents } = require('docx');

const ROOT = path.join(__dirname, '..', '..');
const data = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
const MEANINGS = data('signature-meanings.json'), TABLES = data('tables.json'), STATES = data('states.json'), JOBS = data('schedules.json');
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'route-table.json'), 'utf8')).routes;

/** RFC 4180 reader for the permission matrix (quoted fields hold commas). */
function csv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const PERMS = csv(fs.readFileSync(path.join(ROOT, 'docs', 'permission-matrix.csv'), 'utf8')).slice(1).filter(r => r.length >= 8)
  .map(r => ({ id: r[0], category: r[1], text: r[2], roles: ['Admin', 'QA', 'Reviewer', 'Analyst'].filter((_, i) => r[3 + i] === 'X'), routes: r[7].split(';').map(x => x.trim()).filter(Boolean) }));

// The permission categories shown under each functional area (a category is shown once; the whole matrix is Appendix A).
const AREA_PERMS = {
  'Access control': ['Administration', 'Authorisation'], 'Workflow': ['Samples', 'Batch records'], 'Audit trail': ['Audit'],
  'Master data': ['Master data'], 'Methods and calculations': ['Methods', 'Specifications'], 'Instrument data': ['Equipment'],
  'Certificates and reports': ['Reports'], 'OOS investigation': ['OOS'], 'Quality management': ['Quality management'],
  'Documents and training': ['Documents', 'Training'], 'Custody and labels': ['Custody'], 'Stability': ['Stability'],
  'Environmental monitoring': ['Environmental'], 'Worklists': ['Worklists'], 'Validated scope': ['Validation'], 'SPC and trending': ['Trending'],
  'Directory sign-on': ['Directory'], 'Periodic review and archive': ['Periodic review', 'Archive'],
};
const shown = new Set(Object.values(AREA_PERMS).flat());
const DOCNO = 'VAL/LIMS/FS/001';
const permRows = list => list.map(p => [p.id, p.text, p.roles.join(', '), p.routes.join('; ')]);
const routePrefix = r => r.path.replace(/^\/api\//, '').split('/')[0];

(async () => {
  const areas = [...new Set(C.URS.map(r => r[3]))];
  const open = C.DEVIATIONS.filter(d => d[3] === 'OPEN');
  const groups = {}; for (const r of ROUTES) (groups[routePrefix(r)] = groups[routePrefix(r)] || []).push(r);
  const children = [
    ...S.titleBlock({ docType: 'FS', docTypeFull: 'Functional Specification', docNumber: DOCNO, title: 'Functional Specification - B-Pharma LIMS', version: '0.1 DRAFT', effectiveDate: 'Pending approval', system: C.SYSTEM }),
    S.calloutBox('DRAFT. No approval signatures have been applied. This document is generated from the source repository (requirements, permission matrix, route table, signature catalogue, database schema); it describes what the software does at the commit it was generated from. Requirement identifiers were created by the validation package and need System Owner approval. The Arabic interface wording is a draft (DEV-2026-10-26-05).'),
    S.h1('Contents'), new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),

    S.h1('1. Purpose and scope'),
    S.p('This Functional Specification states, per functional area, what the B-Pharma LIMS does: the functions, who may use them, the electronic signatures they require, the interfaces and the records they keep. It covers releases R1, R2 and R3.'),
    S.p(`It sits between the User Requirements Specification (${'VAL/LIMS/URS/001'}, ${C.URS.length} requirements) and the design-level mechanism list (VAL/LIMS/FRS/001, ${C.FRS.length} mechanisms). Verification is in the RTM (VAL/LIMS/RTM/001): this document states no test result.`),
    ...S.bullets(['Intended use: quality-control laboratory records for pharmaceutical manufacture under GxP (21 CFR Part 11, EU GMP Annex 11, ALCOA+).', 'Deployment: a Windows desktop installer (Electron) with an embedded server on the loopback interface and a PostgreSQL database, built in or existing.', 'Not covered: site procedures (SOPs), infrastructure qualification, and the modules listed in section 6 as outside the validated scope until QA declares them.']),

    S.h1('2. System overview'),
    S.h2('2.1 Architecture'),
    ...S.bullets(['Interface: React single-page application (English and Arabic, right-to-left), served by the embedded server; no direct database access.', 'Server: Express (Node.js). It is the sole authority for identity, role, record state, version, timestamps and signatures; the browser collects and displays.', 'Database: PostgreSQL 16 with forward-only, versioned migrations; audit and signature tables are append-only by trigger.', 'Desktop shell: Electron; checks the installed files against the release manifest at every start and supervises the server and, in built-in mode, the database.', `Size: ${ROUTES.length} API routes, ${PERMS.length} permissions, ${MEANINGS.length} signature meanings, ${TABLES.length} database tables, ${JOBS.length} scheduled jobs.`]),
    S.h2('2.2 Roles'),
    S.simpleTable(['Role', 'Purpose', 'Permissions held'], ['Admin', 'QA', 'Reviewer', 'Analyst'].map(r => [r, { Admin: 'System administration: users, settings, backups. Not a quality decision maker by itself.', QA: 'Quality unit: approvals, investigations, periodic review, audit-trail review.', Reviewer: 'Independent second-person review of results.', Analyst: 'Registers samples, performs tests, enters results.' }[r], String(PERMS.filter(p => p.roles.includes(r)).length)]), [1500, 6500, 2000]),
    S.p('Role membership grants permissions through the role-permission table; a change of a grant needs an electronic signature. Machine clients (API v1) hold scopes, not roles, and can never sign.'),
    S.h2('2.3 Rules that apply to every function'),
    ...S.bullets([
      'Attribution: the acting user is taken from the verified session, never from the request body.',
      'Audit trail: every change of a record writes its audit entry in the same database transaction (who, when, what, old value, new value, reason); the trail is a SHA-256 hash chain.',
      'Electronic signature: the signer re-enters the password (and authenticator code when enrolled); the signature is bound to the record, its version and a catalogued meaning.',
      'Optimistic concurrency: a write names the version it read; a stale version is refused (409) and nothing is changed.',
      'Input validation: strict schemas; unknown fields and server-owned fields are refused.',
      'Segregation of duties: a person does not approve what that person entered; enforced by the server.',
      'No silent failure: a refusal states the reason; background jobs record their outcome.',
      'Time: timestamps are set by the server in UTC; a clock found set back blocks signing until QA reviews it.']),

    S.h1('3. Common functions'),
    S.h2('3.1 Sample life cycle'),
    S.simpleTable(['From', 'To', 'Roles', 'Signature', 'Independent person'], STATES.sample.map(t => [t.from, t.to, t.roles.join(', '), t.signature ? 'Yes' : 'No', t.sod ? 'Yes (not the person who registered it)' : '-']), [1700, 1700, 2600, 1100, 2900]),
    S.p('A transition is refused while a blocker stands: an open OOS investigation, an unreviewed instrument capture, a failed review-checklist item, a missing suitability run, an uncalibrated instrument, an unqualified analyst.'),
    S.h2('3.2 States of other records'),
    S.simpleTable(['Record', 'States', 'Initial', 'Final (no further change)'], Object.entries(STATES.entities).map(([k, m]) => [k, m.states.join(', '), m.initial, m.terminal.join(', ')]), [1800, 4200, 1700, 2300]),
    S.h2('3.3 Electronic signature meanings'),
    S.p('A signature always carries one of the catalogued meanings below; the roles are those allowed to apply it.'),
    S.simpleTable(['Code', 'Printed meaning', 'Roles', 'Reason required'], MEANINGS.map(m => [m.code, m.text, m.roles.join(', '), m.reason ? 'Yes' : 'No']), [2400, 4700, 1700, 1200]),
    S.h2('3.4 Scheduled functions'),
    S.simpleTable(['Job', 'Schedule (cron, UTC)', 'What it does'], JOBS.map(j => [j.name, j.cron, j.description]), [2000, 1800, 6200]),

    S.h1('4. Functional areas'),
    S.p('Each area lists its user requirements, the functions that meet them (with the FRS identifier) and, where the area owns permissions, the permissions with the roles that hold them and the API routes they open.'),
  ];
  areas.forEach((a, i) => {
    const urs = C.URS.filter(r => r[3] === a), ids = new Set(urs.map(u => u[0]));
    const frs = C.FRS.filter(f => f[2].some(x => ids.has(x)));
    children.push(S.h2(`4.${i + 1} ${a}`), S.h3('Requirements'), S.reqTable(urs.map(r => [r[0], r[1], r[2]])),
      S.h3('Functions'), S.simpleTable(['FRS', 'Function and mechanism', 'Meets'], frs.map(f => [f[0], f[1], f[2].filter(x => ids.has(x)).join(', ')]), [900, 7600, 1500]));
    const cats = AREA_PERMS[a] || [];
    if (cats.length) children.push(S.h3('Permissions and routes'), S.simpleTable(['Permission', 'Allows', 'Roles', 'Routes'], permRows(PERMS.filter(p => cats.includes(p.category))), [1900, 2700, 1500, 3900]));
  });

  const rest = [...new Set(PERMS.map(p => p.category))].filter(c => !shown.has(c));
  children.push(
    S.h1('5. Interfaces'),
    S.h2('5.1 Interactive API'), S.p(`${ROUTES.length} routes under /api, all but ${ROUTES.filter(r => !r.auth).length} behind a session. Every route has a rule in the route table (deny by default) and is checked by a test.`),
    S.simpleTable(['Route group (/api/...)', 'Routes', 'Methods'], Object.entries(groups).sort((x, y) => y[1].length - x[1].length).map(([k, v]) => [k, String(v.length), [...new Set(v.map(r => r.method))].sort().join(', ')]), [4500, 1500, 4000]),
    S.h2('5.2 Other interfaces'),
    ...S.bullets(['Machine API v1 (/api/v1): scoped tokens shown once and stored as a hash, idempotency keys, batches of up to 500 written all or nothing, OpenAPI 3.1 contract; never reaches a signing route.', 'Instrument files: a watched folder and upload; each file is registered with its SHA-256; values become results only when a named analyst accepts them.', 'Events: notifications in the application, a socket per session, and webhooks signed with HMAC (retried, then dead-lettered; no link-local or metadata addresses).', 'Directory (LDAP / Active Directory): sign-on over verified TLS; groups map to roles only after a QA signature. Not tested against a real Active Directory (DEV-2026-10-26-03).', 'Files produced: Certificates of Analysis and reports (PDF, with a recorded SHA-256), list exports (with reason and hash in the audit trail), labels, encrypted backups, archive bundles.']),

    S.h1('6. Functions outside the validated scope'),
    S.p('The functions below exist in the software and are permission-controlled, but have no OQ in this package (DEV-2026-10-13-04). QA declares the validated scope per module in the application (URS-116); an undeclared module is not blocked.'),
    S.simpleTable(['Permission', 'Allows', 'Roles', 'Routes'], permRows(PERMS.filter(p => rest.includes(p.category))), [1900, 2700, 1500, 3900]),

    S.h1('7. Data'),
    S.p(`${TABLES.length} tables in the public schema. Audit, signature, result-version, custody and similar history tables accept inserts and reads only (database triggers); the application role does not own the tables.`),
    ...S.bullets([TABLES.join(', ')]),

    S.h1('8. Known limits'),
    S.p(`${open.length} deviations are open in the validation package; those that limit a function described here:`),
    S.simpleTable(['Deviation', 'Limit', 'Action'], open.map(d => [d[0], d[1], d[2]]), [1700, 5000, 3300]),

    S.h1('Appendix A. Permission matrix'),
    S.simpleTable(['Permission', 'Category', 'Admin', 'QA', 'Reviewer', 'Analyst'], PERMS.map(p => [p.id, p.category, ...['Admin', 'QA', 'Reviewer', 'Analyst'].map(r => (p.roles.includes(r) ? 'X' : ''))]), [3200, 2400, 1000, 1000, 1200, 1200]),
    S.h1('Approval'), S.approvalTable());

  const doc = new Document({ styles: S.docDefaults(), numbering: S.numberingConfig(), sections: [{ properties: S.pageSetup(), headers: { default: S.docHeader(DOCNO, C.SYSTEM) }, footers: { default: S.docFooter(DOCNO) }, children }] });
  const out = path.join(__dirname, '..', 'docs', 'VAL-LIMS-FS-001-FS.docx');
  fs.writeFileSync(out, await Packer.toBuffer(doc));
  console.log(`built ${path.relative(ROOT, out)}: ${areas.length} areas, ${C.URS.length} requirements, ${C.FRS.length} functions, ${PERMS.length} permissions, ${ROUTES.length} routes, ${MEANINGS.length} meanings, ${TABLES.length} tables, ${JOBS.length} jobs`);
})().catch(e => { console.error(e); process.exit(1); });
