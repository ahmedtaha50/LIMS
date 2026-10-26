// Release R2 additions to the validation package (roadmap M17 to M35 and M37): user requirements, functional mechanisms and their
// verification, taken from what the tracks built and from the tests that exercise it.
//
// Rules of this file:
//  - Requirement identifiers URS-060 and up are NEW identifiers created by this package, like URS-001 to URS-050: a DRAFT for the System
//    Owner to review and approve. Priorities are the author's proposal.
//  - Nothing here states a result. A verification lists test references; validation/build/results.cjs looks each one up in the evidence of
//    an executed run (JUnit of the whole suite, the shell OQ, the browser run). A reference that is not found is 'NOT RUN', and the
//    check (node validation/build/check.cjs) fails.
//  - A requirement that no executed test can cover says so ('P*' or 'GAP') and names the deviation that carries it.
//
// Test references: T('master-data', 'fragment of the title') is a Vitest test of tests/api/master-data.test.ts; U(...) one of tests/unit/;
// E('script', 'id') a browser check of tests/e2e or tests/*.cjs, run by tests/e2e/run.cjs; D('desktop-shell', 'text') a check of the Electron shell tests.
const T = (file, match) => ({ file: `tests/api/${file}.test.ts`, match });
const U = (file, match) => ({ file: `tests/unit/${file}.test.ts`, match });
const E = (e2e, id) => ({ e2e, id });
const D = (desktop, match) => ({ desktop, match });

// [id, text, priority, area]
const URS = [
  ['URS-060', 'A sample shall be registered from a controlled product and batch record, so that its material and batch cannot differ from the master record; an inactive product, a rejected batch or an unknown customer shall be refused with nothing written.', 'High', 'Master data'],
  ['URS-061', 'A batch number shall be unique within a product; the same number under another product is another batch, and two simultaneous creations of one batch shall yield one record.', 'High', 'Master data'],
  ['URS-062', 'The status of a product or batch shall change only with an electronic signature bound to the record version; a batch shall be released in the master data only after the formal batch release, and Rejected and Recalled shall be final.', 'High', 'Master data'],
  ['URS-063', 'On upgrade every existing sample shall be mapped to a product and batch with no orphan, no existing row changed, and every earlier signature still verifying.', 'High', 'Master data'],

  ['URS-064', 'A calculated result shall be computed on the server from the raw inputs by a formula language that cannot execute arbitrary code; a formula with a forbidden name, call or syntax shall be refused.', 'Critical', 'Methods and calculations'],
  ['URS-065', 'A formula revision shall be approved only when every test case reproduces its hand-calculated value, and a later revision shall leave an existing result unchanged.', 'High', 'Methods and calculations'],
  ['URS-066', 'A failed system suitability criterion shall make the run Invalid and block review without opening an OOS investigation; a method that requires suitability shall need a recorded run before review.', 'High', 'Methods and calculations'],
  ['URS-067', 'Specification parameters shall be held as normalised rows with the same limits as the specification they came from, before and after upgrade.', 'High', 'Methods and calculations'],

  ['URS-068', 'All changed results of one sample shall be saved in one transaction: a stale row refuses the whole save and names the row, and each changed value writes exactly one audit entry with its reason, old and new value.', 'High', 'Result entry'],
  ['URS-069', 'A result shall not be entered with an instrument that is past its calibration due date or out of service; the screen shall show the instrument as unavailable and the server shall refuse it.', 'Critical', 'Result entry'],

  ['URS-070', 'Every value a result has held shall be kept as an append-only version with a coded reason; a reintegration shall need the signature of a person other than the one who made it, and an out-of-specification value shall not be replaced by reintegration.', 'Critical', 'Raw data integrity'],
  ['URS-071', 'A raw-data file shall be stored with its SHA-256 and shall be refused on download, with an audit entry, when the stored bytes no longer match; types outside the allow-list and oversize files shall be refused.', 'High', 'Raw data integrity'],
  ['URS-072', 'A sample shall not be approved while a server-verified review item fails (files intact, instruments calibrated at measurement, result history, signed reintegrations), and the refusal shall cost the signer no attempt.', 'High', 'Raw data integrity'],
  ['URS-073', 'The backup shall carry the raw-data files, verify them, and restore them into an empty store; a damaged file shall refuse the backup.', 'High', 'Raw data integrity'],

  ['URS-074', 'A file captured from an instrument shall be registered with its SHA-256; identical content shall be refused and audited, and a malformed file shall be kept as Failed with a readable message and stage nothing.', 'High', 'Instrument data'],
  ['URS-075', 'A captured value shall become a result only when a named analyst accepts it, through every rule of manual entry, with its source recorded; a sample with an undecided capture shall not move to Pending Review.', 'Critical', 'Instrument data'],
  ['URS-076', 'The instrument file parsers shall produce the expected values from fixture files and shall never change the digits of a value.', 'Medium', 'Instrument data'],

  ['URS-077', 'A machine integration token shall be shown once and stored as a hash, shall carry named scopes, shall never reach a signing endpoint or the interactive API, and shall stop working when revoked or expired.', 'High', 'Machine integration'],
  ['URS-078', 'A batch of up to 500 results or samples shall be written all or nothing, attributed to the service account, and a replayed idempotency key shall write nothing.', 'High', 'Machine integration'],
  ['URS-079', 'The machine API shall publish a valid OpenAPI 3.1 contract that is current with the code, and a breaking change shall be detected.', 'Medium', 'Machine integration'],

  ['URS-080', 'A notification, outbox event or socket message shall exist only for a change that committed; a rolled-back change shall announce nothing, and a user who was away shall see it at the next sign-in.', 'High', 'Events and notifications'],
  ['URS-081', 'A socket connection shall be refused without a valid session token and shall end when its session is revoked or the user deactivated.', 'High', 'Events and notifications'],
  ['URS-082', 'A webhook shall carry a verifiable HMAC, be retried and then dead-lettered, and shall never be sent to a metadata or link-local address or follow a redirect.', 'Medium', 'Events and notifications'],

  ['URS-083', 'Every screen shall have an address that opens it after sign-in; sort, filter and page shall survive a reload, and the browser Back button shall return to the earlier view.', 'Medium', 'User interface'],
  ['URS-084', 'A dialog shall take and trap the keyboard focus, close on Escape and return the focus, and the working session shall be possible with the keyboard alone.', 'Medium', 'User interface'],
  ['URS-085', 'A list export shall state a reason, and the audit trail shall record who exported, with which filter, how many rows and the SHA-256 of the file; the inbox of a quality reviewer shall leave out the records that person entered.', 'High', 'User interface'],

  ['URS-086', 'A Certificate of Analysis shall be issued only for an Approved sample, with a gap-free number, an electronic signature, and a stored report whose SHA-256 is recorded.', 'Critical', 'Certificates and reports'],
  ['URS-087', 'A certificate shall never state compliance while any result is out of specification or missing, and a corrected or invalidated value shall be shown as such.', 'Critical', 'Certificates and reports'],
  ['URS-088', 'A re-issue shall supersede the earlier certificate with a reason in one transaction with the signature; concurrent issues shall produce no duplicate or missing number.', 'High', 'Certificates and reports'],
  ['URS-089', 'A change of one byte in a stored report or its data snapshot shall fail verification.', 'High', 'Certificates and reports'],

  ['URS-090', 'An investigation shall not be closed as invalidated without an assignable cause, a QA signature on that cause and a linked retest, and shall not be closed or its cause confirmed by the investigator.', 'Critical', 'OOS investigation'],
  ['URS-091', 'A retest shall be refused for the original analyst and beyond the number the plan allows, and an invalidated closure shall be refused while any retest is out of specification.', 'High', 'OOS investigation'],
  ['URS-092', 'An investigation past its Phase I due date shall appear as overdue on the record, in the list and in the overdue report.', 'Medium', 'OOS investigation'],

  ['URS-093', 'A major deviation shall not close without a linked CAPA and a QA signature; the signer of an approval shall not be the person who raised or owns the record; a closed record shall be locked.', 'High', 'Quality management'],
  ['URS-094', 'Quality records shall be numbered without duplicates under concurrent creation, carry the version predicate, and flag an action past its due date as overdue.', 'High', 'Quality management'],
  ['URS-095', 'When the setting is on, approving a specification or role change shall need an Approved change control; the setting shall be changed only with a signature.', 'High', 'Quality management'],
  ['URS-096', 'An open major or unclassified deviation about a batch shall block the release of that batch.', 'Critical', 'Quality management'],

  ['URS-097', 'A document version shall become Effective only with three distinct signatures including a QA role, and making a version Effective shall supersede the previous one in the same transaction.', 'Critical', 'Documents and training'],
  ['URS-098', 'A document file shall be stored with its SHA-256 and refused on download, with an audit entry, when tampered; only an Effective version shall be printed, as a numbered controlled copy.', 'High', 'Documents and training'],
  ['URS-099', 'A user with an overdue mandatory training assignment shall be refused result entry for the method that requires it, and a qualification override shall be signed, time-limited and flagged on each use.', 'High', 'Documents and training'],
  ['URS-100', 'Certifying training on a module other than the LIMS curriculum shall not change the global flag that allows signing.', 'High', 'Documents and training'],

  ['URS-101', 'Testing shall start only on a received sample; a receipt outside the required range shall block testing until QA signs.', 'High', 'Custody and labels'],
  ['URS-102', 'An aliquot or consumption shall be recorded in an append-only ledger whose balance never goes negative, including under concurrent requests.', 'High', 'Custody and labels'],
  ['URS-103', 'A scanned or typed identifier shall open the record even when it is not in the loaded list, an unknown code shall be reported to the user, and a label reprint shall need a reason.', 'Medium', 'Custody and labels'],

  ['URS-104', 'A result shall not be saved against a reagent lot that is expired, rejected, quarantined or past its retest date, and the refusal shall name the lot and the date.', 'Critical', 'Reagents and standards'],
  ['URS-105', 'A reagent lot shall be received with a signature, released by a person other than the receiver, and when opened shall take an in-use expiry; a solution shall not outlive any component.', 'High', 'Reagents and standards'],
  ['URS-106', 'The reagent ledger shall be append-only, and the results measured with a lot shall be traceable from the lot, directly or through a solution.', 'High', 'Reagents and standards'],

  ['URS-107', 'The timepoints of a stability protocol shall be generated with correct due dates across month ends and leap years, shall become Due and Missed without user action (also after the server was stopped), and a missed pull shall open a deviation.', 'High', 'Stability'],
  ['URS-108', 'An approved protocol shall not be edited (a change is a new, signed revision), and a pull shall create a sample linked to its timepoint with the result rows of the test plan.', 'High', 'Stability'],

  ['URS-109', 'Environmental limits shall be approved with a signature by someone other than the author, a client-supplied status shall be refused, and only the quality unit shall correct a count.', 'High', 'Environmental monitoring'],
  ['URS-110', 'An action-level result shall open an excursion and a deviation in the same transaction and hold the release of the batches affected; three consecutive alert-level results shall be flagged as an adverse trend.', 'High', 'Environmental monitoring'],

  ['URS-111', 'A worklist shall check the analyst qualification and the instrument, after release a change without a reason shall be refused and audited, and only the assignee shall enter a result of a released worklist.', 'Medium', 'Worklists'],

  ['URS-112', 'A due date shall be calculated in business days from receipt using the site calendar, and on-time percentage and turnaround percentiles shall equal a hand calculation.', 'Medium', 'Turnaround and indicators'],
  ['URS-113', 'The count shown on a dashboard tile shall equal the number of rows of the list it opens, and no composite compliance score shall be shown.', 'Medium', 'Turnaround and indicators'],

  ['URS-114', 'The application database role shall be unable to change or delete audit entries or to remove the guards, and a rewrite of the audit chain by the database owner shall be detected against a signed anchor.', 'Critical', 'Audit trail hardening'],
  ['URS-115', 'When the setting is on, a batch shall not be released until a QA audit review covers its audit rows, and a system clock set back shall be recorded and block signing until acknowledged.', 'High', 'Audit trail hardening'],

  ['URS-116', 'QA shall be able to declare a functional module Qualified or NotQualified with an electronic signature; writes to a NotQualified module shall be refused and the refusal recorded, while reads and other modules continue.', 'High', 'Validated scope'],
  ['URS-117', 'Every Critical or High requirement shall be linked to an executed test or to an open, named deviation, and this shall be checked by a program, not by reading.', 'High', 'Validated scope'],

  ['URS-119', 'Every screen of the application shall have no serious or critical accessibility violation (axe-core).', 'Medium', 'User interface'],
  ['URS-118', 'The browser flows of sign-in with an authenticator code, session lock with unsaved input, result entry, quality records, certificate issue, instrument calibration, audit filter and barcode scan shall work in a real browser against the built application.', 'High', 'Validated scope'],
];

// FRS: [id, mechanism, urs[]]. Every src/ path named must exist (checked by check.cjs).
const FRS = [
  ['FRS-100', 'src/server/routes/batches.ts POST /batches/:id/samples fills samples.material and samples.batch from the product and batch rows and writes sample_context (append-only) in the registration transaction; drizzle/0100_master_data.sql.', ['URS-060', 'URS-063']],
  ['FRS-101', 'A functional unique index on the normalised batch number per product (drizzle/0100_master_data.sql) and a 409 DUPLICATE in src/server/routes/batches.ts.', ['URS-061']],
  ['FRS-102', 'POST /products/:id/status and /batches/:id/status call signRecord with the catalog meaning MASTER_DATA_STATUS and the version predicate (src/server/routes/products.ts, batches.ts); Released needs batch_releases = Released.', ['URS-062']],
  ['FRS-103', 'src/lib/validations/methods.ts allow-lists the formula functions; src/server/lib/calc.ts is a hand-written parser with no eval, property access or string; POST /calc/evaluate (src/server/routes/calc.ts) tries an expression without writing.', ['URS-064']],
  ['FRS-104', 'A formula is approved with a signature (src/server/routes/calc.ts) only when every stored test case reproduces; a calculated entry stores its raw inputs and the formula revision with the result (result_inputs, src/db/schema/calc.ts), so a later revision changes nothing already recorded.', ['URS-065']],
  ['FRS-105', 'POST /calc/samples/:id/sst (src/server/routes/calc.ts, table sst_runs in drizzle/0110_methods_calc.sql) judges every criterion and marks a failed run Invalid; the Pending Review guards (src/server/workflow/guards/sst.ts, src/server/services/result-guards/sst.ts) block review without a valid run, and no OOS investigation is opened.', ['URS-066']],
  ['FRS-106', 'drizzle/0110_methods_calc.sql builds spec_parameters from the specification JSONB; a trigger keeps them identical and refuses direct writes; src/db/schema/methods.ts.', ['URS-067']],
  ['FRS-107', 'PUT /samples/:id/results-batch (src/server/routes/results-batch.ts) checks the whole request, then calls saveResult for each row in one transaction; a stale row is 409 with the rows named; one audit entry per changed value.', ['URS-068']],
  ['FRS-108', 'The instrument result guard (src/server/services/result-guards/index.ts, calibrationState) refuses an instrument past its calibration due date or not Active; src/components/ResultGrid.tsx disables such an instrument in the picker.', ['URS-069']],
  ['FRS-109', 'result_versions (drizzle/0120_raw_data.sql) is append-only by trigger; src/server/services/result-hooks/versions.ts writes a version in the result transaction; POST /result-versions/:id/sign (src/server/routes/review.ts) uses REINTEGRATION_APPROVAL and a separation-of-duties rule.', ['URS-070']],
  ['FRS-110', 'src/server/blobs/ stores a streamed file with its SHA-256 and sniffs its type; GET /attachments/:id/content (src/server/routes/attachments.ts) re-hashes and answers 409 plus an audit entry on mismatch.', ['URS-071']],
  ['FRS-111', 'src/server/review.ts evaluates the server review items before approval (ATTACHMENTS_INTACT, INSTRUMENTS_CALIBRATED, RESULT_HISTORY, reintegrations signed); the transition answers 400 listing the failed items before any signature is attempted.', ['URS-072']],
  ['FRS-112', 'src/server/backup-blobs.ts adds a blob section to the backup, verifies each file, and restores into an empty folder.', ['URS-073']],
  ['FRS-113', 'src/server/routes/instrument-files.ts and src/server/parsers/ register a file with its SHA-256 (duplicate 409, audited), parse it, and keep a failed parse with its message.', ['URS-074']],
  ['FRS-114', 'POST /instrument-imports/:id/accept (src/server/routes/instrument-files.ts) writes the value through saveResult and result_sources; the unacceptedImports guard (src/server/connectors/guards.ts, wired in src/server/workflow/guards/index.ts) blocks Pending Review.', ['URS-075']],
  ['FRS-115', 'src/server/parsers/ (balance text, pH CSV, HPLC summary CSV, generic CSV) take a mapping and keep the digits of a value as text.', ['URS-076']],
  ['FRS-116', 'src/server/routes/api-clients.ts issues an API token (hash only, shown once, signed creation); src/server/v1/scopes.ts and mountApiV1 (src/server/v1/index.ts) refuse a token outside /api/v1 and on any signing route.', ['URS-077']],
  ['FRS-117', 'src/server/v1/idempotency.ts and the v1 result/sample routes (src/server/v1/routes/) write a batch in one transaction keyed by Idempotency-Key.', ['URS-078']],
  ['FRS-118', 'src/server/v1/openapi.ts generates docs/api/openapi.json; src/server/v1/breaking.ts compares two contracts; src/server/v1/openapi-cli.ts check runs in CI.', ['URS-079']],
  ['FRS-119', 'src/server/events/emit.ts writes outbox_events with the caller\'s transaction; the dispatcher (src/server/events/dispatcher.ts) fans out after commit; notifications are stored per user.', ['URS-080']],
  ['FRS-120', 'src/server/realtime.ts authenticates each socket in io.use() with the access token and disconnects it when its session is revoked or the user deactivated.', ['URS-081']],
  ['FRS-121', 'src/server/events/hmac.ts signs the timestamp and body; src/server/events/ssrf.ts refuses metadata and link-local addresses and does not follow redirects; failed deliveries are retried and dead-lettered.', ['URS-082']],
  ['FRS-122', 'src/lib/router.ts is a hash router; src/lib/useQueryState.ts keeps sort, filter and page in the address.', ['URS-083']],
  ['FRS-123', 'src/components/ui/ primitives implement the focus trap and Escape handling; the shell navigation and the list links are native controls reachable with Tab.', ['URS-084']],
  ['FRS-157', 'tests/a11y/axe-gate.cjs runs axe-core on every navigation entry and shell extension and fails on a serious or critical violation that is not in tests/a11y/baseline.json.', ['URS-119']],
  ['FRS-124', 'The export route records an audit entry with user, filter, row count and SHA-256 (src/server/routes/lookup.ts); the inbox query (src/server/routes/inbox.ts) excludes records the user entered.', ['URS-085']],
  ['FRS-125', 'POST /coa (src/server/routes/coa.ts, src/server/reports/coa.ts) is allowed for Approved samples, numbers from a gap-free counter, signs with signRecord and stores the PDF hash in a report run.', ['URS-086']],
  ['FRS-126', 'src/server/reports/snapshot.ts evaluates the conclusion from the stored snapshot: any OOS flag or missing value yields "Does not comply"; amended and invalidated rows are marked.', ['URS-087']],
  ['FRS-127', 'Re-issue (src/server/reports/coa.ts) marks the earlier document Superseded with the reason in the same transaction as the signature and audit entry; numbers come from the counter under a lock.', ['URS-088']],
  ['FRS-128', 'GET /reports/runs/:id/verify (route in src/server/routes/coa.ts, logic verifyRun in src/server/reports/runs.ts) re-hashes the stored PDF and the snapshot.', ['URS-089']],
  ['FRS-129', 'src/server/oos/workflow.ts and routes.ts enforce the closure rules (assignable cause, signed confirmation by QA, linked retest) and the separation-of-duties rule for the investigator.', ['URS-090']],
  ['FRS-130', 'src/server/oos/workflow.ts enforces the retest plan (original analyst refused, plan limit, no invalidation while a retest is OOS).', ['URS-091']],
  ['FRS-131', 'src/server/oos/workflow.ts computes due dates from oos_settings and GET /oos/overdue lists the investigations past them.', ['URS-092']],
  ['FRS-132', 'src/server/qms/engine.ts, rules.ts and states.ts: closure rules for a Major deviation, signer independence, 423 on a closed record.', ['URS-093']],
  ['FRS-133', 'src/server/qms/engine.ts numbers records under a counter lock and applies the version predicate; overdue is computed from the action due date.', ['URS-094']],
  ['FRS-134', 'src/server/qms/changeControl.ts and a guard on specification and role-change approval consult the qms setting.', ['URS-095']],
  ['FRS-135', 'src/server/release-blockers/qms.ts blocks a batch release with an open major or unclassified deviation.', ['URS-096']],
  ['FRS-136', 'src/server/routes/documents.ts and src/server/training/ implement the document cycle (author, review, approve, effectivity) with signRecord and a QA-only effectivity meaning; supersession in one transaction.', ['URS-097']],
  ['FRS-137', 'Document files use the blob store with SHA-256; print copies are numbered in a print log and only for an Effective version.', ['URS-098']],
  ['FRS-138', 'src/server/training/status.ts and the QUALIFICATION_REQUIRED result guard (src/server/services/result-guards/qualification.ts); overrides are signed, time-limited and flagged on use.', ['URS-099', 'URS-100']],
  ['FRS-139', 'src/server/workflow/guards/custody.ts: the Testing transition requires a receipt (src/server/custody/service.ts); an out-of-range receipt opens a deviation and blocks testing until QA signs.', ['URS-101']],
  ['FRS-140', 'src/server/custody/ledger.ts: the custody ledger is append-only by trigger, the balance is checked under a row lock, and a verifier recomputes it.', ['URS-102']],
  ['FRS-141', 'src/server/custody/resolve.ts and GET /resolve; src/lib/useScanSink.ts recognises a scanner burst; label reprints need a reason.', ['URS-103']],
  ['FRS-142', 'The reagent result guard (src/server/services/result-guards/reagent.ts) refuses an unusable lot and names it and the date; the batch save takes the same guard (src/server/routes/results-batch.ts).', ['URS-104']],
  ['FRS-143', 'src/server/routes/reagents.ts: signed receipt, release by another person (separation-of-duties rule), in_use_expiry on opening, database check that a solution does not outlive a component.', ['URS-105']],
  ['FRS-144', 'reagent_transactions is append-only by trigger; the lot traceback query joins results directly and through prepared solutions.', ['URS-106']],
  ['FRS-145', 'src/server/stability/calendar.ts adds months on the calendar; src/server/stability/sweep.ts (scheduled and run at start-up) moves timepoints to Due and Missed.', ['URS-107']],
  ['FRS-146', 'src/server/stability/protocols.ts locks an approved protocol; src/server/stability/studies.ts creates the pulled sample from the test plan.', ['URS-108']],
  ['FRS-147', 'src/server/em/routes.ts and engine.ts: EM_LIMIT_APPROVAL with separation of duties; strict schemas; em.correct permission for the quality unit.', ['URS-109']],
  ['FRS-148', 'src/server/em/engine.ts opens the excursion and deviation in the result transaction and links affected batches; src/server/em/trends.ts finds three consecutive alerts.', ['URS-110']],
  ['FRS-149', 'src/server/worklists/service.ts and the assignedAnalyst result guard (src/server/services/result-guards/assignment.ts): training check, reason after release, per-cell grid save.', ['URS-111']],
  ['FRS-150', 'src/server/lib/businessCalendar.ts adds business days in the site time zone; src/server/routes/metrics.ts computes percentiles in SQL.', ['URS-112']],
  ['FRS-151', 'src/server/routes/metrics.ts: a tile count and its list use the same predicate; the composite score was removed from src/server/routes/dashboard.ts.', ['URS-113']],
  ['FRS-152', 'The lims_app role step (src/server/boot/steps/) revokes UPDATE, DELETE and TRUNCATE on append-only tables; src/server/audit/anchors.ts writes signed anchors verified against the chain.', ['URS-114']],
  ['FRS-153', 'src/server/audit/review.ts (AUDIT_REVIEW signature, release gate) and src/server/audit/clockGuard.ts (CLOCK_ANOMALY blocks signing).', ['URS-115']],
  ['FRS-154', 'src/server/qualified.ts: qualified_modules (drizzle/0300_qualified_modules.sql), moduleQualificationGuard mounted after authorize() in src/server/app.ts, POST /validation/modules/:module/status signed with MODULE_QUALIFICATION (QA only); the screen is src/components/ModuleQualification.tsx (shell extension src/components/shell/ext/module-qualification.tsx).', ['URS-116']],
  ['FRS-155', 'validation/build/results.cjs reads the executed-run evidence; validation/build/check.cjs fails the build when a Critical or High requirement has no passed test and no open deviation.', ['URS-117']],
  ['FRS-156', 'tests/e2e/run.cjs provisions a throwaway database and the built bundle and runs the browser scripts of tests/e2e, tests/client-shell.cjs and tests/ui-foundation.cjs in Chromium.', ['URS-118']],
];

const VERIF = {
  'URS-060': { type: 'P', ref: 'OQ-10', tests: [T('master-data', 'fills samples.material and samples.batch'), T('master-data', 'is refused, with nothing written, when the product has no specification')] },
  'URS-061': { type: 'P', ref: 'OQ-10', tests: [T('master-data', 'the same batch number under two products is allowed'), T('master-data', 'two people creating the same batch at the same moment')] },
  'URS-062': { type: 'P', ref: 'OQ-10', tests: [T('master-data', 'changes status only with a signature'), T('master-data', 'status: Released only after the formal batch release'), T('master-data', 'a status change with a stale version is 409')] },
  'URS-063': { type: 'P', ref: 'OQ-10', tests: [T('master-migration', 'maps every sample to a product and a batch')] },
  'URS-064': { type: 'P', ref: 'OQ-11', tests: [U('calc/calc', 'has at least 25 of them'), U('calc/calc', "refuses ';', property access"), U('calc/calc', 'refuses a call to anything that is not on the allow-list'), T('methods-calc', 'compile on the server: an undeclared or unused input')] },
  'URS-065': { type: 'P', ref: 'OQ-11', tests: [T('methods-calc', 'are approved only when every test case reproduces'), T('methods-calc', 'approving a new formula revision afterwards leaves an existing result exactly as it was')] },
  'URS-066': { type: 'P', ref: 'OQ-11', tests: [T('methods-calc', 'RSD 2.7 against NMT 2.0 makes the run Invalid'), T('methods-calc', 'a method with SST criteria needs a recorded run before review')] },
  'URS-067': { type: 'P', ref: 'OQ-11', tests: [T('methods-migration', 'on the real v0.1.0 installation: the row count and every limit match'), T('methods-migration', 'gives the same rows and the same limits as the reader')] },
  'URS-068': { type: 'P', ref: 'OQ-12', tests: [T('result-ui-batch', 'saves every row in one request'), T('result-ui-batch', 'a stale row refuses the WHOLE save'), T('result-ui-batch', 'needs the row reason')] },
  'URS-069': { type: 'P', ref: 'OQ-12', tests: [T('result-ui-batch', 'an instrument 3 days past its calibration due date refuses the whole save'), T('results-entry', 'refuses an instrument whose calibration is due before today'), T('result-ui-grid', 'an instrument 3 days past its due date is disabled')] },
  'URS-070': { type: 'P', ref: 'OQ-13', tests: [T('rawdata-versions', 'three edits give three result_versions rows'), T('rawdata-versions', 'replacing an OOS value still needs an OOS code'), T('rawdata-versions', 'an Analyst or Reviewer cannot sign it')] },
  'URS-071': { type: 'P', ref: 'OQ-13', tests: [T('rawdata-attachments', 'a 20 MB file uploads with its sha256'), T('rawdata-attachments', 'one changed byte on disk refuses the download'), T('rawdata-attachments', 'refuses a type outside the allow-list')] },
  'URS-072': { type: 'P', ref: 'OQ-13', tests: [T('rawdata-review', 'approving with a failed server item is 400 listing the items'), T('rawdata-review', 'a reintegration without its QA signature blocks approval')] },
  'URS-073': { type: 'P', ref: 'OQ-13', tests: [T('rawdata-backup', 'lists every registered file once and verifies'), T('rawdata-backup', 'a file already damaged in the store refuses the backup')] },
  'URS-074': { type: 'P', ref: 'OQ-14', tests: [T('instrument-integration', 'a balance export creates one file row with the right sha256'), T('instrument-integration', 'a malformed file is Failed with a readable message'), T('instrument-agent', 'registers a balance export with the right sha256 within 15 s')] },
  'URS-075': { type: 'P', ref: 'OQ-14', tests: [T('instrument-integration', 'a named analyst accepts the value'), T('instrument-integration', 'an instrument that became overdue after the capture is refused'), T('instrument-integration', 'blocks Pending Review (400 TRANSITION_BLOCKED')] },
  'URS-076': { type: 'P', ref: 'OQ-14', tests: [U('instrument-parsers', 'reads labelled and bare readings'), U('instrument-parsers', 'never changes the digits of a value'), U('instrument-parsers', 'refuses an empty file, a header only, binary content')] },
  'URS-077': { type: 'P', ref: 'OQ-15', tests: [T('api-v1', 'shows the token once, stores only its hash'), T('api-v1', 'a results:write token gets 403 on every signing endpoint'), T('api-v1', 'revokes with a signature and the version the screen showed'), T('api-v1', 'an expired token is 401')] },
  'URS-078': { type: 'P', ref: 'OQ-15', tests: [T('api-v1', 'writes 500 results in one call'), T('api-v1', 'is all or nothing: one refused item'), T('api-v1', 'two simultaneous calls with one key write once')] },
  'URS-079': { type: 'P', ref: 'OQ-15', tests: [T('api-v1-openapi', 'is a valid OpenAPI 3.1 document'), T('api-v1-openapi', 'the committed docs/api files are what the code generates'), T('api-v1-openapi', 'a removed operation, a new required request field')] },
  'URS-080': { type: 'P', ref: 'OQ-16', tests: [T('events-outbox', 'a rolled-back change leaves no outbox row'), T('events-outbox', 'a rolled-back OOS result produces no outbox row'), T('events-outbox', 'a user who was offline sees the notification at the next sign-in')] },
  'URS-081': { type: 'P', ref: 'OQ-16', tests: [T('events-outbox', 'refuses a connection without a token'), T('events-outbox', 'accepts a session token and disconnects the socket once the session is revoked')] },
  'URS-082': { type: 'P', ref: 'OQ-16', tests: [T('events-subscriptions', '500, 500, 500, then 200'), T('events-subscriptions', 'refuses 169.254.169.254 at creation'), T('events-subscriptions', 'a redirect is not followed')] },
  'URS-083': { type: 'P', ref: 'OQ-17', tests: [E('ui-foundation', 'D1'), E('ui-foundation', 'D2'), E('ui-foundation', 'D5'), E('ui-foundation', 'G3')] },
  'URS-084': { type: 'P', ref: 'OQ-17', tests: [E('ui-foundation', 'M2'), E('ui-foundation', 'M4'), E('ui-foundation', 'M5'), E('scan', 'S6'), E('scan', 'S9'), E('scan', 'S10')] },
  'URS-119': { type: 'GAP', ref: 'OQ-17', deviation: 'DEV-2026-10-25-06', note: 'NOT MET on the combined R2 tree: tests/a11y/axe-gate.cjs finds serious or critical violations on 13 of 28 scanned screens, 18 rules (tests/a11y/baseline.json, evidence e2e-run-*.txt). The gate fails on any new violation and on a baseline entry that no longer occurs.' },
  'URS-085': { type: 'P', ref: 'OQ-17', tests: [E('ui-foundation', 'X1'), E('ui-foundation', 'X3'), E('ui-foundation', 'X4'), E('ui-foundation', 'I2'), T('ui-inbox', 'a QA inbox excludes the records the QA officer entered')] },
  'URS-086': { type: 'P', ref: 'OQ-18', tests: [T('coa-reports', 'answers 409 for a sample in'), T('coa-reports', 'issues an Approved sample: a job, a numbered signed document'), T('coa-reports', 'two simultaneous issues produce consecutive numbers')] },
  'URS-087': { type: 'P', ref: 'OQ-18', tests: [T('coa-reports', 'an OOS result with a closed investigation prints "Does not comply"'), T('coa-reports-engine', 'complies only when every reported result is entered and none is out of specification'), T('coa-reports-engine', 'a missing value is not a pass')] },
  'URS-088': { type: 'P', ref: 'OQ-18', tests: [T('coa-reports', 're-issue gives COA-...-v2'), T('coa-reports', 'two simultaneous re-issues of the same version')] },
  'URS-089': { type: 'P', ref: 'OQ-18', tests: [T('coa-reports', 'verify is valid for an untouched run, and a one-byte change'), T('coa-reports', 'a changed snapshot fails verify')] },
  'URS-090': { type: 'P', ref: 'OQ-19', tests: [T('oos-workflow', 'closing as Invalidated without an assignable cause'), T('oos-workflow', 'the investigator cannot confirm the cause they are assigned to'), T('oos-workflow', 'closing by the assignee is rejected')] },
  'URS-091': { type: 'P', ref: 'OQ-19', tests: [T('oos-workflow', 'a retest needs a signed plan; the original analyst is refused'), T('oos-workflow', 'an Invalidated closure is refused while any retest under the plan is OOS')] },
  'URS-092': { type: 'P', ref: 'OQ-19', tests: [T('oos-workflow', 'a Phase I investigation past its due date appears as overdue')] },
  'URS-093': { type: 'P', ref: 'OQ-20', tests: [T('qms', 'a Major deviation cannot close without a linked CAPA'), T('qms', 'the signer of an approval or closure must not be the person who raised or owns the record'), T('qms', 'a Closed record is locked')] },
  'URS-094': { type: 'P', ref: 'OQ-20', tests: [T('qms', 'two (and eight) simultaneous creations'), T('qms', 'an edit carries the version predicate'), T('qms', 'a CAPA action past its due date is flagged overdue')] },
  'URS-095': { type: 'P', ref: 'OQ-20', tests: [T('qms', 'with the setting on, approving a specification without an Approved change control returns 409'), T('qms', 'the setting is off on installation and only Admin/QA change it')] },
  'URS-096': { type: 'P', ref: 'OQ-20', tests: [T('qms', 'an open Major or unclassified deviation linked to a batch blocks its release')] },
  'URS-097': { type: 'P', ref: 'OQ-21', tests: [T('docs-lifecycle', 'cannot become Effective without three distinct signatures and a QA role'), T('docs-lifecycle', 'making v3 Effective supersedes v2 in the same transaction')] },
  'URS-098': { type: 'P', ref: 'OQ-21', tests: [T('docs-lifecycle', 'a 20 MB PDF uploads with its sha256'), T('docs-lifecycle', 'a tampered file fails the download (409)'), T('docs-lifecycle', 'prints only an Effective version, numbers each copy')] },
  'URS-099': { type: 'P', ref: 'OQ-21', tests: [T('training-qualification', 'a user with an overdue mandatory assignment gets 403 QUALIFICATION_REQUIRED'), T('training-qualification', 'a QA override is signed, time-limited, flagged on each use, and revocable')] },
  'URS-100': { type: 'P', ref: 'OQ-21', tests: [T('training-qualification', 'certifying a non-LIMS module no longer sets the global signing flag')] },
  'URS-101': { type: 'P', ref: 'OQ-22', tests: [T('custody', 'Begin Testing on an unreceived sample returns 400'), T('custody', 'an out-of-range temperature blocks testing until QA signs')] },
  'URS-102': { type: 'P', ref: 'OQ-22', tests: [T('custody', 'aliquoting 5 mL from 20 mL creates a child and two ledger rows'), T('custody', 'the balance never goes negative'), T('custody', 'two aliquots at once from the last 6 mL'), T('custody', 'UPDATE and DELETE on the ledger are refused')] },
  'URS-103': { type: 'P', ref: 'OQ-22', tests: [T('custody', 'resolves a sample id that is not in any loaded list'), T('custody', 'an unknown code is 404 with a message'), T('custody', 'a reprint without a reason is refused'), U('custody/barcode', 'a burst under 35 ms per key ending in Enter is a scan')] },
  'URS-104': { type: 'P', ref: 'OQ-23', tests: [T('reagents', 'linking an expired lot, a quarantined lot or a retest-overdue lot is 400 naming the lot and the date'), T('reagents', 'PUT result with lotIds listing an expired lot is 400'), T('reagents', 'a lot that was usable when linked and has expired since blocks the save')] },
  'URS-105': { type: 'P', ref: 'OQ-23', tests: [T('reagents', 'a received lot is in Quarantine, its receipt is signed'), T('reagents', 'the receiver cannot release the lot (403 SOD_VIOLATION'), T('reagents', 'in_use_expiry = opening day + in-use shelf life'), T('reagents', 'the database refuses a component whose solution outlives the lot')] },
  'URS-106': { type: 'P', ref: 'OQ-23', tests: [T('reagents', 'reagent_transactions refuses UPDATE, DELETE and TRUNCATE'), T('reagents', 'lists the results measured with the lot, directly or through a solution')] },
  'URS-107': { type: 'P', ref: 'OQ-24', tests: [T('stability-programme', '8 month points x 2 conditions give 16 timepoints'), T('stability-programme', 'the sweep moves Scheduled to Due when the window opens and to Missed'), T('stability-programme', 'after the PC was off, the scheduler runs the sweep once at start-up'), U('stability/calendar', 'adds months on the calendar')] },
  'URS-108': { type: 'P', ref: 'OQ-24', tests: [T('stability-programme', 'editing an Approved protocol is refused (409 PROTOCOL_LOCKED'), T('stability-programme', 'creates a sample linked to its timepoint')] },
  'URS-109': { type: 'P', ref: 'OQ-25', tests: [T('em', 'a draft is not used; the author cannot approve it'), T('em', 'refuses a client-supplied status and every other server-controlled field'), T('em', 'an Analyst or a Reviewer changing a count gets 403')] },
  'URS-110': { type: 'P', ref: 'OQ-25', tests: [T('em', 'Grade A, 1 CFU: Action, with its excursion and its deviation'), T('em', 'an action-level result affects the batches in its room that day'), T('em', 'fixture: 3 consecutive alert-level results at a point and method are one finding'), T('em', 'the batch dossier lists only the EM results')] },
  'URS-111': { type: 'P', ref: 'OQ-26', tests: [T('worklists', 'ACCEPTANCE 1: an assignee without the method training is refused'), T('worklists', 'ACCEPTANCE 2: after release'), T('worklists', 'ACCEPTANCE 3a: a non-assignee entering a result gets 403 NOT_ASSIGNED'), T('worklists', 'ACCEPTANCE 3b: a 20-cell grid save yields 20 audit entries')] },
  'URS-112': { type: 'P', ref: 'OQ-27', tests: [T('tat-kpi', 'a Thursday 16:00 receipt with a 2-business-day SLA'), T('tat-kpi', 'matches the hand-computed on-time %'), U('business-calendar', 'Thursday 16:00, 2 business days, Fri-Sat weekend: due Monday 16:00')] },
  'URS-113': { type: 'P', ref: 'OQ-27', tests: [T('tat-kpi', 'every tile count equals the total of its list, for every role'), T('tat-kpi', 'has no composite score')] },
  'URS-114': { type: 'P', ref: 'OQ-28', tests: [T('audit-tamper-role', 'may read and append to the audit trail'), T('audit-tamper-role', 'cannot drop, disable or replace the guard triggers'), T('audit-tamper-anchors', 'passes the chain check on its own, and the anchor verification reports the mismatch'), T('audit-tamper-anchors', 'a chain cut back below an anchor is reported as truncated')] },
  'URS-115': { type: 'P', ref: 'OQ-28', tests: [T('audit-tamper-review', 'release returns 400 until an AUDIT_REVIEW covers the batch rows'), T('audit-tamper-clock', 'acceptance: a clock set back 10 minutes writes CLOCK_ANOMALY'), T('audit-tamper-clock', 'blocks every signature except the acknowledgement while the anomaly is open')] },
  'URS-116': { type: 'P', ref: 'OQ-29', tests: [T('qualified-modules', 'is QA only'), T('qualified-modules', 'writes the row, the audit entry and a verifiable signature bound to version 1'), T('qualified-modules', 'refuses writes with 403 MODULE_NOT_QUALIFIED'), T('qualified-modules', 'leaves other modules and the core alone'), T('qualified-modules', 'uses the version predicate'), T('qualified-ui', 'says in words that a NotQualified module is read-only'), E('scope', 'V3'), E('scope', 'V6'), E('scope', 'V9')] },
  'URS-117': { type: 'P', ref: 'OQ-29', tests: [U('validation-traceability', 'every Critical and High requirement has an executed test or an open deviation')] },
  'URS-118': { type: 'P', ref: 'OQ-30', tests: [E('login', 'L1'), E('login', 'L5'), E('client-shell', 'C6'), E('workbench', 'W6'), E('workbench', 'W9'), E('oos', 'O1'), E('qms', 'Q6'), E('qms', 'Q8'), E('coa', 'C5'), E('calibrate', 'K3'), E('audit', 'U2'), E('scan', 'S1')] },
};

// Executed evidence for requirements that were P* (code reading only) in the first package.
const VERIF_UPGRADE = {
  'URS-030': { type: 'P', ref: 'OQ-05', note: 'Established by executed rollback tests for the audit chain itself, the signature service, result entry, raw-data versions, quality-record auto-opening and the event outbox, not by sampling code. Write paths of other modules have no such test and remain open (DEV-2026-10-13-07).',
    tests: [T('audit-chain', 'a rolled-back transaction leaves no row and uses no sequence number'), T('esign-sign', 'if the record cannot be hashed, the change, the audit entry and the signature are all rolled back'), T('results-entry', 'a forced audit failure rolls back both the result and the investigation'), T('rawdata-versions', 'the version is written in the same transaction'), T('qms', 'opens one deviation per source inside the originating transaction, and none when that transaction rolls back'), T('events-outbox', 'a rolled-back change leaves no outbox row')] },
};

// First-package entries whose evidence changed: the desktop smoke script (tests/desktop-smoke.cjs) no longer gets past the first-run screen on the R2
// tree (it does not supply the first administrator), so URS-040 and URS-042 rest on the shell tests that do run.
const VERIF_REPLACE = {
  'URS-040': { type: 'P', ref: 'PQ-02', tests: [U('shell/entry', 'listens on loopback only by default'), U('shell/config', 'binds loopback by default and refuses a LAN address without LIMS_BIND_LAN'), D('desktop-shell', 'server answers /api/ready'), D('desktop-shell', 'port chosen once and stored')], note: 'The desktop checks ran on Linux under xvfb only (DEV-2026-10-13-06).' },
  'URS-042': { type: 'P', ref: 'PQ-02', tests: [D('desktop-shell', 'application window has no bridge'), D('desktop-shell', 'renderer is sandboxed'), D('desktop-shell', 'navigation to another site is blocked')], note: 'The desktop checks ran on Linux under xvfb only (DEV-2026-10-13-06).' },
  'URS-041': { type: 'P*', ref: 'PQ-02', deviation: 'DEV-2026-10-25-03', tests: [D('desktop-upgrade', 'backup passphrase is stored, not in clear text')], note: 'The stored backup passphrase is not clear text (executed), but the run used Electron\'s Linux backend and the database password and signing secret were not checked under Windows DPAPI. See DEV-2026-10-13-06 and DEV-2026-10-25-03.' },
};

// Risk assessment rows for R2 areas: [area, S, L, D, rationale, urs[]]
const GRA = [
  ['Results, raw data and calculations', 5, 3, 2, 'A wrong or unattributable value reaches a certificate; versions, hashes, review gates and server calculation make change visible.', ['URS-064', 'URS-065', 'URS-066', 'URS-068', 'URS-069', 'URS-070', 'URS-071', 'URS-072']],
  ['Instrument capture and machine integration', 4, 3, 2, 'Machine-entered values bypass the bench; acceptance by a named analyst, scopes and idempotency limit that.', ['URS-074', 'URS-075', 'URS-077', 'URS-078']],
  ['Certificates, OOS and quality records', 5, 3, 2, 'A certificate or a closure that misstates compliance releases a batch wrongly.', ['URS-086', 'URS-087', 'URS-090', 'URS-091', 'URS-093', 'URS-096']],
  ['Controlled documents, training and custody', 4, 3, 3, 'Uncontrolled documents or unqualified analysts; unreceived or overdrawn samples.', ['URS-097', 'URS-098', 'URS-099', 'URS-101', 'URS-102']],
  ['Reagents, stability and environmental monitoring', 4, 3, 3, 'Expired material or missed time points go unnoticed; the programmes compute them without user action.', ['URS-104', 'URS-105', 'URS-107', 'URS-109', 'URS-110']],
  ['Audit trail hardening and validated scope', 5, 3, 2, 'Rewriting history as the database owner; a module used without qualification.', ['URS-114', 'URS-115', 'URS-116', 'URS-117']],
];

const DEVIATIONS = [
  ['DEV-2026-10-25-01', 'Browser flows (tests/e2e) run against the built bundle on Linux with Chromium only. They do not cover the Electron window, Windows, or the Arabic-locale clock; the ELN, the AI assistant and voice input have no flow and no OQ.', 'Run the flows in the Windows CI job (DEV-06) and add ELN, AI and voice flows when those modules are qualified.', 'OPEN'],
  ['DEV-2026-10-25-02', 'The shell OQ (tests/security-controls.sh) was not retired and replaced by a Vitest suite: it still drives the built bundle with curl, which is the only OQ evidence that runs against the shipped server.', 'Keep both; port its checks to Vitest only if a bundle-level run is added to CI another way.', 'OPEN'],
  ['DEV-2026-10-25-03', 'URS-041 (secrets protected by the operating-system store) has no executed test on Windows; the Linux run used the plain-text backend. It is a Critical/High requirement carried by an open deviation instead of a passed test.', 'Execute IQ-W/PQ-02 on the target PC (see DEV-2026-10-13-06).', 'OPEN'],
  ['DEV-2026-10-25-04', 'Qualification status of the 15 catalogued modules is undeclared at installation: the register is empty, so no module is blocked. This package does not declare any module Qualified; that is a QA decision with an electronic signature.', 'QA reviews the OQ-10 to OQ-30 evidence and declares each module (Validation, qualified_modules).', 'OPEN'],
  ['DEV-2026-10-25-06', 'Accessibility: axe-core finds serious or critical violations on 13 of the 28 screens scanned on the combined R2 tree (select-name and button-name without an accessible name, aria-allowed-attr on the dashboard tiles, color-contrast, definition-list, scrollable-region-focusable, label-title-only). r2-ui-foundation reported 0 on 8 screens; later tracks introduced the findings. The screens belong to the tracks that built them.', 'tests/a11y/baseline.json lists every finding; the gate fails on a new one and forces the removal of a fixed one. Owners fix the screens (needsFromOtherTracks).', 'OPEN'],
  ['DEV-2026-10-25-07', 'tests/client-shell.cjs (r1-client-shell) has two stale checks on the R2 tree: A5 reads the header title before the hash router has updated it, and C11 to C14 drive the result-correction form that the result workbench replaced. The script is not owned by this track.', 'The owner updates the script; tests/e2e/known-failures.json lists both and forces their removal once they pass. The lock over an unsaved form (C1 to C10), the idle timer, session expiry and forced password change still pass.', 'OPEN'],
  ['DEV-2026-10-25-08', 'tests/desktop-smoke.cjs (r1-build-shell) stops at the first-run screen on the R2 tree: it does not supply the first administrator (ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD) that the installer now requires, so it prints no result line. It is not used as evidence any more; desktop-shell.cjs and desktop-upgrade.cjs (25 checks) pass and carry URS-040 to URS-042.', 'The owner updates the smoke script or retires it; the first-run path itself is exercised by desktop-upgrade.cjs.', 'OPEN'],
  ['DEV-2026-10-25-05', 'Writes that do not arrive as an HTTP request to the catalogued paths (scheduler and job handlers, the instrument folder agent, /api/v1 tokens) are not stopped by the NotQualified guard.', 'Decide per module whether the background writers must also read the register.', 'OPEN'],
];

// OQ protocols of release R2 (the steps are the executed tests of the verification map, listed by build.cjs from VERIF).
const OQ_R2 = [
  ['OQ-10', 'Master data (M17)', 'Real PostgreSQL 16, seeded users, migrations to 0300.'],
  ['OQ-11', 'Methods, calculations and suitability (M18)', 'As OQ-10.'],
  ['OQ-12', 'Result entry workbench (M19)', 'As OQ-10.'],
  ['OQ-13', 'Raw data integrity (M20)', 'As OQ-10; a temporary blob store.'],
  ['OQ-14', 'Instrument data capture (M21)', 'As OQ-10; a temporary watch folder.'],
  ['OQ-15', 'Machine integration API v1 (M22)', 'As OQ-10.'],
  ['OQ-16', 'Events, notifications, sockets and webhooks (M23)', 'As OQ-10; a local receiver on the loopback interface.'],
  ['OQ-17', 'User interface foundation (M24)', 'Built bundle in Chromium (tests/ui-foundation.cjs); axe-core.'],
  ['OQ-18', 'Certificates of Analysis and reports (M25)', 'As OQ-10.'],
  ['OQ-19', 'OOS investigation workflow (M26)', 'As OQ-10.'],
  ['OQ-20', 'Quality management (M27)', 'As OQ-10.'],
  ['OQ-21', 'Controlled documents and training (M28)', 'As OQ-10.'],
  ['OQ-22', 'Custody, storage and labels (M29)', 'As OQ-10.'],
  ['OQ-23', 'Reagents and standards (M30)', 'As OQ-10.'],
  ['OQ-24', 'Stability programme (M31)', 'As OQ-10.'],
  ['OQ-25', 'Environmental monitoring (M32)', 'As OQ-10.'],
  ['OQ-26', 'Worklists (M33)', 'As OQ-10.'],
  ['OQ-27', 'Turnaround and indicators (M34)', 'As OQ-10.'],
  ['OQ-28', 'Audit trail hardening (M35)', 'As OQ-10; a role without table ownership for the application.'],
  ['OQ-29', 'Validated scope and traceability (M37)', 'As OQ-10.'],
  ['OQ-30', 'Browser flows (M37)', 'Built bundle, throwaway database, Chromium (tests/e2e/run.cjs).'],
];

module.exports = { URS, FRS, VERIF, VERIF_UPGRADE, VERIF_REPLACE, GRA, DEVIATIONS, OQ_R2 };
