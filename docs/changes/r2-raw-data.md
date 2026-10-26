# r2-raw-data: result versions, the attachment store, the review checklist (roadmap M20)

Release R2, second wave (beside r2-api-v1 and r2-events). Branch `claude/project-implementation-tirr4j`. Nothing is committed; the wave
gate commits it. Companion file: `docs/changes/r2-raw-data.gate.patch` holds the wiring in files this track does not own (see "For the
gate").

Status: **complete once the gate patch is applied.** All three M20 acceptance criteria pass in a gate simulation, and in a combined
simulation with r2-api-v1's patch. In the shared tree without the patch, the new routes are not mounted (deny by default: 404), so
`rawdata-versions`, `rawdata-attachments`, `rawdata-review` and `rawdata-backup` fail there, and the catalog, drift, desktop-schema and
upgrade tests see migration 0120 without its wiring (listed under "Evidence"). `rawdata-migration` and `rawdata-ui` pass in the shared tree.

## What changed

| Area | Files (all new, owned by this track) |
|---|---|
| Migration (forward-only) | `drizzle/0120_raw_data.sql`: `result_versions`, `attachments`, `review_checklists`, each append-only (triggers); one MIGRATED version per result that holds a value; under the runner only: meaning `REINTEGRATION_APPROVAL` (QA, Admin, reason required) and permission `result.reintegration.approve` (position 120) for QA and Admin |
| Schema, protections | `src/db/schema/rawdata.ts`, `src/db/protections/rawdata.ts` |
| Result versions | `src/server/services/result-hooks/codes.ts` (the coded reasons, pure constants shared with the screen), `versions.ts` (`codeTheChange`, `recordResultVersion`, `listResultVersions`, `signReintegration`, signable type `ResultVersion`) |
| Blob store | `src/server/blobs/` (`config.ts` BLOB_DIR and ATTACHMENT_MAX_BYTES, `sniff.ts` type from the first bytes against an allow-list, `store.ts` streaming stage/commit/verify) |
| Backup blob section | `src/server/backup-blobs.ts` (frame type 3: write, verify, restore, post-restore check) |
| Review checklist | `src/server/review.ts` (server items, `reviewChecklistGuard`, attestations) |
| Routes | `src/server/routes/attachments.ts`, `src/server/routes/review.ts` (below) |
| Screens | `src/components/AttachmentPanel.tsx`, `src/components/ReviewChecklist.tsx` |
| Tests | `tests/api/rawdata-migration.test.ts` (5), `rawdata-versions.test.ts` (7), `rawdata-attachments.test.ts` (10), `rawdata-review.test.ts` (7), `rawdata-backup.test.ts` (3), `rawdata-ui.test.ts` (5): 37 tests |

### Routes (permissions in the gate patch's route table)

| Route | Permission | Behaviour |
|---|---|---|
| `POST /samples/:id/attachments?fileName&resultId&description` | `result.enter` | The body is the file (`application/octet-stream`, else 415), streamed to a temporary file in the store while it is hashed; 413 above `ATTACHMENT_MAX_BYTES` (declared or not); 400 empty; 415 when the first bytes are not an allowed format or the extension does not fit the content. Analyst and Admin only (403), sample Logged or Testing (409), never Approved or Rejected (423), result must belong to the sample (404). The file becomes `BLOB_DIR/<sha256>` (read-only), then the register row and its `Create` audit entry are written in one transaction with the sample locked and its state checked again. 201 with the row (sha256, size, detected type) |
| `GET /samples/:id/attachments` | `sample.view` | The register of the sample |
| `GET /attachments/:id/content` | `sample.view` | Re-hashes the stored file first. Missing or different: 409 `ATTACHMENT_INTEGRITY_FAILED` and an `IntegrityCheckFailed` audit entry (actor = the reader, registered and actual hash in the entry), committed on its own. Intact: the bytes, with `X-Content-SHA256`, `Content-Disposition: attachment`, `nosniff`, `no-store` |
| `GET /samples/:id/result-versions` | `sample.view` | Every version of every result, with its code and any reintegration signature |
| `POST /result-versions/:id/sign` | `result.reintegration.approve` | `signRecord` with `REINTEGRATION_APPROVAL` on entity `ResultVersion`, record version = the result version the reintegration produced, `sample_id` kept. 409 for a version that is not a reintegration or is already signed, 403 `SOD_VIOLATION` (recorded as `AUTHZ_DENIED`) for the person who reintegrated, 423 once the sample is closed. The version row is locked inside the signing transaction, so two signers cannot both sign |
| `GET /samples/:id/review-checklist` | `sample.view` | The server items evaluated now, `ready`, the attestation catalogue, the latest recorded checklist |
| `POST /samples/:id/review-checklist` | `sample.transition` | Reviewer, QA or Admin (403 otherwise), sample Pending Review (409), `expectedVersion` = the sample's (409). Stores the attestations with the server items as evaluated then, and a `Create` audit entry, in one transaction. 201 |

### Result versions and coded reasons

Every write through `saveResult` appends one `result_versions` row in the same transaction as the result and its audit entry (a refused
insert rolls all three back; tested with a trigger). The first value is `INITIAL_ENTRY` (a `reasonCode` is refused there). A correction
needs a `reasonCode`: `TRANSCRIPTION_ERROR`, `CALCULATION_ERROR`, `INSTRUMENT_MALFUNCTION`, `SAMPLE_PREPARATION_ERROR`, `METHOD_DEVIATION`
or `REINTEGRATION`, beside the free-text reason; the audit reason then reads `[CODE] reason`. Replacing an OOS value keeps r1-results-oos'
rule (its open investigation and one of the five OOS codes); `REINTEGRATION` is refused for an OOS value. The same codes apply to a
recalculation (`POST /calc/samples/:id/results/:resultId`). The table refuses UPDATE, DELETE and TRUNCATE.

### The review checklist (`src/server/review.ts`)

| Item | Pass when |
|---|---|
| `RESULTS_ENTERED` | every result has a value |
| `RESULT_HISTORY` | every entered result's value, OOS flag and version equal its last `result_versions` row (a value written outside `saveResult` fails) |
| `REINTEGRATIONS_APPROVED` | every `REINTEGRATION` version of the sample carries a `REINTEGRATION_APPROVAL` signature |
| `INSTRUMENTS_CALIBRATED` | each instrument a result names was Active and within calibration on the day the result was entered, read from `calibration_history` (the due date in force then), else from the instrument record |
| `RAW_DATA_ATTACHED` | every result measured on an instrument has at least one attached file |
| `ATTACHMENTS_INTACT` | every attached file is in the store and re-hashes to its registered sha256 |
| `SYSTEM_SUITABILITY` | r2-methods-calc's `sstPassed` rule |

Items with nothing to check are `na`. `reviewChecklistGuard` is added to the move to Approved: while an item fails, approval is
`400 TRANSITION_BLOCKED` with a `review-checklist` detail naming each failed item and why, before any password is checked (the signer
loses no attempt). `RESULTS_ENTERED` and `SYSTEM_SUITABILITY` are left to their existing guards so each problem is named once. The manual
attestations are `AUDIT_TRAIL_REVIEWED`, `RAW_DATA_VERIFIED` and `REAGENTS_IN_DATE` (reagent lots are not linked to results, so the
system cannot check expiry itself).

### The backup blob section (`src/server/backup-blobs.ts`, wired into `backup.ts` by the gate patch)

After the table frames, inside the same REPEATABLE READ snapshot, every file the backed-up register names is written once, as frames of
type 3 (chunks of at most `frameBytes`, sealed like every frame: AES-256-GCM, type and index in the AAD). The manifest's `blobs` lists
`{ name, sha256, bytes }`. A file that is missing or does not match its hash or registered size refuses the backup, naming it.
Verification re-hashes every file from its frames against the manifest (a damaged blob frame is named like any frame). Restore writes each
file into the target store (`options.blobDir`, default `BLOB_DIR`) only after its hash is confirmed, and then checks that every registered
file is in the store; the result carries `blobsRestored`. The table stream hash still covers the data frames only.

## Why

M20: results kept only the latest value with a free-text reason; attachments were base64 text with no hash, blocked by express.json's
100 kB limit, and not reachable from the screen; approval needed only a password. Top defects in scope: "express.json()'s 100 kb limit
blocks base64 attachments" and "the SampleDetail save payload omits ... attachments": files now stream outside JSON, and the screen has a
file input. The screen no longer re-sends a legacy inline attachment with every save.

## For the gate

1. Apply `git apply docs/changes/r2-raw-data.gate.patch` first, then r2-api-v1's patch (`patch -p1 -F3` or `git apply -C1`: the hunks
   in `routes/index.ts`, `routeTable.ts` and `schema/index.ts` sit next to this patch's lines; resolved with fuzz in the combined
   simulation, no hand edit). Delete the patches afterwards. This patch changes:
   * `src/server/routes/index.ts`: `attachmentsRoutes`, `reviewRoutes`.
   * `src/server/authz/routeTable.ts` (r1-authz): the 7 rules above, the POST bodies with this track's strict schemas.
   * `src/lib/permissions.ts` (r1-authz): `result.reintegration.approve` in the catalog and in the supervisory set (QA; Admin holds all).
   * `src/db/schema/index.ts`: `export * from './rawdata'`. `src/db/protections.ts`: `rawdataProtections` in the registry.
   * `src/server/services/saveResult.ts` (r1-results-oos): `codeTheChange` before the write, `recordResultVersion` after it; `reasonCode`
     typed as `ResultChangeCode`. `src/lib/validations/results.ts`: `reasonCode` takes `RESULT_CHANGE_CODES`.
   * `src/lib/validations/methods.ts`, `src/server/routes/calc.ts` (r2-methods-calc): the same codes for a recalculation.
   * `src/server/workflow/guards/index.ts` (r1-results-oos): `reviewChecklistGuard` on Approved.
   * `src/server/backup.ts` (r1-backup-jobs): the blob section in create, verify and restore; `blobDir` options; `blobsRestored`.
   * `src/server/config.ts`, `.env.example` (r1-build-shell): `BLOB_DIR`, `ATTACHMENT_MAX_BYTES` (1 to 1 GiB).
   * `src/components/SampleDetail.tsx` (r1-results-oos): the coded reason of a correction, `AttachmentPanel`, `ReviewChecklist`; the
     inline attachment is no longer re-sent.
   * `scripts/dev/seed/seeds/samples.ts` (r1-build-shell): the seeded results get their first version.
   * Tests of other tracks that follow the behaviour change, no assertion removed: `tests/api/methods-calc.test.ts` (six recalculations
     send a `reasonCode`), `tests/upgrade/upgrade-v0.1.0.test.ts` (25 meanings; one MIGRATED version per v0.1.0 result with a value).
2. Regenerate after all patches: `tests/route-table.json` (7 routes added), `docs/permission-matrix.csv` (one permission added; the
   `sample.view`, `sample.transition` and `result.enter` rows list the new routes), `desktop/schema.sql` (adds 0120).
3. Migration 0120 sorts before the already applied 0180: a development or gate database built from the R2 W1 tree is refused with
   `OUT_OF_ORDER` and must be rebuilt (fresh installs and v0.1.0 upgrades are fine; same as 0050 at W5 and 0140 in this wave).

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/rawdata-migration.test.ts tests/api/rawdata-ui.test.ts       # shared tree, no wiring needed (10)
# after the gate steps:
npx vitest run tests/api/rawdata-                                                      # 37
npx vitest run && npm run lint
npm run build; node dist-server/init-db.cjs; demo seed; server; tests/security-controls.sh; tests/backup-restore.sh
```

| Acceptance (M20) | Evidence |
|---|---|
| Three edits yield three result_versions rows with codes, and UPDATE/DELETE on that table is refused by the trigger | `rawdata-versions` "three edits give three result_versions rows" (INITIAL_ENTRY, TRANSCRIPTION_ERROR, REINTEGRATION; an uncoded correction is 400 and changes nothing; UPDATE and DELETE refused with `append-only`); `rawdata-migration` (the trigger and the code check on a new installation) |
| A 20 MB attachment uploads with its sha256 shown. One changed byte on disk refuses the download and writes an audit row | `rawdata-attachments` "a 20 MB file uploads with its sha256" (201, sha256 equal to the client's, download byte-identical with the hash header); "one changed byte on disk refuses the download" (409 `ATTACHMENT_INTEGRITY_FAILED`, audit `IntegrityCheckFailed` by the reader with the registered hash; a missing file likewise). Browser run R2 and R11: the sha256 is shown in the toast and the list; the refusal is shown |
| Approving with a failed server item returns 400 listing the items. Backup and restore round-trips the blobs | `rawdata-review` (400 `TRANSITION_BLOCKED` naming `RAW_DATA_ATTACHED` and the parameter, no failed signature attempt counted; unsigned reintegration, damaged file, calibration lapsed at test time, value changed outside the result path); `rawdata-backup` (manifest lists each file once, verify ok, restore into an empty store re-creates the files, a damaged blob frame is named, a damaged or missing stored file refuses the backup); end to end on the bundle: upload through the server, `POST /admin/backup`, `backup-cli verify` ok, `backup-cli restore` into a new database and an empty `BLOB_DIR`: counts, chain and hashes match, `blobsRestored` 1, the file's sha256 identical |

## Evidence (2026-10-20)

**Re-verification after the resumed session** (the first attempt was cut off after this file was written and before it reported; its
files were reviewed and kept unchanged). A new combined simulation `scratchpad/r2rd/combo2` was built from the shared tree as it is now
(which also holds r2-events' unfinished files), then `git apply docs/changes/r2-raw-data.gate.patch` (clean) and r2-api-v1's patch
(`patch -p1 -F3`, fuzz in `routes/index.ts`, `routeTable.ts`, `schema/index.ts` as expected), and the three regenerations:

* `npx vitest run tests/api/rawdata-`: 6 files, **37 passed**, 0 failed.
* `npx vitest run` (whole suite): 105 files passed; 1355 tests passed, 5 failed, 21 skipped. Every failure is r2-events' in-flight state,
  not this track: the three `events-*` files cannot load (`src/server/events` has no index yet), and the schema-drift, `migrate-cli draft`
  and `master-migration` drift tests see `0150_events.sql`'s four tables, which no schema module exports yet. With 0150 and the
  `events-*` tests moved out of the simulation: `tests/upgrade`, `master-migration`, `tests/desktop`, `rawdata-` 18 files, **102 passed**.
* `npm run lint`: web clean; server: only six errors, all in `tests/api/events-*.test.ts` (missing r2-events modules). None in this
  track's files.
* Production bundle (0150 left out): `npm run build`; `dist-server/init-db.cjs` (17 migrations, 0120 and 0140 included); `delete from
  users`; demo seed; server on 127.0.0.1:3104 with its own `BACKUP_DIR` and `BLOB_DIR`: `tests/security-controls.sh` **34 PASS, 0 FAIL**;
  `tests/backup-restore.sh` **18 PASS, 0 FAIL**. End to end: a PDF uploaded by analyst1 (sha256 returned equal to the client's),
  `POST /admin/backup` 200, `backup-cli verify` ok, `backup-cli restore` into a new database and an empty `BLOB_DIR`: counts, chain,
  hashes and timestamps match, `blobsRestored` 1, the restored file's sha256 identical; then one byte appended to the stored file:
  the download is 409 and an `IntegrityCheckFailed` audit row names the attachment. The server (own PID) was stopped afterwards.
* Desktop after the build: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* Shared tree, no patch: `rawdata-migration` and `rawdata-ui` 10 passed.

**Migration number.** The task text of this run reserves 0140 to 0149 for this track, but the roadmap (`synth.releases[1]`, "0120
raw-data, 0140 api") and this track's `ownsFiles` (`drizzle/012*`) give 0120, and `drizzle/0140_api_v1.sql` (r2-api-v1) already uses
0140 in the tree. The migration stays `0120_raw_data.sql`, inside the files this track owns and colliding with no one; listed for
confirmation.

The first attempt's evidence follows.

The simulations are in the session scratchpad under `r2rd/`: `sim` (HEAD + this track's files + the gate edits, built by `r2rd/mksim.sh`
from `r2rd/gate_edits.py`), and `combo` (the shared tree, which holds r2-api-v1's files too, with this patch and then r2-api-v1's).

* **Test first.** The six test files ran on the code before this change: 6 files failed, 23 tests failed and three files could not load
  (`scratchpad/r2rd/red-old-code.txt`): no route (404), `reasonCode must be one of` the five OOS codes for `REINTEGRATION`, no module.
  The chunked-upload test was added when the size-limit mutation survived (below) and was red on the old code (404).
* **Gate simulation (`sim`).** `npx vitest run`: 105 files passed, 2 skipped; 1331 tests passed, 3 skipped, 0 failed, no unhandled error.
  `npm run lint`: web clean; server 18 known baseline errors, none new.
* **Combined simulation (`combo`, with r2-api-v1).** `npx vitest run`: 107 files passed, 2 skipped; 1355 tests passed, 3 skipped, 0 failed.
  One unhandled `57P01` from `backup-jobs-maintenance` teardown, the harness race recorded by earlier tracks; that file passes alone 3 of 3.
  `npm run lint` clean as above. On its production bundle (`npm run build`; `dist-server/init-db.cjs`, 17 migrations with 0120 and 0140;
  `delete from users`; demo seed; server on 127.0.0.1:3104): `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh`
  **18 PASS, 0 FAIL**. Desktop after the build: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed. The same results on `sim`.
* **Browser** (Playwright Chromium, `scratchpad/r2rd/browser.cjs`, on both bundles): 13 PASS. The panel appears; a PDF is attached and its
  sha256 shown; an executable named `.pdf` is refused with its message; a correction asks for the coded reason and refuses to save
  without it; the history shows `99.1 → 99.3` with its code; the reviewer sees every server item met, records the attestations and
  downloads the file; after one byte is appended on disk the download is refused with the message and the checklist shows approval
  blocked; no unexpected console error.
* **Mutation checks** (`scratchpad/r2rd/mutate.py`, each must turn a test red): version not recorded, uncoded correction accepted,
  reintegrator signs own, approval guard off, raw-data presence not required, download not re-hashed, extension not checked, no blob
  section, damaged blob backed up: all killed. Two survived at first: the size limit (the `Content-Length` pre-check caught it) and a
  calibration mutation that still read the later history row; a chunked-upload test and a stronger mutation (history ignored) kill them.
* **Shared tree without the patch.** `rawdata-migration` and `rawdata-ui` pass. Failing until the gate (with 0140 of r2-api-v1 in the same
  state): schema drift and `migrate-cli draft` (tables not exported), `authz-matrix` (permission in the database, not in the catalog),
  `desktop-schema`, the upgrade test (meanings and versions counts), the protection-registry count.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: the migration number; the code list and when a code is required; who approves
a reintegration; the server items and the raw-data rule; attestations not required for approval; who may attach and when; the file
allow-list and size limit; the integrity-failure response; a damaged stored file refusing every backup; legacy inline attachments;
repair by identical re-upload; the MIGRATED backfill; restore and drills writing into the live store.

## Needs from other tracks

| Owner | Change |
|---|---|
| Wave gate | Everything under "For the gate" (patch, regenerations, rebuild of databases at 0180) |
| r2-validation | DIA and URS/OQ/RTM: attachments now live outside the database, inside the backup's blob section (the gxpRisk of M20: "update the DIA"); OQ for the review checklist, result versions and the reintegration signature. Nothing was approved or signed |
| r2-qms / r2-audit-tamper | Optional: open a deviation automatically on an attachment integrity failure (`autoOpenQmsRecord`); today it is an audit entry and a 409 |
| r2-instrument-integration | Post instrument files through `POST /samples/:id/attachments` with the result id, so `RAW_DATA_ATTACHED` is met for machine results |
| r1-build-shell | `.env.example` and the config schema get the two variables through this patch; the desktop needs nothing (BLOB_DIR defaults to `userData/blobs`, next to `BACKUP_DIR`) |
| r1-results-oos | `resultUpdateSchema` still accepts `attachmentName` / `attachmentData` (inline base64, no hash) for API compatibility; retiring them is a decision and a schema change |

## Not done

* No antivirus (Defender) scan: optional in M20, and no scanner is available offline. Files are typed by content and never executed or
  served inline.
* The upload is a raw `application/octet-stream` body, one file per request, not `multipart/form-data`: no multipart parser is a
  dependency of this project, and the raw body streams the same way.
* Legacy inline attachments in `results.attachment_data` are not moved into the store (no hash was ever recorded for them); they are shown
  as before.
* Reagent expiry is an attestation, not a server item: no table links a reagent lot to a result.
* A download re-hashes the file and then streams it (two reads): a change between the two reads is not detected by that download (it is by
  the next read, the checklist and the backup).
* Files are never deleted; there is no retention or archive rule for the store (r3-periodic-archive).
