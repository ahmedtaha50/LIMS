// Single source of truth for the B-Pharma LIMS validation package.
// Requirement IDs are NEW identifiers created by this package (no pre-existing approved URS was supplied);
// they are a DRAFT for the System Owner to review and approve.
const SYSTEM = 'B-Pharma LIMS (desktop edition)';
const DATE = '2026-10-13';

// [id, text, priority, area]
const URS = [
  ['URS-001', 'The system shall allow access only to uniquely identified, authenticated users; every API request shall be refused without a valid session token.', 'Critical', 'Access control'],
  ['URS-002', 'The system shall not allow self-registration or automatic creation of accounts; accounts shall be created only by an Administrator or during first-run setup.', 'Critical', 'Access control'],
  ['URS-003', 'Session tokens shall be signed with an installation-specific secret that is not present in the source code.', 'Critical', 'Access control'],
  ['URS-004', 'Access to the audit trail and to each workflow transition shall be restricted by role.', 'High', 'Access control'],
  ['URS-005', 'Where a user has TOTP multi-factor authentication enabled, login shall not issue a session until the TOTP code is verified.', 'High', 'Access control'],
  ['URS-006', 'The system shall lock an account after the configured number of failed logins.', 'High', 'Access control'],
  ['URS-007', 'Passwords shall be stored only as salted hashes with a per-user salt and compared in constant time.', 'High', 'Access control'],
  ['URS-010', 'The sample lifecycle (Logged, Testing, Pending Review, Approved/Rejected) shall be enforced by the server; a transition not defined in the workflow shall be refused.', 'Critical', 'Workflow'],
  ['URS-011', 'Only the roles defined for a transition shall be able to perform it.', 'Critical', 'Workflow'],
  ['URS-012', 'The person who entered results for a sample shall not be able to approve or reject it (segregation of duties).', 'Critical', 'Workflow'],
  ['URS-013', 'Updates shall be rejected when the client-supplied record version differs from the stored version (optimistic concurrency).', 'High', 'Workflow'],
  ['URS-014', 'API inputs shall be validated against strict schemas; server-controlled fields supplied by a client shall be rejected, and invalid input shall never terminate the service.', 'High', 'Workflow'],
  ['URS-020', 'An electronic signature shall require re-entry of the signer\'s password at the time of signing.', 'Critical', 'Electronic signature'],
  ['URS-021', 'Each signature shall record the signer, the meaning of the signature, the record version signed and the linked audit-trail entry.', 'Critical', 'Electronic signature'],
  ['URS-022', 'The integrity of a signature shall be verifiable by recomputing its content hash and the audit chain.', 'High', 'Electronic signature'],
  ['URS-023', 'After three failed signature attempts the signer shall be locked out, and every failed attempt shall be recorded in the audit trail even though the signing action is refused.', 'High', 'Electronic signature'],
  ['URS-024', 'A user who has not completed the software training shall not be able to apply an electronic signature.', 'High', 'Electronic signature'],
  ['URS-030', 'Every creation, modification and workflow transition of a GxP record shall be written to the audit trail in the same database transaction, with user, action, entity, old value, new value, reason and a cryptographic hash.', 'Critical', 'Audit trail'],
  ['URS-031', 'The audit trail shall be a hash chain whose integrity can be verified on demand.', 'Critical', 'Audit trail'],
  ['URS-032', 'Audit-trail and signature records shall be append-only at database level: UPDATE, DELETE and TRUNCATE shall be refused.', 'Critical', 'Audit trail'],
  ['URS-033', 'The system shall report the current audit-chain head (sequence and hash) so that it can be filed outside the system and later used to detect rewriting of history.', 'High', 'Audit trail'],
  ['URS-040', 'The desktop application shall serve its interface only on the loopback interface of the PC.', 'High', 'Desktop deployment'],
  ['URS-041', 'The database password and the session-signing secret shall be stored protected by the operating-system credential store, and shall never be stored in clear text.', 'High', 'Desktop deployment'],
  ['URS-042', 'The user-interface process shall have no direct access to the file system or Node.js APIs.', 'High', 'Desktop deployment'],
  ['URS-043', 'Core GxP functions shall not depend on an outbound internet connection; the optional AI assistant shall degrade gracefully when unavailable.', 'Medium', 'Desktop deployment'],
  ['URS-050', 'The system shall provide a verified backup and tested restore procedure for all GxP data.', 'High', 'Data availability'],
];

// FRS: [id, mechanism, urs[]]
const FRS = [
  ['FRS-001', 'requireAuth middleware (src/server/api.ts) verifies the bearer JWT and loads the active user from PostgreSQL on every request; absent or invalid tokens return 401.', ['URS-001']],
  ['FRS-002', 'POST /auth/register-demo has been removed and /auth/login-local rejects unknown e-mails with 401. The first Administrator is created by src/server/init-db.ts from environment values.', ['URS-002']],
  ['FRS-003', 'JWT_SECRET is read from the environment; the desktop shell generates a random 48-byte secret per installation and stores it with safeStorage. The server refuses to start in production without it.', ['URS-003', 'URS-041']],
  ['FRS-004', 'GET /audit and /audit/head require Admin or QA. validateTransition() (src/server/workflow/transitions.ts) is called from the transition endpoint and applies the role list of each transition.', ['URS-004', 'URS-011']],
  ['FRS-005', 'When users.totp_enabled is true, /auth/login-local returns a 5-minute temporary token with requiresTotp; the session JWT is issued only by /auth/totp-verify.', ['URS-005']],
  ['FRS-006', '/auth/login-local increments failed_attempts and sets active=false and locked_at at the configured maximum (system_settings).', ['URS-006']],
  ['FRS-007', 'generatePasswordHash() produces scrypt$<16-byte random salt>$<hash>; verifyPassword() compares with timingSafeEqual and still accepts the legacy format so existing accounts can sign in.', ['URS-007']],
  ['FRS-008', 'SampleWorkflow table + validateTransition() define permitted from/to states; any other combination returns an error (HTTP 400).', ['URS-010']],
  ['FRS-009', 'The transition endpoint refuses approve/reject when the actor entered any result of the sample (four-eyes check), and SampleWorkflow.validateSoD compares creator and actor.', ['URS-012']],
  ['FRS-010', 'The transition endpoint compares the client expectedVersion with samples.version inside the transaction and returns 409 on mismatch; version is incremented on success.', ['URS-013']],
  ['FRS-011', 'Zod .strict() schemas (src/lib/validations/, applied by validate() in src/server/http/validate.ts and by the body keys of src/server/authz/routeTable.ts) reject unknown fields; validation errors are returned from parseResult.error.issues as HTTP 400 (defect DEV-01 fixed).', ['URS-014']],
  ['FRS-012', 'Signing transitions require the password field, verified with verifyPassword() against the signer\'s own hash.', ['URS-020']],
  ['FRS-013', 'The signatures row stores signerId, meaning, reason, recordVersion, contentHash (SHA-256 of id/material/batch/state/version) and auditEntryId.', ['URS-021']],
  ['FRS-014', 'GET /signatures/verify/:id recomputes contentHash from the audit entry (state at signing) and immutable sample fields, and re-walks the audit chain; valid = chain intact AND hash matches.', ['URS-022']],
  ['FRS-015', 'On a wrong password the transaction is rolled back and the failure counter, lock (15 min after 3 failures) and a SignatureFailed audit entry are committed in a separate transaction in the catch block.', ['URS-023']],
  ['FRS-016', 'The transition endpoint refuses signatures when users.has_completed_software_training is false.', ['URS-024']],
  ['FRS-017', 'writeAudit() (src/db/utils.ts) is called with the transaction handle (tx) of the data change; it takes an advisory lock, computes sequence and SHA-256(prevHash + content) and inserts the row.', ['URS-030', 'URS-031']],
  ['FRS-018', 'POST /audit/verify re-derives every hash in sequence order and reports isValid/compromisedSequence; audit_trail.sequence is UNIQUE.', ['URS-031']],
  ['FRS-019', 'ensureProtections() (src/db/protections.ts) installs BEFORE UPDATE/DELETE and BEFORE TRUNCATE triggers on audit_trail and signatures (signatures: only the one-time pending-to-real audit link is allowed).', ['URS-032']],
  ['FRS-020', 'GET /audit/head returns {sequence, hash, at} for Admin/QA.', ['URS-033']],
  ['FRS-021', 'The embedded server listens on HOST=127.0.0.1 and a random free port (desktop/main.cjs); Socket.io CORS is disabled.', ['URS-040']],
  ['FRS-022', 'Secrets are encrypted with Electron safeStorage (DPAPI on Windows); if protection is unavailable the shell refuses to store them.', ['URS-041']],
  ['FRS-023', 'BrowserWindow is created with contextIsolation, sandbox, nodeIntegration=false; navigation outside the local origin is blocked and new windows are denied.', ['URS-042']],
  ['FRS-024', 'The Gemini calls are wrapped in try/catch with deterministic fallbacks; no other core function calls an external service.', ['URS-043']],
  ['FRS-025', 'src/server/backup.ts: one REPEATABLE READ snapshot of all tables; AES-256-GCM with scrypt-derived key; self-verification (data hash, row counts, audit-chain recomputation, head) before success is reported; BACKUP_CREATED/VERIFIED/FAILED audit events; restore (CLI, never over HTTP) only into an empty database, then re-installs the immutability triggers and re-checks counts and chain. Admin-only with password re-entry (POST /admin/backup, /admin/backup/verify; desktop menu Application > Backup).', ['URS-050']],
];

// Verification map. type: 'P' direct automated test, 'P*' code review only, 'GAP' not implemented/not tested
// checks: names in tests/security-controls.sh output (evidence/oq-run-*.txt)
const VERIF = {
  'URS-001': { type: 'P', ref: 'OQ-01', checks: ['URS-AUTH-unauthenticated-request-refused', 'GX-01-old-secret-token-rejected'] },
  'URS-002': { type: 'P', ref: 'OQ-01', checks: ['GX-02-register-demo-gone', 'GX-03-unknown-user-rejected'] },
  'URS-003': { type: 'P', ref: 'OQ-01', checks: ['GX-01-old-secret-token-rejected'] },
  'URS-004': { type: 'P', ref: 'OQ-02', checks: ['GX-06-analyst-cannot-read-audit', 'GX-06-qa-can-read-audit', 'GX-05-wrong-role-cannot-approve'] },
  'URS-005': { type: 'P', ref: 'OQ-08', checks: ['URS-005-totp-required-no-session-issued', 'URS-005-wrong-totp-refused', 'URS-005-correct-totp-issues-session'] },
  'URS-006': { type: 'P', ref: 'OQ-08', checks: ['URS-006-account-locked-after-failed-logins'] },
  'URS-007': { type: 'P', ref: 'OQ-07', checks: ['GX-11-new-hash-has-per-user-salt'] },
  'URS-010': { type: 'P', ref: 'OQ-03', checks: ['GX-05-invalid-transition-refused', 'GX-05-analyst-cannot-skip-to-approve', 'workflow-start', 'sign-review', 'sign-approve'] },
  'URS-011': { type: 'P', ref: 'OQ-02', checks: ['GX-05-wrong-role-cannot-approve', 'GX-05-analyst-cannot-skip-to-approve'] },
  'URS-012': { type: 'P', ref: 'OQ-08', checks: ['URS-012-reviewer-cannot-enter-result', 'URS-012-result-enterer-cannot-approve'] },
  'URS-013': { type: 'P', ref: 'OQ-03', checks: ['URS-CONC-stale-version-rejected'] },
  'URS-014': { type: 'P', ref: 'OQ-03', checks: ['URS-VAL-strict-schema-rejects-server-field'] },
  'URS-020': { type: 'P', ref: 'OQ-04', checks: ['GX-04-bad-password-refused', 'sign-review'] },
  'URS-021': { type: 'P', ref: 'OQ-06', checks: ['GX-08-signature-verifies'] },
  'URS-022': { type: 'P', ref: 'OQ-06', checks: ['GX-08-signature-verifies'] },
  'URS-023': { type: 'P', ref: 'OQ-04', checks: ['GX-04-failure-audited-and-persisted', 'GX-04-counter-persisted', 'URS-SIG-lockout-after-3-failures'] },
  'URS-024': { type: 'P', ref: 'OQ-04', checks: ['URS-TRN-untrained-user-cannot-sign'] },
  'URS-030': { type: 'P*', ref: 'OQ-05', note: 'Audit rows are demonstrably written for transitions and failed signatures (chain test, head > 0); same-transaction behaviour for every module established by code read only (3 of ~30 write paths sampled).' },
  'URS-031': { type: 'P', ref: 'OQ-05', checks: ['URS-AUD-chain-verification-intact'] },
  'URS-032': { type: 'P', ref: 'OQ-05', checks: ['GX-09-audit-update-refused', 'GX-09-audit-delete-refused', 'GX-09-signature-delete-refused', 'GX-09-truncate-refused'] },
  'URS-033': { type: 'P', ref: 'OQ-05', checks: ['GX-07-audit-head-reported'] },
  'URS-040': { type: 'P', ref: 'PQ-02', file: 'desktop-smoke-2026-10-13.txt', note: 'URL observed: http://127.0.0.1:<random port>. Executed on Linux/xvfb only.' },
  'URS-041': { type: 'P*', ref: 'PQ-02', file: 'desktop-smoke-2026-10-13.txt', note: 'Config password is not clear text, but the run used Electron\'s Linux plain-text backend (LIMS_DEV_PLAINTEXT_SECRETS). Windows DPAPI NOT tested. See DEV-06.' },
  'URS-042': { type: 'P', ref: 'PQ-02', file: 'desktop-smoke-2026-10-13.txt', note: 'typeof require / typeof process in the renderer = undefined.' },
  'URS-043': { type: 'P*', ref: 'OQ-08', note: 'Code read only; not tested with the network disabled.' },
  'URS-050': { type: 'P', ref: 'OQ-09', checks: ['OQ09-backup-non-admin-refused', 'OQ09-backup-wrong-password-refused', 'OQ09-backup-short-passphrase-refused', 'OQ09-backup-created-and-self-verified', 'OQ09-backup-event-in-audit-trail', 'OQ09-verify-ok', 'OQ09-wrong-passphrase-refused', 'OQ09-tampered-file-refused', 'OQ09-restore-counts-match', 'OQ09-restore-audit-chain-intact', 'OQ09-restored-db-has-immutability-triggers', 'OQ09-restore-never-overwrites-nonempty-db'], note: 'Manual backup/verify/restore only; scheduling and off-PC copy are procedural (DEV-08).' },
};

// Risk assessment: [area, S, L, D, rationale, urs[]]
const GRA = [
  ['Authentication & session', 5, 3, 2, 'A forged or unauthenticated session allows any record to be changed under another identity.', ['URS-001', 'URS-002', 'URS-003', 'URS-005', 'URS-006', 'URS-007']],
  ['Authorisation & workflow', 5, 3, 3, 'Wrong role or skipped state could release an unapproved batch; a later independent review might catch it.', ['URS-004', 'URS-010', 'URS-011', 'URS-012', 'URS-013', 'URS-014']],
  ['Electronic signatures', 5, 3, 2, 'Signature without genuine re-authentication or with unverifiable integrity is legally void under Part 11.', ['URS-020', 'URS-021', 'URS-022', 'URS-023', 'URS-024']],
  ['Audit trail integrity', 5, 3, 1, 'Silent loss or rewrite of history; structural controls (hash chain, triggers) make it detectable, anchors cover owner-level rewrite.', ['URS-030', 'URS-031', 'URS-032', 'URS-033']],
  ['Desktop deployment & secrets', 4, 3, 3, 'Credentials reachable from the shared Windows session; local administrator can bypass application controls.', ['URS-040', 'URS-041', 'URS-042', 'URS-043']],
  ['Backup & recovery', 5, 3, 5, 'Loss of the single PC database is undetectable until needed; no function exists.', ['URS-050']],
  ['Non-core modules (ELN, OOS, stability, environmental, reagents, instruments, training, reports)', 4, 3, 3, 'Not individually qualified in this release (see DEV-04).', []],
];

const DEVIATIONS = [
  ['DEV-2026-10-13-01', 'Any authenticated request with invalid input terminated the whole server process (Zod 4 exposes issues, not errors; src/server/api.ts, 3 call sites). Found by OQ-03 strict-schema test. Denial of service and possible loss of in-flight work.', 'Corrected to parseResult.error.issues; OQ re-run 28/28 pass.', 'CLOSED'],
  ['DEV-2026-10-13-02', 'Seed script aborted: OOS record referenced non-existent sample SMP-2026-003.', 'Corrected to SMP-2026-00003; seed completes.', 'CLOSED'],
  ['DEV-2026-10-13-03', 'URS-050: no backup/restore function existed in the application.', 'Implemented encrypted verified backup and restore (src/server/backup.ts); OQ-09 12/12 pass. Residual items tracked as DEV-08.', 'CLOSED'],
  ['DEV-2026-10-13-04', 'Non-core modules (ELN, OOS, stability, environmental, reagents, instruments, training, reports, barcode, voice) have no OQ coverage.', 'Release R2: OQ-10 to OQ-30 now execute automated tests for master data, methods, results, raw data, instruments, the machine API, events, certificates, OOS, quality records, documents and training, custody, reagents, stability, environmental monitoring, worklists and turnaround. ELN, the AI assistant, voice input and the camera scanner still have none. A module can now be declared NotQualified (writes refused) or Qualified by QA with an e-signature (validated-scope register, URS-116); see DEV-2026-10-25-04.', 'OPEN'],
  ['DEV-2026-10-13-05', 'PQ by representative end users has not been performed; PQ evidence is technical/automated only.', 'Schedule end-user PQ per PQ-01/PQ-02 scripts.', 'OPEN'],
  ['DEV-2026-10-13-06', 'IQ and the installer were executed only in a Linux development sandbox. Windows installer (NSIS), DPAPI protection and the target PC were not tested.', 'Execute IQ-W on the target PC; build installer on Windows or CI.', 'OPEN'],
  ['DEV-2026-10-13-07', 'URS-043 (offline operation) and the same-transaction audit property across all modules are supported by code reading only (P*). URS-005, -006, -012 were initially P* and are now covered by OQ-08 executed tests.', 'Add an offline-run test and audit-in-transaction tests per module when modules are qualified (DEV-04).', 'OPEN'],
  ['DEV-2026-10-13-08', 'Backups are manual: no automatic schedule, no automatic copy to a server share, no restore-test SOP, and the passphrase custody is procedural.', 'Write SOPs (backup, passphrase custody, quarterly restore test); consider a scheduler in a later release.', 'OPEN'],
];

const OQ = [
  ['OQ-01', 'Authentication and identity', 'Server and database running; seeded users.', [
    ['URS-AUTH-unauthenticated-request-refused', 'GET /api/samples with no token.', 'HTTP 401.'],
    ['GX-02-register-demo-gone', 'POST /api/auth/register-demo asking for role Admin.', 'HTTP 404 (endpoint removed).'],
    ['GX-03-unknown-user-rejected', 'Log in with an e-mail not in the user table.', 'HTTP 401; no account created.'],
    ['GX-01-old-secret-token-rejected', 'Present a token signed with the former hard-coded secret.', 'HTTP 401.']]],
  ['OQ-02', 'Authorisation', 'As OQ-01; users analyst1, reviewer, qa.', [
    ['GX-06-analyst-cannot-read-audit', 'Analyst calls GET /api/audit.', 'HTTP 403.'],
    ['GX-06-qa-can-read-audit', 'QA calls GET /api/audit.', 'HTTP 200.'],
    ['GX-05-wrong-role-cannot-approve', 'Analyst tries to approve a Pending Review sample.', 'HTTP 400, state unchanged.'],
    ['GX-05-analyst-cannot-skip-to-approve', 'Analyst tries to approve a Logged sample.', 'HTTP 400.']]],
  ['OQ-03', 'Workflow, concurrency and input validation', 'As OQ-01.', [
    ['GX-05-invalid-transition-refused', 'Move an Approved sample back to Testing.', 'HTTP 400.'],
    ['workflow-start', 'Analyst submits a Logged sample to Testing.', 'HTTP 200.'],
    ['sign-review', 'Analyst signs the sample into Pending Review with correct password.', 'HTTP 200.'],
    ['sign-approve', 'Reviewer approves with correct password and reason.', 'HTTP 200.'],
    ['URS-CONC-stale-version-rejected', 'Submit a transition with expectedVersion 99.', 'HTTP 409.'],
    ['URS-VAL-strict-schema-rejects-server-field', 'Register a sample including the server-controlled field "state".', 'HTTP 400 and the server stays running.']]],
  ['OQ-04', 'Electronic-signature controls', 'Sample in Testing state.', [
    ['GX-04-bad-password-refused', 'Sign with a wrong password.', 'HTTP 401.'],
    ['GX-04-failure-audited-and-persisted', 'Query audit_trail for the failed attempt.', 'A SignatureFailed row exists for the sample.'],
    ['GX-04-counter-persisted', 'Query users.failed_attempts.', 'Counter greater than 0.'],
    ['URS-TRN-untrained-user-cannot-sign', 'Set has_completed_software_training=false, then sign.', 'HTTP 403 (TRAINING_REQUIRED).'],
    ['URS-SIG-lockout-after-3-failures', 'Three wrong passwords, then the correct password.', 'HTTP 401 (account locked).']]],
  ['OQ-05', 'Audit-trail integrity', 'Audit rows exist.', [
    ['URS-AUD-chain-verification-intact', 'POST /api/audit/verify.', 'isValid true.'],
    ['GX-07-audit-head-reported', 'GET /api/audit/head.', 'Sequence greater than 0 and a 64-character hash.'],
    ['GX-09-audit-update-refused', 'SQL UPDATE audit_trail.', 'Error "not permitted".'],
    ['GX-09-audit-delete-refused', 'SQL DELETE FROM audit_trail.', 'Error "not permitted".'],
    ['GX-09-signature-delete-refused', 'SQL DELETE FROM signatures.', 'Error "not permitted".'],
    ['GX-09-truncate-refused', 'SQL TRUNCATE audit_trail.', 'Error "not permitted".']]],
  ['OQ-06', 'Signature verification', 'A signed sample exists.', [
    ['GX-08-signature-verifies', 'GET /api/signatures/verify/<id> for each signature of the sample.', 'valid true and contentHashMatches true.']]],
  ['OQ-07', 'Password storage', 'tsx available.', [
    ['GX-11-new-hash-has-per-user-salt', 'Hash the same password twice.', 'Both start with scrypt$ and differ.']]],
];

OQ.push(['OQ-08', 'Multi-factor, login lockout and segregation of duties', 'Seeded users; TOTP secret set by SQL for one user.', [
  ['URS-005-totp-required-no-session-issued', 'Log in as a user with TOTP enabled.', 'Response requires TOTP and contains no session token.'],
  ['URS-005-wrong-totp-refused', 'Submit a wrong code with the temporary token.', 'HTTP 401.'],
  ['URS-005-correct-totp-issues-session', 'Submit the correct code.', 'Session token issued.'],
  ['URS-006-account-locked-after-failed-logins', 'Three wrong passwords, then the correct one.', 'HTTP 401 (account locked).'],
  ['URS-012-reviewer-cannot-enter-result', 'Reviewer (who reviews, not enters) tries to enter a result on a Testing sample.', 'HTTP 403.'],
  ['URS-012-result-enterer-cannot-approve', 'The Administrator enters the results, the analyst signs for review, and the Administrator tries to approve.', 'HTTP 400 (segregation of duties).']]]);
OQ.push(['OQ-09', 'Backup, verification and restore', 'Server running; dist/backup-cli.cjs; a role that can create a database.', [
  ['OQ09-backup-non-admin-refused', 'QA user calls POST /admin/backup.', 'HTTP 403.'],
  ['OQ09-backup-wrong-password-refused', 'Admin with wrong password.', 'HTTP 401.'],
  ['OQ09-backup-short-passphrase-refused', 'Passphrase under 12 characters.', 'HTTP 400.'],
  ['OQ09-backup-created-and-self-verified', 'Admin creates a backup.', 'HTTP 200; file written and self-verified.'],
  ['OQ09-backup-event-in-audit-trail', 'Query audit_trail.', 'BACKUP_CREATED present.'],
  ['OQ09-verify-ok', 'CLI verify with the right passphrase.', 'ok true.'],
  ['OQ09-wrong-passphrase-refused', 'CLI verify with a wrong passphrase.', 'Refused (exit 1).'],
  ['OQ09-tampered-file-refused', 'Flip one byte of the file and verify.', 'Refused (exit 1).'],
  ['OQ09-restore-counts-match', 'Restore into a new empty database.', 'Row counts equal the manifest.'],
  ['OQ09-restore-audit-chain-intact', 'Recompute the audit chain in the restored database.', 'Intact.'],
  ['OQ09-restored-db-has-immutability-triggers', 'Count gxp_ triggers in the restored database.', '4.'],
  ['OQ09-restore-never-overwrites-nonempty-db', 'Restore again into the same, now non-empty, database.', 'Refused (exit 1).']]]);

// Release R2 (roadmap M17 to M37): requirements, mechanisms, risk rows, deviations and OQ protocols from content-r2.cjs.
const R2 = require('./content-r2.cjs');
URS.push(...R2.URS); FRS.push(...R2.FRS); GRA.push(...R2.GRA); DEVIATIONS.push(...R2.DEVIATIONS);
DEVIATIONS.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
Object.assign(VERIF, R2.VERIF);
for (const [id, v] of Object.entries(R2.VERIF_UPGRADE)) VERIF[id] = { ...VERIF[id], ...v };
for (const [id, v] of Object.entries(R2.VERIF_REPLACE)) VERIF[id] = v;
// A Critical or High requirement without a passed test is allowed only when an open deviation carries it (URS-041, in VERIF_REPLACE).
const EXEC_DATE = '2026-10-25';

module.exports = { SYSTEM, DATE, EXEC_DATE, URS, FRS, VERIF, GRA, DEVIATIONS, OQ, OQ_R2: R2.OQ_R2 };
