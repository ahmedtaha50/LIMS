# r3-periodic-archive: periodic review, retention and legal hold, verifiable batch archive (roadmap M42)

Release R3. Branch `claude/project-implementation-tirr4j`. Nothing is committed; the wave gate commits.
Companion file: `docs/changes/r3-periodic-archive.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** The three M42 acceptance criteria pass in a gate simulation (HEAD `67f8f43` + this track + the gate patch, in a private copy):

1. `archiveBatch` produces a bundle that passes `verifyArchive`; one altered file, one removed file, one extra file, and a manifest replaced together with a file each fail it. Archived records answer **423** on update.
2. A due user-access review shows on the QA dashboard (`GET /dashboard` field `periodicReviewsDue`, and a card), and completing it needs a QA e-signature.
3. A record class under legal hold cannot be flagged for purge (service **and** database trigger).

In the shared tree without the patch the new routes have no route-table rule (deny by default), the two new event types are not in the catalog, and the permissions are not in `src/lib/permissions.ts`, so `tests/api/periodic-archive.test.ts` cannot pass there.

## What changed

| Area | Files |
|---|---|
| Migration 0330 | `drizzle/0330_periodic_archive.sql`: 7 tables, guard triggers, 4 signature meanings (QA only), 6 permissions |
| Schema | `src/db/schema/periodic.ts` |
| Periodic review | `src/server/periodic/index.ts` (plans, reviews, completion rules, due list), `src/server/periodic/evidence.ts` (evidence per kind) |
| Retention and legal hold | `src/server/retention.ts` |
| Archive | `src/server/archive.ts` (bundle builder, `verifyArchive`, QA decision, `restoreArchive`, 423 guard) |
| Scheduler and queue | `src/server/schedules/periodic.ts`: jobs `periodic.scan` (daily), `archive.verify` (weekly), `archive.build` (queued on request) |
| Routes | `src/server/routes/periodic-reviews.ts` (one factory `periodicRoutes`, 25 routes) |
| Screen | `src/components/PeriodicReviews.tsx`, `src/components/shell/ext/periodic-reviews.tsx` (a shell extension: one new file, no shared screen edited; also exports `DueReviewsCard` for the dashboard) |
| Test | `tests/api/periodic-archive.test.ts` (19 tests, real PostgreSQL 16) |

### Periodic review (Annex 11 s.11)

* A **plan** says what is reviewed (kind: `user_access`, `instrument`, `specification`, `method`, `document`, `module`, `system`; subject), every how many months, the next due date and a checklist (template per kind, editable).
* The daily `periodic.scan` opens the review of every plan due within 14 days. **Opening snapshots the evidence** (JSON, SHA-256 of the canonical JSON stored, trigger forbids any edit):
  * `user_access`: users x role x last sign-in x software training x open/overdue training assignments x MFA x locked x dormant (no sign-in for 90 days). No credential, hash or secret is in it (the test greps for them).
  * `instrument`: calibration state and last 12 calibrations, usage events, results recorded with it, signatures.
  * `specification`, `method`, `document` (SOPs: effective version, review period, overdue by period), `module` (the validated-scope declaration of r2-validation and its signatures).
  * `system`: the annual evaluation pack over 12 months: deviations/CAPA/change records opened, closed, open, overdue; backups (ok, failed, verified); restore tests; audit-review coverage; audit-chain verification result; qualified modules; security events by outcome; periodic-review status.
* **Overdue alerts** go through the events outbox: `periodic.review_due` at 7 days, on the due date, then every 7 days while overdue (threshold 7, 0, -7, -14, ...), once per (review, threshold) even if the scan runs twice.
* The reviewer saves the checklist answers and findings (`PUT`, optimistic concurrency, audited). **Completion needs a QA e-signature** (`PERIODIC_REVIEW`) bound to the record version; the signature covers the conclusion, the answers, the findings, the summary and the evidence hash. Rules checked **before** the signer is asked: every checklist item answered, every "No" explained, a `Satisfactory` conclusion cannot stand with a "No" or a Major/Critical finding, a non-satisfactory one needs a finding.
* Completion moves the plan one interval from the date it was due (no drift; if that is already past, one interval from today). A Completed or Cancelled review cannot be changed and no review can be deleted (trigger).

### Retention, legal hold (Annex 11 s.17, 211.180)

* `retention_policies`: **no row, or NULL years, means keep indefinitely** (the conservative default). The application ships **no number**; QA sets one per record class with a signature (`RETENTION_POLICY`, basis required).
* `legal_holds` (class or one record): placed and released with QA signatures (`LEGAL_HOLD`). While a hold is Active, nothing of that class can be flagged: the service answers **423 LEGAL_HOLD** and `retention_flags` has a trigger that refuses it for every other path. The same trigger refuses a flag on a record that is not archived.
* `retention_flags`: "this archived record may be considered for disposal". It is only a flag. **There is no purge function; nothing deletes a GxP record.** The retention clock starts when the record was archived.
* `GET /retention/candidates` lists archived records whose retention ran out and that no hold covers.

### Archive bundles (Annex 11 s.17)

* `buildBatchBundle` (queued as job `archive.build`, preconditions also checked in the request): for a **Released or Rejected** batch whose samples are all Approved/Rejected and with no open OOS, exports into `ARCHIVE_DIR/<bundleId>/`: `data/<table>.json` (products, specifications, instruments, batch, samples, results, result versions, attachments, review checklists, OOS, release, CoA documents, CoA report runs, signatures), `data/actors.json` (id, name, role; no credentials), `audit/audit_trail.json` (the audit slice with `hash`, `prevHash`, `seal` as recorded), `reports/<run>.pdf` (the CoA PDFs), `blobs/<sha256>` (the raw-data files, each verified before copying), `README.txt`, `MANIFEST.json` (every file with SHA-256 and size) and `MANIFEST.sha256`. Open formats only (JSON, PDF, the original files). Files are written 0444 and folders 0555. `ARCHIVE_DIR` defaults to an `archives` folder next to the backups folder.
* `verifyArchive(dir, { expectedManifestSha256 })` needs no database: it re-hashes every file, refuses a missing, altered or extra file, and with the manifest hash recorded in the register also refuses a manifest swapped together with a file. `POST /archive/bundles/:id/verify` records the result; the weekly `archive.verify` re-checks every archived bundle and announces a failure (`archive.verification_failed`).
* **The QA decision** (`ARCHIVE_DECISION`, bound to the manifest hash): re-verifies the bundle, takes row locks, rebuilds the export from the live records and **refuses (409 ARCHIVE_STALE) if any table differs from the bundle** (a record changed since the build is never archived blind), then writes the sidecar `archived_records` (Sample, Result, ProductBatch, BatchRelease, CoaDocument) in the same transaction as the signature and the audit entry.
* **Archived records are read-only**: HTTP writes to them answer **423 ARCHIVED_RECORD** (`archivedRecordGuard`, mounted after the authorisation layer), and triggers on `samples`, `results`, `product_batches`, `batch_releases`, `coa_documents` refuse an UPDATE or DELETE from any other path. No row of a GxP table is altered by archiving; the audit chain still verifies (tested).
* **Restore** (`restoreArchive`): verifies the bundle, then inserts the rows the target lacks (`ON CONFLICT DO NOTHING`), compares every row that exists field by field (never overwrites), restores the raw-data files into the blob store, and reports. Users must exist in the target (no credentials in a bundle). `dryRun` rolls back, which is `POST /archive/bundles/:id/restore-check` against the live database. The audit trail is not copied back (append-only, chained, stays in the database; the bundle carries the slice as evidence).

## How to verify

In a tree with the gate patch applied (the track's own gate simulation is described below):

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r3_periodic_archive
npx vitest run tests/api/periodic-archive.test.ts
```

The round trip is the test "restore round trip: the bundle restores into an empty database and every row equals the original": it builds a bundle, restores it into a second database made from the template (fresh install, same users), compares six tables field by field with the originals and the PDF byte by byte, restores again (nothing inserted), and then changes one row in the target (the restore reports it and writes nothing).

By hand: `npx tsx src/server/boot/migrate-cli.ts export-schema`, start the server, `POST /api/archive/bundles {batchId}`, then `sha256sum -c` over the files of `MANIFEST.json`.

## Decisions for the user

1. **Retention numbers.** None are shipped; every class is kept indefinitely until QA signs a number and a basis. The class list (`RECORD_CLASSES` in `src/server/retention.ts`) and which archived entity types belong to which class are my proposal. Only `sample-records` and `batch-records` have archivable entities today; the other classes can carry a policy and a hold but nothing in them is archived yet.
2. **Retention clock starts at the archive date**, not at the record or release date (later start = longer retention = the conservative side).
3. **Who signs.** All four meanings (`PERIODIC_REVIEW`, `ARCHIVE_DECISION`, `RETENTION_POLICY`, `LEGAL_HOLD`) allow the QA role only; Administrator holds the permissions but the signature service refuses the role. Reviewer reads. Whether the person who reviews user access may review their own access (no separation rule is enforced between the person who opens a review and the signer) is a SoD decision.
4. **Dormant user = no sign-in for 90 days** and **a review opens 14 days before it is due**; alert thresholds 7 / 0 / weekly overdue. All are constants (`DORMANT_DAYS`, `OPEN_LEAD_DAYS`, `alertThreshold`), not regulatory numbers.
5. **Default checklists** per kind (`DEFAULT_CHECKLIST`) and the default intervals (none: the plan creator chooses 1 to 120 months) need QA approval.
6. **What counts as a "finished" batch** (Released or Rejected; all samples Approved/Rejected; no open OOS) and **what a batch bundle contains** (list above; not included: custody events, stability, EM, reagent usage, ELN, QMS records linked to the batch).
7. **Archiving locks five record types**, not the child tables (result versions, attachments, review checklists stay insertable/updatable in the database). Adding triggers to more tables is a one-line change per table.
8. **The module `periodic-archive`** is added to the validated-scope catalog (gate patch), so QA can declare it NotQualified like the others; nothing is blocked at installation.

## Not done

* **No automatic purge, by design.** A flagged record is not removed; the disposal procedure (who may delete, from where, with what evidence) is outside this track.
* **Bundles are not copied to the backup mirror** and are not inside the encrypted database backup (only the register rows and manifest hashes are). Copy `ARCHIVE_DIR` with the mirror; the bundle verifies on its own. A job that mirrors them is not built.
* **Only the batch bundle** is implemented (the register's `kind` check allows only `batch`); no archive of documents, stability studies, EM, QMS records or instruments.
* **Read-only folders are not a security boundary** (a root user or the owner can chmod). The hash in the register, the signature bound to it and the weekly check are the controls.
* **Restore of the audit slice into a database** is not done (see above); the slice is evidence in the bundle.
* **No browser (Playwright) run** of the new screen; it is covered by `tsc`, `eslint` (jsx-a11y) and the shell screen tests. The retention policy and hold flows on the screen were not exercised in a browser.
* **Dashboard**: the card is added through the gate patch to `Dashboard.tsx`; the QA role has no dashboard of its own, so it shows for every role that may read the dashboard. The server field is the contract.
* **Time-zone**: due dates are calendar days (UTC), like `calibration_due_date`.
* **Test-first was not followed.** The feature did not exist, so there is no old behaviour to fail against: I wrote the code and the tests together and fixed both until they agreed. The "fails on the old code" evidence is therefore only that every route, table and trigger the test needs is absent on HEAD.

## Defects found on the way

* `drizzle-kit`'s `pushSchema` (used by `tests/upgrade/schema-drift.test.ts`) fails on any table with a composite primary key (`there is no parameter $1`). `archived_records` therefore has a synthetic `id` and a unique index on `(entity_type, entity_id)`; the foreign key from `retention_flags` onto that pair was replaced by a trigger.

## For the gate

1. `git apply docs/changes/r3-periodic-archive.gate.patch` (14 files, 86 lines): schema index, route registry, `app.ts` (the 423 guard), schedules and handler registry, event catalog (`periodic.review_due`, `archive.verification_failed`), the validated-scope catalog entry, `ARCHIVE_DIR` in `config.ts` and `.env.example`, the permission catalog and defaults, 25 route-table rules, the dashboard field and card, and the signature-meaning count of `tests/upgrade/upgrade-v0.1.0.test.ts` (48 to 52; every track of the wave that adds meanings edits that one number, so the gate sums them).
2. Regenerate the generated artefacts (not in the patch because three tracks of the wave change them): `npx tsx src/server/boot/migrate-cli.ts export-schema`; `npx tsx scripts/authz/export-matrix.ts`; `JWT_SECRET=... npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json`.
3. Keep migration numbers 0330 to 0339 reserved; this track uses only 0330.

## Needs from other tracks

* The wave gate (the patch above). No other track must change anything for this one.
