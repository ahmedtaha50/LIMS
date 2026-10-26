# r2-coa-reports: the controlled Certificate of Analysis and the register of generated documents (roadmap M25)

Release R2, wave W3. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion files, for the gate:

* `docs/changes/r2-coa-reports.gate.patch`: the wiring in files this track does not own (route registry, route table, permission catalog,
  schema index, protection registry, job handler registry, one expectation in the v0.1.0 upgrade test).
* `docs/changes/r2-coa-reports.sampledetail.patch`: **superseded, do not apply.** It removed the browser-side CoA generator from
  `SampleDetail.tsx` and mounted `CoaPanel`; r2-result-ui (owner of `SampleDetail.tsx`) has since made exactly that change in its own
  working-tree file (`grep CoaPanel src/components/SampleDetail.tsx`), so the patch no longer applies. It is kept only as a record.

Status: **complete once the gate patch is applied.** The four M25 acceptance criteria pass in a gate simulation (HEAD + this track +
the gate patch; whole suite green) and again in the combined W3 simulation. In the shared tree without the patch the coa routes are not
mounted, so `tests/api/coa-reports.test.ts` cannot pass there. (On 2026-10-21 that file does not even start in the shared tree: the test
app refuses to boot because r2-docs-training's in-flight `/training/*` routes have no route-table rule until its own gate patch; not this
track's code.) The engine, UI and migration tests pass in the shared tree as it is (26 of 26).

This track was resumed three times after a usage limit. The first attempt had left nothing in the working tree, so the work below was
done from the start in the second session, which then stopped just before its report. The third session reviewed that work against
HEAD `7df6e8e`, re-ran it in a simulation (`scratchpad/r2coa/sim3`) and fixed one defect (the copy request in `CoaPanel`, below), then
stopped before its report. The fourth session (2026-10-21) found every track file byte-identical to `sim3`, re-ran the track tests there,
reviewed the engine again, and ran the whole suite in a **combined W3 simulation** (all four W3 gate patches and every in-flight W3 file;
see "Re-run 2026-10-21" below). No code changed in this session; this document was updated.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, reserved 0190-0199) | `drizzle/0190_coa_reports.sql`: tables `coa_documents`, `report_runs`, `report_print_log`; the guard function `gxp_coa_documents_guard` and six `gxp_*` triggers; under the runner only: meanings `COA_AUTHORISATION`, `COA_VOID`, permission `coa.issue` (position 190) for Admin and QA, and the corrected description of `report.generate` |
| Schema and protections | `src/db/schema/reports.ts`; `src/db/protections/reports.ts` (the same guard text as the migration; a test compares them) |
| Engine | `src/server/reports/`: `snapshot.ts` (the frozen content: `buildCoaSnapshot`, `specText`, `conclusionOf`), `pdf.ts` (`renderCoaPdf`, `watermarkFor`; jsPDF on the server), `coa.ts` (eligibility, issue, re-issue, void, copies, reading), `runs.ts` (job `coa.render`, download with print log, verify), `entities.ts` (signable type `CoaDocument`), `schemas.ts` (strict request schemas), `index.ts` |
| Routes | `src/server/routes/coa.ts` (10 routes, below). `src/server/reports.ts` re-exports the engine; its `/reports/generate` route is unchanged |
| Preview | `src/server/pdfWorker.ts`: the job behind `POST /reports/generate` now renders through the same engine as a **preview**: no number, no copy, no authorisation, `PREVIEW - NOT ISSUED` on every page and "not a Certificate of Analysis" in the text |
| Screens | `src/components/CoaPanel.tsx` (new): eligibility and its reasons, issue / re-issue / void through `ElectronicSignatureModal` with the route's meaning code, the versions with their signatures, controlled copy download, verify. `src/components/Reports.tsx`: the browser "Batch Certification" generator is gone (replaced by the server register and the panel), the user-pickable "Document Status" is gone (every client export is stamped `Uncontrolled Copy`), tables are drawn with `autoTable(doc, ...)` |
| Tests | `tests/api/coa-reports.test.ts` (21), `coa-reports-migration.test.ts` (6), `coa-reports-engine.test.ts` (10), `coa-reports-ui.test.ts` (10) |

Files outside the ownership list that this change touches: **none**. The edits other files need are in the two patches.

### The certificate

* **Number.** `COA-<year>-<n>` (at least four digits) from `nextSequence(tx, 'coa:<year>')`, taken inside the signing transaction after
  the sample row is locked and every check has passed, so a refusal or a rollback uses no number. A re-issue keeps the number and
  increments `issue_version`; `label` is `<number>-v<issue_version>` (`COA-2026-0007-v2`).
* **When it can be issued** (`coaProblems`, checked before the password and again inside the transaction):
  1. the sample is Approved (otherwise 409 `SAMPLE_NOT_APPROVED`);
  2. every guard of the move to Approved still holds (`TRANSITION_GUARDS['Approved']`: results entered, result history intact,
     reintegrations approved, instruments in calibration, raw data attached and intact, system suitability, no open OOS);
  3. every release blocker holds for this sample (`RELEASE_BLOCKERS`, evaluated with the batch's sample list reduced to this sample: an
     open Major/Critical/unclassified deviation about the batch or sample, an audit-trail review when required).
  Otherwise 409 `COA_BLOCKED` with `details: [{ check, message }]`. A second issue while one is Issued is 409 `COA_ALREADY_ISSUED`.
* **Who.** Permission `coa.issue` (Admin, QA). The signer must not have registered the sample or entered or corrected one of its results
  (403 `SOD_VIOLATION`, recorded as `AUTHZ_DENIED`). The catalog also limits both meanings to QA and Admin.
* **Signature.** `signRecord` with `COA_AUTHORISATION` ("Authorisation of Certificate of Analysis: ..."), entity `CoaDocument`, bound to the
  version the issue produced (1), `sample_id` set so the sample page lists it. What it covers (`entities.ts`): number, issue version, label,
  sample, specification and revision, the snapshot hash, what it supersedes, the issuer, and the status as signed. The audit entry `Issue`,
  the document row, the signature and the job of the original PDF are one transaction.
* **Snapshot.** Frozen at issue in `coa_documents.snapshot` (hash `snapshot_sha256`, canonical JSON): sample, product and batch
  (manufactured, expiry, size; from `sample_context`, or for a free-text sample from the product of that name), customer, specification id
  and revision, one row per result with method (code and Effective revision from `spec_parameters.method_code`), the limit as printed
  (`NLT 98.0 %`, `NMT 0.50 %`, `98.0 - 102.0 %`, or the acceptance text; never `null - null`), value and unit, conclusion per row
  (Complies / Does not comply / Not entered), `AMENDED(n)` with every coded correction and its reason, and, for an OOS value replaced under
  its investigation, the **original** row (not reported, with the investigation and its decision) next to the **retest** row. The
  certificate's conclusion comes from the reported rows' evaluation flags only: any `is_oos` makes it "does not comply"; an investigation's
  decision never turns a failing flag into a pass. The sample's own signatures (submission, approval) are printed as the review chain.
* **Re-issue.** `POST /coa/documents/:id/reissue` with the reason and the version of the document the user saw: in one transaction the
  current one becomes Superseded (successor, who, when, reason; audit `Supersede`), the new issue is inserted with a new snapshot, signed
  `COA_AUTHORISATION` with the reason, and its original PDF is queued.
* **Void.** `POST /coa/documents/:id/void`, signed `COA_VOID` (reason required); audit `Void`. A voided certificate is not re-issued; a new
  certificate can be issued for the sample (a new number).
* **What the database refuses** (`gxp_coa_documents_guard`): any change of number, version, label, sample, specification, snapshot, hash,
  issuer, issue time or `supersedes_id`; a status move other than Issued to Superseded or Voided; a supersede or void record without its
  successor/actor/time/reason, or changed later; a second original PDF hash; DELETE and TRUNCATE. One Issued certificate per sample
  (partial unique index).

### Documents, copies, print log, verification

* Every PDF is a **report run** (`report_runs`, append-only): its bytes (`bytea`), sha256, size, copy number (gap-free per document, counter
  `report-copy:<document id>`), purpose (Original for copy 1, Copy after), the document state and the watermark it was printed with, the job,
  and the person it was made for. The job `coa.render` renders from the snapshot and the document's signatures and, in the transaction that
  completes the job, takes the copy number, inserts the run, records the original's hash on the document (`pdf_sha256`, `original_run_id`,
  with the version predicate) and writes the audit entries (`Create` on `ReportRun`, `Render` on `CoaDocument`). A lost lease rolls all of it
  back. A copy is refused until the original exists (the request then queues the original), so the original is always copy 1.
* **Watermark** from the state at the moment of the copy (`watermarkFor`): Issued none, Superseded `SUPERSEDED`, Voided `VOID`, preview
  `PREVIEW - NOT ISSUED`, anything else `NOT VALID`. Nobody passes a watermark in.
* **Download** (`GET /reports/runs/:id/pdf`): only the person the copy was made for (others request their own copy). The bytes are re-hashed
  first: a mismatch is 500 `REPORT_CORRUPT` and nothing is sent. Each delivery is a row of `report_print_log` and an audit entry, committed
  before the bytes go out. Header `X-Content-SHA256`.
* **Verify** (`GET /reports/runs/:id/verify`, `record.verify`): `valid` only when the stored bytes hash to the recorded sha256, the snapshot
  hashes to `snapshot_sha256`, an original matches the document's `pdf_sha256`, and the authorisation signature verifies (`signatures` verify,
  including the audit chain).

### API (permissions in the gate patch's route table)

| Route | Permission | Notes |
|---|---|---|
| `GET /coa/:sampleId` | `report.view` | `{ eligible, problems, current, documents }` |
| `POST /coa/:sampleId` | `coa.issue` | `{ password, totpCode?, reason? }`; answers `{ document, jobId, signatureId }` |
| `POST /coa/documents/:id/reissue` | `coa.issue` | `{ password, totpCode?, reason, expectedVersion }` |
| `POST /coa/documents/:id/void` | `coa.issue` | same body |
| `POST /coa/documents/:id/copies` | `report.generate` | `{}`; answers `{ jobId, purpose }` |
| `GET /coa/documents[?batch&sampleId&status]`, `GET /coa/documents/:id` | `report.view` | the register (newest 200); one document with snapshot, signatures and runs |
| `GET /reports/runs/:id` | `report.view` | metadata and print log, never the bytes |
| `GET /reports/runs/:id/pdf` | `report.generate` | the bytes, for the person the copy was made for |
| `GET /reports/runs/:id/verify` | `record.verify` | |

A job's status is the existing `GET /reports/status/:jobId` (owner only); its `result` is `{ documentId, runId, purpose }`.

## Why (gap M25 and the top defects in scope)

* "Five client or server generators disagree": the server CoA had no number, no stored copy, no signature and no re-issue; the browser
  generated certificates of its own. Now one engine renders every certificate and the preview; `Reports.tsx` no longer generates one, and
  the sample-screen generator is removed by the companion patch.
* Top defect: "Reports.tsx hard-codes the Approved watermark, lets the user pick it". The batch report stamped `Approved` computed in the
  browser, and the dynamic report offered a status drop-down. Both are gone; client exports are always `Uncontrolled Copy`.
* Found on the way: `Reports.tsx` called `(doc as any).autoTable(...)`. jspdf-autotable 5 attaches that method only to a global
  `window.jsPDF`, which the bundled application does not have, so the audit trail, OOS register, training matrix and custom PDF exports threw
  `doc.autoTable is not a function` (the screen showed a failure toast). They now call `autoTable(doc, ...)`.
* Found in the review of the resumed work: `POST /coa/documents/:id/copies` answers `purpose: 'Original'` when the original PDF does
  not exist yet (it queues the original again, for the issuer, whose job it is). The panel then waited on that job, and the status route
  is owner-only, so anyone but the issuer saw a misleading 403. The panel now says the original has been queued again and to ask for the
  copy once it is ready. (The button is disabled while the document has no original, so this only happens with a stale screen or after a
  failed original job.) This UI branch has no automated test: the panel is tested by server-side rendering, which does not run handlers.
* Top defects "pdfWorker stamps 'Official'" and "`null - null`" were fixed for the preview by r1-backup-jobs; the new engine keeps both out
  (`specText` never prints null; the old test still passes). "isOOS vs isOos": the engine reads `is_oos`.

## Deliberate behaviour changes

1. `POST /reports/generate` now makes a **results preview** (same route, same 409 for a sample that is not Approved, same job and file):
   titled "Results preview - not a Certificate of Analysis", marked `PREVIEW - NOT ISSUED`, without number or authorisation. The certificate is
   `POST /coa/:sampleId`.
2. The description of `report.generate` in the catalog and the database: "Request a results preview or a controlled copy of an issued
   certificate, and collect it" (was "Generate a Certificate of Analysis and collect it").
3. `Reports.tsx`: no Batch Certification PDF and no status picker; a "Certificates of Analysis" card lists a batch's certificates from the
   register and opens a sample's certificate panel.

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/coa-reports-engine.test.ts tests/api/coa-reports-ui.test.ts tests/api/coa-reports-migration.test.ts   # shared tree, no wiring (26)
# after the gate steps below:
npx vitest run tests/api/coa-reports.test.ts       # 21
npx vitest run && npm run lint
```

## Evidence (2026-10-20)

The simulation (`scratchpad/r2coa/sim`) is `git archive HEAD` plus this track's files plus `r2-coa-reports.gate.patch`, with
`tests/route-table.json`, `docs/permission-matrix.csv` and `desktop/schema.sql` regenerated. A second one (`sim2`) adds r2-result-ui's
in-flight files and gate patch and `r2-coa-reports.sampledetail.patch`.

* **Test first.** The four files were written before the code and run on the untouched tree: 31 failed, 0 passed (two files could not
  load their modules, the engine functions did not exist, and every `/api/coa` call answered 404). The Reports.tsx assertions were checked
  against the HEAD file: the client generator, the browser-computed Approved stamp, the status picker and `doc.autoTable` were all present,
  the register was not. One test expectation was wrong and corrected after the first green run: the issue signature is bound to version 1
  (rendering the PDF then makes the row version 2), not to the current version.
* **Acceptance (M25)**, all in `tests/api/coa-reports.test.ts`:
  1. `POST /coa` for a sample in Logged, Testing, Pending Review or Rejected is 409 `SAMPLE_NOT_APPROVED`, with a wrong password: no
     document, no number used, no attempt counted. An Approved guard failing (OOS without closed investigation) or a release blocker (open
     unclassified deviation about the batch) is 409 `COA_BLOCKED` naming it. For an eligible Approved sample it answers a job; the stored
     run's bytes hash to `pdf_sha256` on the run and on the document; the signature is `COA_AUTHORISATION` and verifies.
  2. An OOS result with a closed (Confirmed OOS) investigation prints `Does not comply`; the text never contains `ALL TESTS PASSED` nor
     "complies with the specification"; the snapshot's conclusion is false.
  3. Re-issue gives `COA-...-v2`; v1 is Superseded with its reason and successor, and the new row, the old row and the signature carry the
     same transaction id (`xmin`); the v1 signature still verifies. Seven simultaneous requests (two samples plus five for a third) give three
     consecutive numbers, the counter equal to the highest, exactly one certificate for the third sample and four 409 `COA_ALREADY_ISSUED`;
     two simultaneous re-issues give one 200 and one 409, issue versions 1 and 2.
  4. One byte changed in the stored report (the guard trigger has to be switched off to do it) fails `/reports/runs/:id/verify`
     (`pdfHash: false`) and the download refuses the bytes (500 `REPORT_CORRUPT`); a changed snapshot with untouched bytes fails it too.
* **Mutation checks** in a copy of the simulation, each must turn a test red: state check off, release blockers ignored, SoD off, OOS flag
  ignored in the conclusion, PDF hash not checked, snapshot hash not checked, owner check off on download, no supersede entry, trigger allowing a
  snapshot change, amendments not counted: all red at once. Two survived the first round and the tests were strengthened: removing the
  sample-row lock (the race test now fires five requests for one sample and expects four 409 `COA_ALREADY_ISSUED`), and a fixed watermark
  (the header now prints the state in normal case, so the capital `VOID`/`SUPERSEDED` can only come from the watermark). Both are red now.
* **Whole suite in the simulation:** `npx vitest run` 122 files passed, 2 skipped (opt-in scale tests); 1484 tests passed, 3 skipped,
  0 failed, no unhandled errors. My files three runs in a row: 61 of 61 (with `backup-jobs-reports`).
* **Lint:** in the simulation and `sim2`, web clean and server "18 known, none new". In the shared tree my files are clean; the web project
  currently fails on `src/server/lib/evaluate.ts` (r2-result-ui's in-flight work; its gate patch carries the fix).
* **Shared checks**, production bundle of the simulation on 127.0.0.1:3109, database from the shipped installer (20 migrations; the
  lims_app step reports 20 append-only tables and 42 guard triggers set to fire always) and the demo seed: `tests/security-controls.sh` 34 PASS,
  0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL, run once before and once after a certificate and its PDF (bytea) existed
  (`OQ09-restore-every-table-and-timestamp-identical` passes with the new rows). Over HTTP on the same server: Testing sample 409, issue
  `COA-2026-0001-v1`, the job completed by the production runner, PDF read with `pdftotext`, verify `valid`, another user's download 403.
* **Desktop**, after `npm run build` in the simulation: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed.
* **Browser** (Chromium, `sim2` bundle, QA then Analyst): the sample screen has no client CoA button; the panel signs with the catalog meaning
  after the attestation; the success toast names the number; "The original PDF is ready."; verify reports intact; a controlled copy downloads
  as a PDF; re-issue is offered; no panel on a sample in Testing; the Reports screen has no status picker and no client batch certification
  and lists the certificate for the batch; an Analyst sees no signing action, only the explanation; no page or console errors.

### Re-run after the resume (2026-10-20, HEAD `7df6e8e`)

* `git apply --check` of both patches on the current tree: both apply. `sim3` = `git archive HEAD` + this track's files + the gate patch,
  derived files regenerated.
* `npx vitest run` in `sim3`: 122 files passed, 2 skipped; 1484 tests passed, 3 skipped, 0 failed. Vitest reported 2 unhandled errors
  (`57P01 terminating connection due to administrator command`), both in `tests/api/qms-migration.test.ts`, on its own scratch database
  `..._qms_drift_3` during teardown. That file then ran 3 + 6 more times in `sim3` and 11 times on a bare `HEAD` archive: one more such error
  in `sim3`, none on HEAD. It is a teardown race in `tests/upgrade/helpers.ts`: the scratch pools have no `'error'` listener, so a backend
  killed by the forced `DROP DATABASE` while `pool.end()` is still closing reaches the process as an uncaught exception. This track's code
  does not open, end or terminate connections there; the fix belongs to the helper's owner (see below).
* After the `CoaPanel` fix: `npm run lint` (web clean; server "18 known, none new"); the track's files plus `backup-jobs-reports`: 61 of 61.
* The shared checks and the desktop tests above were not repeated: since that run, HEAD changed only two test files
  (`audit-tamper-anchors.test.ts`, `events/guard.test.ts`), and this session changed only the client `CoaPanel.tsx`.

### Re-run 2026-10-21 (fourth session, HEAD still `7df6e8e`)

* Every file of this track (migration, schema, protections, `src/server/reports/*`, `routes/coa.ts`, `reports.ts`, `pdfWorker.ts`,
  `Reports.tsx`, `CoaPanel.tsx`, the four test files) is byte-identical to `sim3`. In `sim3`: the track's tests plus
  `backup-jobs-reports` 61 of 61. In the shared tree: engine, UI and migration tests 26 of 26; `npm run lint:server` "18 known, none new";
  `tsc -p tsconfig.web.json` reports nothing in this track's files (it fails only on `src/server/lib/evaluate.ts`, fixed by r2-result-ui's
  gate patch). `git apply --check` of the gate patch on the shared tree: applies.
* A second review of the engine (issue, re-issue, void, copies, render job, download, verify) found nothing to change: actor from
  `req.user`, strict schemas, every write with its audit entry in the same transaction, `updateVersioned` on every update, signatures
  bound to the version they produce, checks repeated inside the transaction after the row lock.
* **Combined W3 simulation** (`scratchpad/r2coa/w3check`): `git archive HEAD`, then the gate patches of r2-result-ui, r2-docs-training,
  r2-coa-reports and r2-oos-workflow in that order (the rejected hunks merged by hand as listed under "For the gate"), then every in-flight
  file of the shared tree (all W3 tracks), derived files regenerated (84 permissions). `npm run lint`: web clean, server "18 known, none
  new". `npx vitest run`: 132 files passed, 2 skipped; **1572 tests passed, 3 skipped, 0 failed**. Vitest reported 3 unhandled errors: two
  `57P01 terminating connection due to administrator command` at teardown (scratch databases of `tests/api/backup-jobs-reports.test.ts`
  and `tests/upgrade/boot.test.ts`, killed by the forced `DROP DATABASE` while a pool was still closing) and one `Timeout calling
  "onTaskUpdate"` (worker RPC under load; other engineers' suites were running on the same machine). The two files then ran together four
  more times in the same simulation: 16 of 16 each time, no error. Same harness race as recorded above (no `'error'` listener on pools
  being ended at teardown); this track's code opens and ends no pool.
* The shared checks and the desktop tests were not repeated in this session: no code of this track changed since they passed.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: who issues (QA and Admin) and the independence rule; issuing requires every
Approved guard and the release blockers scoped to the sample; a certificate for a sample whose result is a confirmed OOS can be issued and
says "does not comply"; the wording of the two meanings; numbering per UTC year; the snapshot frozen at issue (a re-issue takes a new one);
copies only for the person who asked; PDFs kept in the database with no retention or purge; `/reports/generate` kept as a preview.

## For the gate

1. `git apply docs/changes/r2-coa-reports.gate.patch` (cut on HEAD; it touches `routes/index.ts`, `authz/routeTable.ts`, `lib/permissions.ts`,
   `db/schema/index.ts`, `db/protections.ts`, `jobs/handlers/index.ts`, `tests/upgrade/upgrade-v0.1.0.test.ts`). Other W3 tracks add lines next
   to the same anchors, so after theirs it needs a hand merge. Tried on 2026-10-21 in the order r2-result-ui, r2-docs-training,
   r2-coa-reports, r2-oos-workflow with `patch -p1`: this patch's hunks in `routes/index.ts`, `authz/routeTable.ts` and `lib/permissions.ts`
   apply with fuzz; four hunks are rejected and are all one added line next to the other tracks' line:
   * `src/db/schema/index.ts`: `export * from './reports';`
   * `src/db/protections.ts`: `reportsProtections` in `protectionSets` (the import line applies);
   * `src/server/jobs/handlers/index.ts`: `import { REPORT_HANDLERS } from '../../reports/index';` and `...REPORT_HANDLERS,` in `defaultHandlers()`;
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: the comment line and the meaning count. This track adds 2 meanings: 28 + 2 = 30 alone;
     with r2-docs-training (+6) and r2-oos-workflow (+3) the combined count is **39** (verified in the combined simulation).
2. ~~`r2-coa-reports.sampledetail.patch`~~: do not apply (already in r2-result-ui's `SampleDetail.tsx`).
3. Regenerate `tests/route-table.json` (10 routes added), `docs/permission-matrix.csv` (`coa.issue`; the new routes under `report.view`,
   `report.generate`, `record.verify`) and `desktop/schema.sql` (0190).

## Needs from other tracks

| Owner | Change |
|---|---|
| Gate | The two patches and the regenerations above |
| r2-result-ui (`SampleDetail.tsx`) | Done in its working tree (the client CoA generator is gone and `CoaPanel` is mounted). Still there: `coaCertification` (imported by tests) and the unused `handleGenerateReport` (now a preview) |
| Owner of `tests/helpers/testDb.ts` | Same teardown race as the next row, seen for `backup-jobs-reports.test.ts` under full-suite load: give the per-file pool an `'error'` listener before `end()` |
| r1-backup-jobs (`jobs/handlers/pdf.ts`) | The preview job still audits as entity `CertificateOfAnalysis` (action `Create`); a better name is `ResultsPreview`, which needs the edit there and in `backup-jobs-reports.test.ts` |
| r2-validation | URS/OQ/RTM entries for M25 (a new OQ script is needed per the roadmap); the four acceptance tests and the shared-check runs above are the material |
| Owner of `tests/upgrade/helpers.ts` | Give the scratch pools an `'error'` listener (`pool.on('error', () => {})`), so a connection killed by the forced drop at teardown cannot crash the run (seen intermittently in `qms-migration.test.ts`) |
| r2-oos-workflow, then this track (R2 follow-up) | r2-oos-workflow (in flight, W3) records retests in its own append-only `oos_retests` table and invalidation on `oos_investigations.invalidated_at`; the `results` row keeps the original OOS value. This track's snapshot takes original/retest rows only from a value replaced under its investigation (`result_versions.oos_id`), so for a sample released on an invalidated original plus passing retests the certificate prints the original row with `Does not comply` and does not list the retests. That errs on the safe side (never a false "complies"), but it is not the right certificate. Once 0210 is committed: which retest value is reportable is r2-oos-workflow's (a GxP rule), and the snapshot (`src/server/reports/snapshot.ts`) then prints the invalidated original as not reported with the investigation, and the reportable retest(s). Not built now, against a schema that is not merged yet |

## Not done

* The other client exports (audit trail, OOS register, training matrix, custom table, dashboard image) are still made in the browser, as
  working copies stamped `Uncontrolled Copy`; they are not registered in `report_runs`. Moving them to the server engine is further work.
* No retention or purge of `report_runs` bytes; every copy is kept in the database (and therefore in every backup).
* Non-Latin text (Arabic product or customer names) prints with jsPDF's standard fonts and will not render correctly; the bilingual print is
  M38.
* The preview (`POST /reports/generate`) is kept; whether to retire it is a decision (see above).
* No automatic void or warning when a sample is revoked (Approved to Rejected) after its certificate was issued: the panel still lists the
  certificate, and QA must void it.
* The retests of r2-oos-workflow's `oos_retests` (W3, not merged) are not on the certificate; an invalidated original prints as
  `Does not comply` (see "Needs from other tracks").
* Nothing was approved or signed for the validation package.
