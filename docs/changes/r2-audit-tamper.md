# r2-audit-tamper: audit-trail review and tamper-evidence hardening (roadmap M35, QA-07 rest + SEC-10)

Release R2. Branch `claude/project-implementation-tirr4j`. The track was merged and committed by the R2 W2 gate (`fedb5f0`,
`docs/changes/r2-w2-gate.md`); its gate patch was applied there and deleted. The follow-up below is uncommitted; the next wave gate commits.

## Follow-up after the W2 gate (2026-10-20, resumed run)

The workflow re-ran this track because the first run did not report. The committed work was reviewed against the shared tree:
no file of this track was missing or changed, and all 51 track tests (plus `audit-chain`, `audit-routes`, `release-gates`) pass on
`HEAD`. One defect was found and fixed, in owned files only; no gate patch is needed.

* **Defect: a batch review could sign entries its signer never saw.** `POST /audit/reviews` with `scope: 'batch'` bounded the review at
  the batch's newest entry *when the POST arrived*, not at what the reviewer had on screen. An entry written about the batch between
  "Show" and "Sign" was silently covered, and so was every entry of another batch if the reviewer edited the batch field after "Show"
  (the screen took the scope from the input, not from the summary it displayed). The range scope already named its bounds.
* **Fix:**
  * The batch body now requires `throughSequence`, the `toSequence` of `GET /audit/exceptions` the reviewer was shown
    (`routes/audit-review.ts`, also in `AUDIT_REVIEW_KEYS`). `createReview` refuses with **409 `SCOPE_CHANGED`** unless it equals the
    batch's current last entry. The check runs before the password, so nothing is counted (`audit/review.ts`).
  * The screen builds the body from the summary it displays (`reviewScopeBody`, exported) and shows the last entry in the signing
    dialog (`AuditReview.tsx`).
* **Tests (written first, red on the old code, then green):**
  * `audit-tamper-review`: new case "a batch review signs what the reviewer was shown". It covers the missing key (400), an entry
    written since (409, no review row, no failed attempt), a number above the head (409), and the current value (200).
  * The test helper `review()` now reads the scope first, as the screen does. The no-rows case passes `throughSequence: 1` and still
    expects 404.
  * `audit-tamper-ui`: `reviewScopeBody` takes the scope from the summary, not the inputs, and returns null with no rows.
  * Mutation check: with the 409 check disabled, the new case fails (200 instead of 409).
* **Behaviour change:** API callers of `POST /audit/reviews` with `scope: 'batch'` must send `throughSequence` (400 without it).
  Nothing else in the repository calls it: no script, seed, shared check or `/api/v1` route. Route table: no new route, and the snapshot
  `tests/route-table.json` does not hold body keys, so nothing is regenerated.
* **Evidence:**
  * Clean copy of `HEAD` plus these files: `audit-tamper-*`, `route-contract*`, `authz*` and `release-gates`, 14 files, 202 passed.
    `npm run lint` there: web clean, server 18 baseline errors, none new.
  * Shared tree: the five track files that need no other track's wiring, 36 passed. `audit-tamper-review` cannot start in the shared
    tree right now: another track's in-flight `/training/*` routes have no route-table rule yet (r2-docs-training). The shared-tree web
    type errors are in `src/server/lib/evaluate.ts` (not this track).
  * `security-controls.sh`, `backup-restore.sh` and the desktop tests were not re-run. This follow-up does not touch the build, the
    migrations, start-up, `desktop/` or any route those scripts call. Their passing runs are in the W2 gate record.
* **Still not done:** the items under "Not done" below (application pool as `lims_app`, keyed rows from the migration runner, the
  backup check's message). They need files this track does not own.

## Original record (W2)

Status: **partial.** The three M35 acceptance criteria pass in a gate simulation (the shared tree plus the gate patch). One part of the
design is not done: the application still connects to PostgreSQL as the owner. The `lims_app` role exists, is installed by a boot step,
and is proven to refuse changes to the audit trail. Switching the request pool to it needs `src/db/index.ts` and the desktop shell, which
this track does not own (see "Not done").

The earlier attempt at this track left no files in the tree (git status showed none under this track's paths). All the work below was done
on this resume.

## What changed

| Area | Files (owned) |
|---|---|
| Migration (forward-only, reserved 0170-0179) | `drizzle/0170_audit_review.sql`: tables `audit_reviews` and `audit_anchors` (append-only), `audit_review_settings` (one row, review before release **off**), `clock_state`, `clock_anomalies`. Under the runner only: meanings `AUDIT_REVIEW`, `AUDIT_REVIEW_SETTING`, `CLOCK_ANOMALY_ACK`; permissions `audit.review`, `audit.review.settings`, `clock.acknowledge` (positions 170-172) with their grants |
| Schema | `src/db/schema/audit-review.ts` |
| Review by exception, signed review, release blocker | `src/server/audit/review.ts` |
| Anchors | `src/server/audit/anchors.ts` |
| Clock guard | `src/server/audit/clockGuard.ts` |
| Least-privilege role | `src/db/roles.ts` (what `lims_app` may do), `src/server/boot/steps/roles.ts` (the boot step) |
| Routes | `src/server/routes/audit-review.ts` (10 routes, below) |
| Schedules and job handlers | `src/server/schedules/audit.ts` (`audit.anchor` daily 00:20, `audit.clock` every 5 minutes) |
| Screen | `src/components/AuditReview.tsx` (Review, Anchors, Clock tabs; signed steps through `ElectronicSignatureModal`) |
| Tests | `tests/api/audit-tamper-migration.test.ts` (5), `-role` (10), `-anchors` (9), `-clock` (7), `-review` (16), `-ui` (4) |

Wiring in the gate patch (files of r1 tracks): keyed hash and downgrade rule (`audit/hash.ts`, `audit/chain.ts`, `backup.ts`), the writer
(`db/utils.ts`), the clock block in `esign/signRecord.ts`, the release blocker (`release-blockers/index.ts`), the route module
(`routes/index.ts`), the route table and the permission catalog (`authz/routeTable.ts`, `lib/permissions.ts`), the schedules and the
handlers, the boot step (`boot/index.ts`), the start-up checks (`server.ts`), the schema export, the append-only triggers in the
protection registry (`db/protections/audit.ts`), the shell entry (`components/shell/ext/audit-review.tsx`, new), the regenerated
`tests/route-table.json` and `docs/permission-matrix.csv`, and test edits (below).

### API

| Route | Permission | Notes |
|---|---|---|
| `GET /audit/exceptions?batch=B` or `?from=&to=` | `audit.view` | The scope's row count, range, authors and exceptions. A range spans at most 50,000 entries. Strict query |
| `GET /audit/reviews[?batch=B]` | `audit.view` | Newest first. With `batch`: `coverage` (`covered`, `uncoveredRows`) and `requiredForRelease` |
| `POST /audit/reviews` | `audit.review` | `{scope:'batch', batch, throughSequence}` (409 `SCOPE_CHANGED` if the batch has a newer entry; follow-up) or `{scope:'range', fromSequence, toSequence}`, `comment`, credentials. Signed `AUDIT_REVIEW` (QA, Admin) on entity `AuditReview`, record version 1 |
| `GET /audit/review-settings`, `PUT /audit/review-settings` | `audit.view` / `audit.review.settings` | Changed only by a signature (`AUDIT_REVIEW_SETTING`, reason required), with `expectedVersion` |
| `GET /audit/anchors`, `POST /audit/anchors`, `POST /audit/anchors/verify` | `audit.view` / `audit.verify` | The folder (and whether it is a second path), the register, write now, verify all |
| `GET /audit/clock` | `audit.view` | Anomalies and `signingBlocked` |
| `POST /audit/clock-anomalies/:id/acknowledge` | `clock.acknowledge` (Admin) | Signed `CLOCK_ANOMALY_ACK`, reason required, `expectedVersion` |

### Review by exception (`findExceptions`)

A scope is either the rows about one batch or a range of sequences. The rows about a batch are those for its samples (`Sample`,
`SampleContext`, `CertificateOfAnalysis`), their results (`Result`), their OOS investigations (`OOS`) and the batch release
(`BatchRelease`). Four kinds of exception are listed, each with the reason the row carries:

| Kind | Rule |
|---|---|
| `EDIT_AFTER_SUBMIT` | `Update`/`Invalidate` of a result, or `Update` of a sample, after a `Transition` of that sample to `Pending Review` |
| `SIGNATURE_FAILED` | action `SignatureFailed` |
| `ROLE_OR_SETTING_CHANGE` | `RoleChange*`, a `User` row with field `role`, or a row of `SystemSettings`, `Integration`, `Keystore`, `QmsSettings`, `AuditReviewSettings`, `UserRole` |
| `SAME_USER_CREATED_AND_APPROVED` | a `Transition`/`StatusChange`/`Approve`/`Release` to `Approved`, `Active`, `QA Approved`, `Released` or `Effective` by the user whose `Create` row opened the same record |

The signed review records the range the reviewer saw (`from_sequence`..`to_sequence`, computed by the server, re-checked inside the
signing transaction and bounded by what was shown). The reviewer may not be the author of any row in the scope (403 `SOD_VIOLATION`,
before the password is checked). A scope with exceptions needs a comment of at least 10 characters (400 `COMMENT_REQUIRED`).

**Release interlock** (`auditReviewReleaseBlocker`): while `required_for_release` is on, release is 400 `RELEASE_BLOCKED` while any row
about the batch lies outside every signed review. A row is covered by a batch review of that batch whose range contains it, or by any range
review that contains it. A change made after the review is therefore not covered by it, and needs a new review.

### Keyed chain (gate patch, `audit/hash.ts`)

* New rows are written with `hash_alg` `hmac-sha256-v1`. This is HMAC-SHA-256 over the same link and seal contents as before, keyed with
  the keystore's `audit-hmac` key (label `chain`) of key generation 1. After a master-key rotation, rows are written as
  `hmac-sha256-v1:gN`, so every row names the generation that verifies it.
* `sha256` rows (all rows from before this release) keep verifying.
* **Downgrade rule:** once the chain holds a keyed row, a later unkeyed row is `DOWNGRADE`. The exception is the migration runner's own
  rows (`hash_version` 1, entity `SYSTEM_MIGRATION`): `src/server/migrate.ts` still writes them unkeyed.
* A row whose key generation is not in the key ring is `UNSUPPORTED_ALG`. It is reported, never skipped.
* `linkHash`/`sealHash` still default to `sha256`, so callers that build v1 fixtures are unchanged.

### Anchors (`audit/anchors.ts`)

* **The file:** `<dir>/audit-anchor-<UTC time>-<sequence>.json`. It holds the head of the audit chain (sequence, hash, seal, algorithm)
  and of the security-event chain, the database name, the time and the key generation, signed with an HMAC (keystore `audit-hmac`, label
  `anchor`). It is written atomically, then made read-only.
* **The register:** each file is recorded in `audit_anchors` (append-only), with an `AUDIT_ANCHOR` security event.
* **Where:** `AUDIT_ANCHOR_DIR`; else `<BACKUP_MIRROR_DIR>/audit-anchors`; else `<BACKUP_DIR>/audit-anchors`, which the screen reports as
  not a second path. With none of these, writing an anchor fails with 400 `ANCHOR_DIR_NOT_SET`.
* **Verification:** checks every file of this database. The possible results are `HMAC_INVALID`, `UNREADABLE`, `KEY_UNAVAILABLE`,
  `ROW_MISSING`, `HASH_MISMATCH` (hash or seal), `SECURITY_HASH_MISMATCH`, `TRUNCATED` (the head is below an anchored sequence) and
  `FILE_MISSING` (in the register, not in the folder).
  * A mismatch writes `AUDIT_ANCHOR_MISMATCH`. When an actor is known, it also opens a Critical deviation through
    `autoOpenQmsRecord` (source `audit-chain-broken`, once per file). A clean run writes `AUDIT_ANCHOR_VERIFY`.
* **Start-up check** (`startupAnchorCheck`, called from `server.ts` by the patch): logs the result and never stops the start.

### Clock guard (`audit/clockGuard.ts`)

* **Watermark:** the latest time seen, kept in `clock_state`. Before the first check, the newest audit entry's time is used.
* **Anomaly:** a check whose clock is more than 60 s before the watermark. It records one open `clock_anomalies` row and a
  `CLOCK_ANOMALY` security event, in one transaction. The watermark never moves back by itself.
* **When it runs:** `guardSigningClock` runs at the start of every `signRecord` (gate patch), before the password is checked, so nothing
  is counted. It also runs every 5 minutes (job `audit.clock`) and at start.
* **The block:** while an anomaly is open, every signature is 423 `CLOCK_ANOMALY` except `CLOCK_ANOMALY_ACK`. That is the exemption for
  the entity that lifts the requirement (AGENTS.md, the SignatureModal rule).
* **The acknowledgement:** Admin only, reason required, version-checked (`updateVersioned`). It makes the current clock the new watermark.

### `lims_app` (`db/roles.ts`, boot step `boot/steps/roles.ts`)

The step is idempotent and runs as the owner after the protections at every start (gate patch in `boot/index.ts`). The role:

* is created NOLOGIN. It is given a login only when `LIMS_APP_DB_PASSWORD` is set. Its attributes are narrowed again each time.
* gets **SELECT, INSERT only** on `audit_trail`, `signatures`, `security_events` and on every table guarded by `gxp_block_mutation` (18
  tables on a fresh install, including `audit_checkpoints`, `audit_reviews`, `audit_anchors` and the QMS links).
* gets SELECT, INSERT, UPDATE, DELETE on the other tables, and USAGE, SELECT on sequences.
* gets no TRUNCATE, REFERENCES or TRIGGER privilege, and no CREATE on the schema. CREATE on schema public is also revoked from PUBLIC
  (already the PostgreSQL 15+ default).

Every `gxp_*` trigger is set `ENABLE ALWAYS`, so a session in `session_replication_role = replica` still fires it.

`LIMS_APP_ROLE` controls what happens when the owner may not create roles (42501):

* `auto` (the default): a WARNING in the log, and the start goes on.
* `required`: the start stops.
* `off`: the step is skipped, and the log says so.

## Why

* **M35 evidence:**
  * No audit review state existed, and release did not need one.
  * The hash was unkeyed SHA-256, so an owner could rewrite and re-hash the chain.
  * The head anchor was manual.
  * The app connected as the owner.
  * The clock could be set back without detection.
* **Regulatory basis:** 21 CFR 11.10(e), Annex 11 s.9, PIC/S PI 041.
* **Top defects:** `synth.topDefects` has no entry in this track's files. The audit defects listed there were fixed in R1 (r1-audit).

## Deliberate behaviour changes

1. Audit rows written from now on carry `hash_alg` `hmac-sha256-v1`. Verifying such a chain, in the server, in `backup-cli verify` or in
   a restore, needs the same key material (`LIMS_KEYRING`, `LIMS_MASTER_KEY` or `JWT_SECRET`).
   * Without it, the backup check reports the chain broken and the restore refuses.
   * `tests/backup-restore.sh` therefore passes only when the shell that runs it exports the server's `JWT_SECRET`.
2. An unkeyed row after a keyed row is `DOWNGRADE` (except the migration runner's rows).
3. Every e-signature is refused with 423 `CLOCK_ANOMALY` while a clock anomaly is open (except the acknowledgement).
4. With `required_for_release` on (it is off on installation), release needs signed review coverage of the batch's rows.
5. New permissions `audit.review` and `audit.review.settings` (QA, Admin) and `clock.acknowledge` (Admin).

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/audit-tamper-migration.test.ts tests/api/audit-tamper-role.test.ts tests/api/audit-tamper-anchors.test.ts \
  tests/api/audit-tamper-clock.test.ts tests/api/audit-tamper-ui.test.ts                      # shared tree, no wiring needed (35)
git apply docs/changes/r2-audit-tamper.gate.patch                                              # then the regenerations below
npx vitest run tests/api/audit-tamper-*.test.ts                                                # 51
```

## Evidence (2026-10-20)

The simulation is `scratchpad/at-sim`: `git archive HEAD`, plus every modified and untracked file of the shared tree (including the
in-flight files of r2-api-v1, r2-raw-data and r2-events, without their patches), plus this track's patch. `scratchpad/at-base` is the
same tree without the patch.

* **Test first.** The six test files were written before any implementation. Red run on the old code: 6 files failed, 16 tests failed,
  26 not run (modules missing; the route tests answered 404). See `scratchpad/at-red.txt` and `at-red-summary.txt`.
* **Acceptance:**
  1. As `lims_app`: `update`, `delete` and `truncate` on `audit_trail`, `signatures` and `security_events` fail with 42501. So do
     `drop trigger`, `alter table … disable trigger`, replacing `gxp_block_mutation` and `set session_replication_role`. The triggers
     are `tgenabled = 'A'`, and an owner session in replica mode is still refused (`audit-tamper-role`).
  2. After the owner rewrites a row and re-hashes the whole chain with the published formula (and empties the checkpoints), the chain
     verifier accepts it. `verifyAnchors` reports `HASH_MISMATCH` for both anchors and writes `AUDIT_ANCHOR_MISMATCH`. Also tested: an
     edited file (`HMAC_INVALID`), a removed file (`FILE_MISSING`), a foreign key (`HMAC_INVALID`), truncation (`TRUNCATED`) and the
     start-up check (`audit-tamper-anchors`). With the keyed chain, a partial re-hash after a keyed row is `DOWNGRADE` through
     `POST /audit/verify` (`audit-tamper-review`).
  3. With the setting on, release is 400 until an `AUDIT_REVIEW` covers the batch. It is 400 again after a later change, and 200 after a
     second review. A range review also covers a batch. With the setting off, nothing changes. A clock set back 10 minutes writes
     `CLOCK_ANOMALY` and blocks a release with 423, with no attempt counted. The Admin acknowledgement is allowed and lifts the block
     (`audit-tamper-clock`, `audit-tamper-review`).
* **Mutation checks**, each run against the test and each caught:
  * append-only tables granted UPDATE/DELETE: 4 role tests red
  * no ENABLE ALWAYS: 2 red
  * anchor hash comparison removed: 1 red
  * no exemption for the acknowledgement: 1 red
* **Test runs:**
  * Shared tree, this track's tests that need no wiring: 5 files, 35 passed.
  * Simulation, all of this track's tests: 6 files, 51 passed.
  * Simulation, `audit-chain`, `audit-routes`, `release-gates`, `esign-*`, `route-contract` and `tests/upgrade` after the patch: every
    failure left is also failing in `at-base` and is caused by other tracks' unwired work. Those failures are: trigger counts 36 vs 30
    and permission count 73 vs 72 (r2-raw-data), schema drift and `migrate-cli draft` (r2-raw-data, r2-api-v1, r2-events tables not
    exported).
  * The full simulation suite before the test edits: 79 failures, of which 9 were this track's. All 9 are fixed by the patch's test
    edits; the other 70 are api-v1, events and raw-data tests running unwired.
* **Shared checks:** run on the production bundle of the simulation (`npm run build`, `dist-server/init-db.cjs` to 0180, demo seed,
  server on 127.0.0.1:3107):
  * `tests/security-controls.sh`: 34 PASS, 0 FAIL.
  * `tests/backup-restore.sh`: 18 PASS, 0 FAIL, with `JWT_SECRET` exported like the server's. Without it: 13 PASS, 5 FAIL (behaviour
    change 1).
* **Desktop**, after `npm run build`:
  * `xvfb-run -a node tests/desktop-upgrade.cjs`: 8 passed, 0 failed.
  * `tests/desktop-shell.cjs`: 17 passed, 0 failed.
* **Lint** (`npm run lint` in the simulation): web clean. The server check reports one new error kind, in
  `tests/api/events-subscriptions.test.ts` (r2-events, unwired). None is in this track's files.

## For the gate

1. **Apply the patch:** `git apply --3way docs/changes/r2-audit-tamper.gate.patch`. Stacked on the r2-raw-data and r2-api-v1 patches it
   leaves three conflicts. Each is a union:
   * `lib/permissions.ts`: keep both `'result.reintegration.approve'` and `'audit.review', 'audit.review.settings'`.
   * `backup.ts`: keep raw-data's blob imports and import `nextTail` too.
   * `upgrade-v0.1.0.test.ts`: signature meanings 25 + 3 = **28**, and keep `result_versions` and `audit_review_settings` (1).
2. **Regenerate:**
   * `tests/route-table.json`:
     `NODE_ENV=test JWT_SECRET=<16+ chars> SQL_HOST=x SQL_USER=x SQL_PASSWORD=x SQL_DB_NAME=x npx tsx tests/helpers/dump-route-table.ts --stdout`
   * `docs/permission-matrix.csv`: `npx tsx scripts/authz/export-matrix.ts`
   * `desktop/schema.sql`: `npx tsx src/server/boot/migrate-cli.ts export-schema`, once every migration of the wave is in.
3. **Test edits in the patch** (deliberate behaviour changes, no assertion weakened):
   * `audit-chain.test.ts` and `audit-routes.test.ts` expect `hash_alg` `hmac-sha256-v1`.
   * The writer test checks the HMAC of the same content (and that the plain SHA-256 no longer matches).
   * The "old writer" row in `audit-routes` is now the migration runner's shape (`SYSTEM_MIGRATION`), the one writer that still appends
     unkeyed rows. Any other such row is `DOWNGRADE`, which is tested in `audit-tamper-review`.
   * `upgrade-v0.1.0` counts the 3 new meanings and the `audit_review_settings` row, and ignores that row's `updated_at` on the rollback
     comparison.
4. **Running `tests/backup-restore.sh`:** export the server's key material (`JWT_SECRET` or `LIMS_MASTER_KEY`) in the shell that runs it.

## Decisions that need confirmation

1. **The review before release is OFF on installation** (as QMS change control). Switching it on is a signed QA decision. The
   conservative alternative is to ship it on; that would block every release at an upgraded site until a review is signed.
2. **Who reviews:**
   * `AUDIT_REVIEW` is for QA and Admin, and the reviewer must not have authored any row in the scope (strict, for range reviews too).
   * A scope with exceptions needs a comment of at least 10 characters.
   * A range is at most 50,000 entries.
3. **The exception rules** above, and the batch's entity mapping. `ResultInput`, `ReviewChecklist`, `Attachment` and `LabNotebook` rows are
   not mapped to a batch yet; their ids are not sample or result ids.
4. **Clock guard:**
   * The tolerance is 60 s, and only set-backs are detectable (there is no outside time source).
   * Only an Administrator acknowledges (`CLOCK_ANOMALY_ACK`, reason required).
   * Anomalies, anchors and anchor checks are recorded in the security-event chain, not as audit-trail entries. They are system-detected
     events, not changes to a GxP record.
   * The acknowledgement itself is an audited, signed change.
5. **Anchors:**
   * Written daily at 00:20 to `AUDIT_ANCHOR_DIR` or the backup mirror. The backup folder is used as a fallback even though it is the
     same disk.
   * The start-up check never stops the start.
   * A mismatch opens a Critical deviation.
   * Retention of anchor files is not defined; nothing deletes them.
6. **The HMAC key is the keystore master key.** Backups of a keyed chain can be verified and restored only with it. The backup SOP must
   keep `LIMS_MASTER_KEY` (or the `JWT_SECRET` fallback) with the backups.
7. **The downgrade exemption for `SYSTEM_MIGRATION` v1 rows** lets someone with database access append a fake "migration" row at the tail.
   The anchors would not catch such a row until the next anchor. Making the runner write keyed rows removes the exemption (see "Not done").

## Not done

* **The application still connects as the owner.** Needed:
  * a second pool (`SQL_APP_USER=lims_app` with `LIMS_APP_DB_PASSWORD`) for request handling in `src/db/index.ts`. Boot, migrations,
    backup restore and protections keep the owner connection.
  * the desktop shell must generate and store `LIMS_APP_DB_PASSWORD` (`desktop/`).
  * `AUDIT_ANCHOR_DIR`, `LIMS_APP_ROLE` and `LIMS_APP_DB_PASSWORD` must be added to the documented configuration (`src/server/config.ts`).
* **The migration runner (`src/server/migrate.ts` `appendAudit`) still writes unkeyed rows.** Hence the `SYSTEM_MIGRATION` exemption.
* **The backup check names a keyed chain without its key as "audit chain broken".** A clearer "key not available" message belongs in
  `backup.ts`/`backup-cli`.
* **Not exercised in a browser.** The screen has no browser run; it is covered by server-side rendering of its parts and by the API tests.
* **A full re-hash of the whole chain as `sha256` passes the chain verifier.** No keyed row is left to compare with, so only the anchors
  detect it, from the first anchor on. Rows written after the last anchor and before the next one are protected by the downgrade rule
  only.
