# r2-docs-training: controlled documents, training matrix and qualification gating (roadmap M28)

Release R2, wave W3 (with r2-coa-reports, r2-result-ui, r2-oos-workflow). Branch `claude/project-implementation-tirr4j`. Nothing is
committed; the wave gate commits. Companion file: `docs/changes/r2-docs-training.gate.patch` holds the wiring in files this track does
not own (see "For the gate"). Nothing in this record is a review, an approval or a signature.

This track was resumed after an interrupted attempt. That attempt left the migration, both schemas, the document and training modules,
the routes, the guard, both screens and five test files, and no gate patch, no record and no evidence. I reviewed all of it, kept it, fixed
one defect it contained (below), added the QA override form to the training screen, wrote the gate patch, and ran the suite, the shared
checks, the desktop tests, a browser session and mutation checks in a gate simulation. A second interruption came after this record was
written and before the report; the third session (2026-10-21) found the track files unchanged, re-verified everything in a fresh
simulation, ran the four W3 gate patches together, and fixed one defect in the gate patch itself (see "Re-verification").

Status: **complete once the gate patch is applied.** All four M28 acceptance criteria pass in the gate simulation (HEAD + this track's
files + this patch). In the shared tree without the patch the routes, the guard, the schedule and the backup of document files are not
wired, so `docs-lifecycle` and `training-qualification` fail there (404, no guard), by design, as for the earlier tracks.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, 0200) | `drizzle/0200_docs_training.sql`: tables `documents`, `document_versions`, `document_prints`, `training_curricula`, `training_curriculum_documents`, `training_assignments`, `analyst_qualifications`; guard functions and triggers; under the runner only: six meanings, eight permissions (positions 200 to 207) and their grants, and the LIMS software curriculum `LIMS-CORE` |
| Schema | `src/db/schema/documents.ts`, `src/db/schema/training.ts` (no drift from the migration: tested) |
| Document lifecycle | `src/server/documents.ts` (rules), `src/server/routes/documents.ts` (15 routes) |
| Training | `src/server/training/` (`assign.ts` assignment on effectivity and sync, `status.ts` overdue / qualification / derived software flag, `schedule.ts` the daily job, `entities.ts` signable types, `schemas.ts` strict inputs), `src/server/routes/training.ts` (matrix, certify, curricula, assignments, qualifications) |
| Result guard | `src/server/services/result-guards/qualification.ts` (`QUALIFICATION_REQUIRED`) |
| Screens | `src/components/Documents.tsx` (register, versions, signed steps, file upload and download, controlled copy and print log), `src/components/Training.tsx` (software training, assignments, my qualifications, QA override, curricula) |
| Tests | `tests/api/docs-lifecycle.test.ts` (11), `training-qualification.test.ts` (10), `docs-training-migration.test.ts` (5), `docs-training-backup.test.ts` (2), `docs-training-ui.test.ts` (4): 32 tests, real application and PostgreSQL 16 |

### The document lifecycle

`Draft -> InReview -> (reviewed) -> Approved -> Effective -> Superseded | Obsolete`; `InReview | Approved -> Draft` on return (reason).

* Only the author edits a Draft, attaches its file and submits it; the submission is the authorship signature (`DOCUMENT_AUTHORSHIP`).
  A Draft without a file is refused (409 `FILE_REQUIRED`).
* Review (`DOCUMENT_REVIEW`) by someone other than the author, approval (`DOCUMENT_APPROVAL`) by someone who is neither author nor
  reviewer (403 `SOD_VIOLATION`, audited `AUTHZ_DENIED`). Effectivity (`DOCUMENT_EFFECTIVE`) is allowed to the QA role only (the meaning's
  roles) and never to the author.
* Effectivity re-checks the three signatures of the current cycle on the signatures table (author, reviewer, approver; three different
  people; record version at or after the submission): 409 `SIGNATURES_INCOMPLETE` otherwise. A return to Draft voids the cycle.
* Making a version Effective, in the signing transaction: the previous Effective version becomes Superseded (audited), the change control
  is consumed when r2-qms requires one (409 `CHANGE_REQUIRED` before the password), and training is assigned (below).
* Every refusal that does not need the password comes first and costs the signer no attempt. Every step uses the version predicate (409).
* Files go into the content-addressed blob store (`BLOB_DIR/<sha256>`), are typed from their first bytes (PDF, Word/Excel, text) and
  limited by `ATTACHMENT_MAX_BYTES`; they are re-hashed on every download: a mismatch or a missing file is 409
  `DOCUMENT_INTEGRITY_FAILED` with an `IntegrityCheckFailed` audit entry.
* Controlled copies: only of the Effective version, numbered per version, logged in `document_prints` (append-only) and audited; the
  response carries the footer text (copy number, code, revision, printer, time, purpose, sha256, "valid only while revision N is
  effective").
* Database refusals (trigger `gxp_document_version_guard`): a submitted version's content cannot change, an Effective version only moves
  to Superseded or Obsolete, its approval record never changes, and no version is deleted or truncated.

### Training and qualification

* Curricula (`training.manage`, QA and Admin): roles (empty = every human role), documents, method code, mandatory, due days, read and
  understood or on-the-job. `isSoftware` is never accepted from a client; the one software curriculum is `LIMS-CORE`.
* Assignment: when a version becomes Effective, open assignments of earlier revisions are Superseded and each curriculum holding the
  document assigns the new version to every active user of its roles (due = today + due days), audited, in the signing transaction. A
  curriculum created or changed is synchronised at once; the daily job `training.overdue` (01:10) synchronises users and documents added
  since and marks every Assigned assignment past its due date Overdue, with an audit entry by the service principal.
* Completion: read and understood is signed by the trainee only (`TRAINING_ACKNOWLEDGEMENT`, training exempt, so an untrained user can
  still sign it: the SignatureModal rule); on-the-job training by a trainer who is not the trainee (`TRAINING_CERTIFICATION`). The
  signature covers the assignment, the document version and its file hash. A Completed assignment can never change (trigger).
* Qualification (result guard `qualification`): a result of a parameter bound to a method (specification parameter `method_code`) is
  refused with 403 `QUALIFICATION_REQUIRED` while the person entering it has an overdue assignment of a mandatory curriculum of that
  method (by `method_code`, or the method's `required_training_module` naming the curriculum code). The guard reads the due date itself,
  so it does not wait for the job. Nothing is written on a refusal.
* QA override (`QUALIFICATION_OVERRIDE`, QA only, reason required, at most 30 days, not for oneself, only for a gated method): while it
  covers today the entry is allowed and flagged with a `QualificationOverrideUsed` audit entry on the result, in the result's
  transaction. It can be revoked with a reason.
* The software-trained flag (`users.has_completed_software_training`, the global signing gate) is derived from the LIMS curriculum only:
  false while a LIMS assignment is overdue; true when none is overdue and the user completed a LIMS assignment or was certified for the
  LIMS module (code or title); otherwise unchanged. Certifying any other module records the training and nothing more.

## Why

M28 (QA-08, QA-09). The schema had no documents table; "SOP Training Matrix" was one boolean per user; Certify flipped the global signing
gate for any module; Overdue came only from the seed; result entry checked no qualification. 21 CFR 211.100 and 211.25 need written,
approved procedures and trained personnel; Part 11.10(i) needs trained users of the system.

topDefects in this scope: "TOTP secrets leaked by GET /api/training" (already fixed by r1-identity; the matrix now also lists only the
four human roles and the test asserts no secret is serialised) and "Overdue training is never set / no scheduled jobs" (the daily job
above). The others are outside this track.

### Defect found in the review of the interrupted attempt (fixed test first)

* **Certification could not be signed.** The attempt's `POST /training/:userId/certify` called `signRecord` with entity type `User`,
  which no module registers, so every certification would have been 400 `UNKNOWN_ENTITY_TYPE`. The signature is now on the training
  record the certification creates (new signable type `TrainingRecord`: user, module, certifier, time). The test that asserted a
  signature on `User` was changed to look for it on the training record; it failed on the attempt's code before the fix.

## Deliberate behaviour changes (with the gate patch)

1. 25 new routes (15 documents, 10 training); 8 permission codes (81 in all); 6 meanings (34 on a fresh install, 36 with r2-coa-reports);
   new triggers on `document_versions`, `document_prints` and `training_assignments` (`document_prints` joins the lims_app insert-only
   tables: 19).
2. `POST /training/:userId/certify` is a real e-signature (`TRAINING_CERTIFICATION`, with `totpCode` when MFA is on) on a
   `TrainingRecord`; its audit entry is `Certify` on `TrainingRecord`, and the flag change is a separate `Update` on `User`. Certifying a
   module other than the LIMS curriculum no longer enables signing.
3. `GET /training` lists the four human roles only (no service accounts) and adds `curricula` and `assignments`.
4. Result entry on a method-bound parameter can be 403 `QUALIFICATION_REQUIRED`. Samples without a bound method are unaffected.
5. The backup's blob section carries the files of document versions as well as attachments; a missing document file refuses the backup.
6. A new schedule `training.overdue` (daily 01:10, server time) is created at start-up.

## How to verify

```
# gate simulation: HEAD + this track's files + git apply docs/changes/r2-docs-training.gate.patch + the regenerations below
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/docs-lifecycle.test.ts \
  tests/api/training-qualification.test.ts tests/api/docs-training-migration.test.ts tests/api/docs-training-backup.test.ts tests/api/docs-training-ui.test.ts
npx vitest run            # whole suite
npm run lint
```

## Evidence (gate simulation `scratchpad/r2dt-sim`: `git archive HEAD` + this track's files + the patch; databases `lims_r2_docs_training*`, port 3110)

* **Test first (RED).** The five test files on HEAD's code: 5 files failed, 21 tests failed (2 skipped): every document route 404, no
  `training_curricula`, modules missing; and, on behaviour, `certify` of "GMP Basics" set the signing flag (acceptance 4). The certify
  defect above failed its test before the fix.
* **Acceptance (M28)**, all in the simulation:
  1. no Effective without author, independent reviewer and independent approver signatures and the QA role (Admin, Reviewer and Analyst
     403; reviewer as approver 403 `SOD_VIOLATION`; a missing review signature 409 `SIGNATURES_INCOMPLETE`); v3 Effective supersedes v2
     in the same transaction (same `xmin`);
  2. a 20 MB PDF uploads and downloads byte-identical; a tampered blob is 409 `DOCUMENT_INTEGRITY_FAILED` with an
     `IntegrityCheckFailed` audit row by the downloader;
  3. an overdue mandatory assignment gives 403 `QUALIFICATION_REQUIRED` (before and after the job marks it Overdue); a qualified analyst
     and another method are not affected; completing the training lifts it; a QA override is signed, max 30 days, flagged, revocable;
  4. certifying a non-LIMS module leaves the flag false; the LIMS module sets it; an overdue LIMS assignment clears it (signing 403
     `TRAINING_REQUIRED`, the acknowledgement still allowed) and completing it restores it.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 123 files passed, 2 skipped; 1469 tests passed, 3 skipped, 0 failed (the
  first run found the two gate-patch test edits below; after them the two files pass: 44 tests). Migration suite
  (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 identical
  (2352 lines of pg_dump) and journal.
* `npm run lint`: web clean; server 18 known baseline errors, none new. In the shared tree without the patch my files are type-clean
  (the errors there are r2-result-ui's `evaluate.ts` and r2-oos-workflow's test, in flight).
* `npm run build`; `dist-server/init-db.cjs` (20 migrations to 0200; lims_app: 19 insert-only tables, 42 guard triggers); demo seed;
  production bundle on 127.0.0.1:3110: start-up anchor check "0 checked, the audit trail matches"; `tests/security-controls.sh` 34 PASS,
  0 FAIL; `tests/backup-restore.sh` (server's JWT_SECRET exported) 18 PASS, 0 FAIL.
* API smoke on the bundle: analyst drafts and uploads, submits; reviewer reviews; Admin approves; Admin "effective" 403
  `ROLE_NOT_ALLOWED`; QA makes it Effective; the download hash matches; `GET /training` lists 5 users and `LIMS-CORE`.
* Browser (Playwright Chromium, same server, scratch script): Controlled Documents in the navigation; register shows the Effective
  revision; QA sees print and withdraw; the signatures of the cycle are listed; a controlled copy shows its numbered footer and the print
  log; "Draft new revision" drafts Rev 2; the training screen shows every section; the QA override opens the signature dialog with its
  meaning, and a refused override (unknown method) shows the server's message as a toast; no uncaught exception.
* Desktop, after `npm run build` in the simulation: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed. `npm run check:root`: clean.
* Mutation checks (each must turn a track test red; 8 of 9 did, the ninth is equivalent): guard not registered; cycle signatures not
  checked; previous version not superseded; document files left out of the backup; download not re-hashed; job not marking Overdue;
  overdue LIMS assignment not clearing the flag; any certified module deriving the flag. "Any module refreshes the flag" survived because
  the derivation itself only counts the LIMS module (defence in depth, not a gap).

## Re-verification (third session, 2026-10-21; simulations `scratchpad/r2dt-v3` and `scratchpad/r2dt-all`)

* The track files in the shared tree are byte-identical to the ones verified in the earlier simulation; HEAD (7df6e8e) has not moved,
  and the gate patch applies cleanly to HEAD and to the shared tree (`git apply --check`).
* **Defect in the gate patch, found by running the W3 patches together, fixed.** The upgrade-test hunk that strips the run time of the
  `LIMS-CORE` curriculum ended with the closing `});` of `strip` as context. After r2-oos-workflow's patch adds lines there, `patch -F3`
  placed the line before `...snap`, which then overwrote it, and the rollback comparison failed on `training_curricula.created_at`
  (seen: 1 failed). The hunk now inserts the line right after `...Object.fromEntries(MASTER_DERIVED ...)`, context no other patch
  touches; it lands correctly alone and after the other three patches (`patch --dry-run`), and the upgrade suite passes both ways.
* Fresh single-track simulation (`git archive HEAD` + track files + patch + regenerations: 25 routes added, none removed; 81
  permissions): track tests plus `auth-lifecycle` 6 files, 66 passed; `npx vitest run` 123 files passed, 2 skipped, 1469 tests passed,
  3 skipped, 0 failed; upgrade suite (`-c tests/upgrade/vitest.config.ts`) 11 files, 60 passed (one earlier run of it, between two
  other heavy runs, had 1 failure that I did not capture; five reruns, before and after, all passed: noted, not explained);
  `npm run lint` web clean, server "18 known error(s) in the baseline, none new"; `npm run build`; `dist-server/init-db.cjs` to 0200
  (lims_app: 19 insert-only tables, 42 guard triggers); demo seed; bundle on 127.0.0.1:3110 (anchor check "0 checked, the audit trail
  matches"); `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL; API smoke as before (Admin
  "effective" 403 `ROLE_NOT_ALLOWED`, QA 200, download hash matches); `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed. Server stopped (own PIDs only).
* Combined W3 simulation (copy of the shared working tree + the four gate patches in the order above + the two hand merges + the
  regenerations: 84 permissions): `npx vitest run` 132 files passed, 2 skipped; 1572 tests passed, 3 skipped, 0 failed; upgrade suite
  11 files, 60 passed. r2-oos-workflow had no change record yet when this ran, so this is a snapshot of in-flight work, not the gate.
* In the shared tree (no patch) this track's files are type-clean (`tsc -p tsconfig.server.json` and `tsconfig.web.json`: no error in
  them).

## For the gate

1. `git apply docs/changes/r2-docs-training.gate.patch` (cut against HEAD; it applies cleanly to the shared tree). It changes:
   * `src/server/routes/index.ts`: register `documentsRoutes`.
   * `src/server/authz/routeTable.ts`: 25 rules with this track's strict schemas as `body`; `POST /training/:userId/certify` takes
     `certifySchema` (adds `totpCode`) instead of r1-identity's `certifyTrainingSchema`, which is then unused.
   * `src/lib/permissions.ts`: the eight codes; `doc.view`, `doc.author`, `doc.print`, `training.acknowledge` to everyone; `doc.review` to
     Reviewer and QA; `doc.approve`, `training.manage`, `training.override` to QA (Admin holds all). These match the migration's grants.
   * `src/db/schema/index.ts`: export `./documents` and `./training`.
   * `src/db/protections.ts` and a new `src/db/protections/documents.ts`: the same guard functions and triggers as the migration.
   * `src/server/services/result-guards/index.ts`: `userId` in `ResultGuardInput`, `qualificationRequired` in `RESULT_GUARDS`;
     `src/server/services/saveResult.ts`: passes `userId: user.id`.
   * `src/server/jobs/handlers/index.ts` and `src/server/schedules/index.ts`: `TRAINING_HANDLERS`, `TRAINING_SCHEDULES`.
   * `src/server/backup-blobs.ts`: the blob register is attachments plus `document_versions.file_sha256`.
   * New `src/components/shell/ext/documents.tsx`: "Controlled Documents" under Laboratory Controls.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: 34 meanings and the one `training_curricula` row; its run time (`created_at`) stripped in
     the rollback comparison, as for `qms_settings` (the strip line sits right after `...snap`, so that `...snap` cannot overwrite it).
     No assertion removed.
   * `tests/api/auth-lifecycle.test.ts` (r1-identity's): the one `Certify` audit entry is looked for on the `TrainingRecord` instead of
     `User` (behaviour change 2). Same strength: exactly one per certification.
2. With the other W3 patches applied first (order r2-coa-reports, r2-result-ui, r2-oos-workflow, then this one; `patch -p1 -F3`), two
   hunks of this patch need a hand merge, the same two that r2-oos-workflow's patch needs after r2-coa-reports':
   * the `protectionSets` line in `src/db/protections.ts`: `..., rawdataProtections, reportsProtections, oosProtections, documentsProtections]`;
   * the meanings count in the upgrade test: 28 + 2 (0190) + 6 (0200) + 3 (0210) = **39**, with the three comments, and
     `training_curricula` joining `qms_settings`, `audit_review_settings`, `oos_settings` in the "1 row" case (`oos_checklist_templates`: 2).
     With r2-coa-reports alone it is **36**.
   Every other hunk applies with fuzz. Tested: the combined tree (shared working tree + the four patches + these two merges + the
   regenerations) passes the whole suite (below).
3. Regenerate after all patches: `npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (with SQL_* and
   JWT_SECRET set; 25 routes added, none removed), `npx tsx scripts/authz/export-matrix.ts` (81 permissions alone),
   `npx tsx src/server/boot/migrate-cli.ts export-schema`.
4. Without step 1: `docs-lifecycle`, `training-qualification`, `docs-training-backup` (no document files in the backup), and the
   catalog checks (`authz-matrix`, `authz-migration`, `upgrade-v0.1.0`, `desktop-schema`, `schema-drift`) fail in the shared tree, by design.

## Decisions that need confirmation (conservative defaults implemented)

* Migration number 0200 (the task's reserved 0200 to 0209); the roadmap's `ownsFiles` names `drizzle/019*`, which r2-coa-reports uses.
* Grants: every role may draft documents and print controlled copies; Reviewer and QA review; QA and Admin approve and withdraw; only QA
  makes a version Effective; only QA signs a qualification override.
* The person making a version Effective must not be its author, but may be its reviewer or approver (the three distinct people are
  author, reviewer and approver).
* Qualification blocks on an **overdue** mandatory assignment, as the roadmap states; an analyst still within the due period (or not yet
  assigned) is treated as qualified. A stricter rule (Completed required before first use) is a one-line change in `status.ts`.
* Override: at most 30 days, reason required, never for oneself, revocation unsigned (with a reason and an audit entry).
* Software flag: an existing installation keeps the values it has; the flag only changes when the LIMS curriculum says so. `LIMS-CORE` is
  installed with no documents, all roles, on-the-job, due in 30 days: QA must give it its content.
* Default due period 30 days, periodic review 24 months, job at 01:10 server time; assignments use the server's calendar day.
* Accepted file types: PDF, Office (zip: docx/xlsx) and plain text, up to `ATTACHMENT_MAX_BYTES`.
* The effective date is the moment of the QA signature (no future-dated effectivity).
* Removing a document from a curriculum cancels its open assignments; a role change does not cancel the old role's assignments.

## Not done

* **The controlled-copy footer is not stamped into the file.** The server issues the numbered footer text and logs the copy; the user
  prints the file with it. Watermarking the PDF itself needs a PDF writer for arbitrary input files.
* **Periodic review** is computed and flagged in the register (`reviewDue`, "Review overdue"); there is no review workflow or reminder.
* **No notifications** (r2-events outbox) for new or overdue assignments; the matrix and the guard show them.
* **UI gaps:** curricula are created on the screen but edited (documents, roles) through `PUT /training/curricula/:id` only; manual
  assignments are API only.
* **Demo seed** has no documents or curricula (the seed is not this track's); its legacy `training_records` rows are unchanged.
* **ELN templates** remain unversioned (named in M28's evidence, not in its design).
* **Validation package**: no URS, OQ or RTM entries for M28 (r2-validation).
