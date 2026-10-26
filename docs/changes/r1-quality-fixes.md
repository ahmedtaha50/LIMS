# r1-quality-fixes: ELN integrity (M12) and the hotfix wave (M13)

Release R1, wave 4, run beside r1-spec. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.
Companion file: `docs/changes/r1-quality-fixes.gate.patch` (the route-table keys, one protection set, and four edits to other tracks' tests that this change forces; see "For the gate").

Status: **complete once the gate patch is applied; partial in the shared tree without it.** Every acceptance criterion of M12 and M13 is met and tested on the real application and PostgreSQL in a gate simulation (130 of 130 track tests). In the shared tree without the patch, 19 of the 130 fail by design: the route table (r1-authz's file) still lists the old body keys of `PUT /env-records/:id` (no `reason`, no `sampleType`) and `POST /traceability/batch/:batch/material` (no `verifier`), so the authorization layer refuses those requests with 400 before the handler runs.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0070_quality.sql`: `instruments.version`; `calibration_history` (append-only, triggers in the migration); `env_limits` (seeded with 14 example rows); `env_records.sample_type`, `limit_alert`, `limit_action`; `env_excursions`; meaning `VERIFICATION`. Seeds only under the runner (`WHERE EXISTS schema_migrations`), like 0020 and 0040 |
| Schema | `src/db/schema/equipment.ts` (new tables and columns); `src/db/schema/eln.ts` unchanged |
| Validation (strict Zod, server fields stripped) | `src/lib/validations/eln.ts` (create, update, sign, notebook entry, template), `instruments.ts` (`calendarDate`, `isCalendarDate`, `utcToday`, `calibrationState`, register, calibrate), `reagents.ts`, `env.ts` (grades, sample types, status vocabulary, record and correction), `stability.ts` (status vocabulary, pull points, update) |
| Routes | `src/server/routes/eln.ts`, `notebook-templates.ts`, `instruments.ts`, `reagents.ts`, `env.ts`, `stability.ts`, `dashboard.ts`, `traceability.ts` (material dispensing, `BatchMaterial` record type registered with `registerSignable`) |
| Screens | `ELN.tsx`, `Instruments.tsx`, `Reagents.tsx`, `Environmental.tsx`, `StabilityStudies.tsx`, `Dashboard.tsx`, `ComplianceOverviewWidget.tsx`, `Traceability.tsx` |
| Tests | `tests/api/eln-integrity.test.ts` (23), `equipment-calibration` (17), `equipment-reagents` (7), `equipment-env` (32), `equipment-stability` (12), `equipment-dashboard` (10), `equipment-batch-materials` (26), `equipment-migration` (3): 130 tests, real application and PostgreSQL |

Files outside the ownership list that this change touched: **none in the final tree**. (One incident, reported here because it happened in the shared tree: while setting up the gate simulation a failed `rsync` broke a command chain and `git apply` of the gate patch ran in `/home/user/taha` instead of the scratch copy. `src/server/authz/routeTable.ts` carried the patch for about a minute, during one test run, and was restored with `git apply -R` of the same patch; `git status` shows it unchanged against HEAD. No other file was affected.)

### Behaviour, route by route

| Route | Before | After |
|---|---|---|
| `POST /eln/:id/sign` | any user signed any worksheet; meaning from the body; own counter, no audit of failures; `sample_id` set to the worksheet id | only the **author** (403 `NOT_AUTHOR` before the password is read, recorded as `AUTHZ_DENIED`); `signRecord` with `AUTHORSHIP`; a `meaning` or `meaningCode` key is 400; wrong password 401, counted and audited; hash version 2, linked to the audit entry; row locked; `content_hash` of the row equals the signature's |
| `PUT /eln/:id` | anyone; `expectedVersion` optional; audit kept 100 characters | only the author (403), only while Draft (423), `expectedVersion` required (400) and checked (409); **one audit entry per changed field with the whole old and new value**; unknown sample is 400 |
| `POST /eln` | no schema; audit `{title, experimentType}` | strict schema; the whole record in the Create entry; unknown sample is 400 |
| `GET /eln/:id` | listed the signatures of the linked **sample** | lists the signatures of the worksheet (`entity_type='LabNotebook'`) |
| `POST /samples/:id/notebook` | accepted on an Approved sample; signature `content_hash 'N/A'`, `audit_entry_id 'N/A'`; wrong password not counted | 409 `SAMPLE_CLOSED` on Approved or Rejected (before the password), re-checked under the sample row lock; signed through `signRecord` (`AUTHORSHIP`) with a real hash and audit link; entry locked |
| `POST /notebook-templates` | any role, no schema, no audit, `Math.random` id | QA or Admin (403 otherwise, recorded); strict schema; audit entry with the record in the same transaction; random id |
| `POST /instruments/:id/calibrate` | any role; any string as date; Out of Service set back to Active; password compared with the session copy, never counted | QA or Admin (403 before the password); real calendar date **after today** (400); `signRecord` with `CALIBRATION` under a row lock; an Out of Service instrument stays Out of Service (with a warning), In Calibration returns to Active; `calibration_history` row; `version` moves; 404 for an unknown instrument |
| `GET /instruments` | rows | rows with `version` and `calibrations` (newest first) |
| `POST /instruments` | last calibration "now"; any due date string | `lastCalibrationDate` required (not in the future), due date a real date after it |
| `POST /reagents` | the screen's password made every receipt 400; never verified | `password` (+ `totpCode`) accepted; `signRecord` with `RECEIPT` (Analyst, QA, Admin); wrong password 401, audited; expiry a real date that has not passed |
| `POST /env-records` | `viableCount > 10` for every grade; `'Action Level'` | judged against `env_limits` by grade and sample type: above action is `Action` and opens an `env_excursions` row in the same transaction, above alert (when set) is `Alert`; Grade A action limit 0 (any growth); no active limit is 400; the limits used are copied onto the record |
| `PUT /env-records/:id` | anyone, no reason, read-compare-write | QA or Admin (403); reason of 5+ characters; `expectedVersion` under a row lock (409); re-evaluated; full old and new record audited; an excursion is opened if needed and **never closed** by a correction; a pre-0070 record must be given a sample type |
| `POST /stability`, `PUT /stability/:id` | fixed pull points; any status text; product, batch and condition editable for ever | pull points from the protocol (validated; default 1, 3, 6, 9, 12); status `Ongoing`/`Completed`/`Aborted` only; a Completed or Aborted study is final (423 for any write); full audit |
| `GET /dashboard` | trend Jan-Apr literals; `'None'` slice; reagent counts on a non-existent column; every non-Released batch pending; `findMany` of whole tables; "GxP Audit Ready" | SQL aggregates; real monthly counts for the last six months (empty when nothing happened); no placeholder; reagents by `expiry_date`; only `Quarantine Hold` batches; closed OOS (`Approved`, `Closed`) not active; calibration horizon by whole UTC days; composite score `null` when there is nothing to measure, with `scoreBasis` text and no "Audit Ready" |
| `POST /traceability/batch/:batch/material` | defaults `'Verified Pass'`, `'100.00 %'`, `'0.50 %'`, `'Approved Manufacturer'`, `'Excipient'`; `verifiedBy = dispensedBy` | every value required (400); CoA status in its vocabulary; assay and LOD a percentage or an explicit `N/A`; a **second person** in `verifier: {email, password, totpCode?}` signs `VERIFICATION` (Reviewer, QA, Admin) through `signRecord`; verifier == dispenser is 403 `SOD_VIOLATION` (before the password, recorded); unknown verifier 401 with the wrong-password text |

Screens: the calibration modal is mounted (QA/Admin only) with the new due date; the receipt modal sends the password and the code; the EM form has grade and sample type selects, limits and excursions in the table, and a QA-only correction with a reason; the stability edit offers the shared vocabulary and no edit on a finished study; the ELN sign button is shown to the author only, the dialog uses the catalog meaning, and "Verify" uses `GET /signatures/verify/:id` (a legacy signature shows its status, never "valid"); the dashboard uses `apiFetch` (checks `res.ok`), shows a load error, and says when there is nothing to chart; the dispensing form asks for manufacturer, CoA status, assay, LOD and the verifier, with no preset values.

## Why (findings)

M12 and M13 evidence in `docs/roadmap/roadmap.json`, and these `synth.topDefects`: the reagent dashboard column (`expirationDate`), EM `viableCount > 10` for every grade and the unstyled "Action Level", the reagent receipt that always answered 400 and never checked the password, the unmounted "Log Cal" modal, calibrate with no role check, any date and reactivation of Out of Service instruments, the fabricated dashboard figures and batch-material defaults with `verifiedBy == dispensedBy`, the `'N/A'` notebook signatures, and the ELN signature written against the sample foreign key.

## How to verify

```
# the track's tests (130, 8 files); needs the gate patch for 19 of them (see Status)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/eln-integrity.test.ts tests/api/equipment-

npx tsc -p tsconfig.web.json --noEmit          # clean
npm run lint:server                            # 23 known baseline errors, none new; one baseline entry fixed (the dashboard's expirationDate)

# shared validation evidence: production bundle, database from dist-server/init-db.cjs, demo seed, port 3110
BASE=http://127.0.0.1:3110/api tests/security-controls.sh     # 34 PASS, 0 FAIL
BASE=http://127.0.0.1:3110/api tests/backup-restore.sh        # 18 PASS, 0 FAIL
```

## Evidence

* **Test first.** The tests left by the interrupted attempt were reviewed and kept; they were run on the untouched code: **107 failed, 23 passed** of 130. The passes are controls (missing-field 400s the old handler already gave, the Retired 423 and role checks of the layer, the OOS distribution and calibration buckets that were already right, the stability fields that already worked). Failures show the old behaviour: another analyst, QA and Admin signed someone else's worksheet; the audit kept 100 characters; a notebook entry on an Approved sample was 200 with `content_hash 'N/A'`; an Analyst calibrated (200) with a past date; an Out of Service instrument came back Active; every reagent receipt was 400 `Unrecognized key: "password"`; reagent counts were 0; the trend was literal months; Grade A 5 CFU passed. One source-scan assertion was then made precise: the route may name `'Verified Pass'` as a word of the CoA vocabulary, but never as a fallback (`|| 'Verified Pass'`, which the old code had, still fails it).
* **Mutation checks** (gate simulation; each must turn tests red, and each did): ELN author check removed (2 tests), EM evaluation back to `count > 10` (14), calibration reactivating any status (1), dispenser = verifier check removed (2), stability lock removed (4).
* **Gate simulation** (a copy of the working tree with `r1-quality-fixes.gate.patch` applied and `desktop/schema.sql` regenerated): the 130 track tests pass; the whole suite's remaining failures are all specification tests of r1-spec's in-flight work (`spec-route-table`, `authz-sod`, `authz-states` specification, `esign-sign` Specification arrange, `occ` and `authz-fuzz` `POST/PUT /specifications`, and the `specifications` columns in `upgrade-v0.1.0`), none in a file or route of this track.
* **Shared checks** on the production bundle of the gate simulation (fresh database from the shipped installer, demo seed, 127.0.0.1:3110): `security-controls.sh` 34 PASS, 0 FAIL; `backup-restore.sh` 18 PASS, 0 FAIL (the restored database carries the two new `gxp_calibration_history_*` triggers, equal to the source). Smoke on the bundle: a Grade A settle plate with 1 CFU answered `Action` with an excursion; QA calibrated with a signature (version 2); a reagent receipt with the password answered 200.
* **Found while testing**: the first version of the protection set for `calibration_history` broke the restore of a pre-migration backup into the v0.1.0 schema (`relation "calibration_history" does not exist`, two `upgrade-v0.1.0` tests); the set now skips a table that does not exist yet, as `protections/ops.ts` does.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: calibration by QA/Admin only and performed "today"; Out of Service not reactivated by a calibration; the seeded EM limits are the roadmap's Annex 1 example values, unapproved, with no alert limits; a result with no active limit is refused; only Action opens an excursion and no correction closes one; EM corrections by QA/Admin with a reason; stability Completed/Aborted final; the dispensing verifier co-signs in the same request; the new VERIFICATION meaning text and roles; templates by QA/Admin; observations blocked on Approved and Rejected samples; expired reagents refused at receipt; the dashboard's indicator wording.

## Not done

* **ELN review and witness signatures** (M12 design: "Reviewer and optional witness signatures with reviewer != author"): only authorship is implemented; none of the acceptance criteria needs them. The ELN screen still has no edit form for a draft (unchanged).
* **Managing the EM limits** (approve, change, retire a row) and **closing an excursion** (investigation): no route or screen; today a limit is changed by a migration or by QA with database access, and `env_excursions` rows stay `Open`.
* **Instrument status changes** (Out of Service to Active, Retire): there is still no route; a calibration no longer does it implicitly.
* The result-entry calibration check (`routes/results.ts`, r1-results-oos) still compares the due date from 00:00 UTC; `calibrationState` in `src/lib/validations/instruments.ts` is the shared rule to use.
* Legacy rows are not rewritten: v0.1.0 EM records keep `Action Level` (styled as Action) and no sample type; v0.1.0 batch materials keep `verifiedBy == dispensedBy` (shown as "not independently verified").
* The validation package has no entries yet for the limits table, the calibration history or the second-person verification; this document and the tests are the material. Nothing was approved or signed.

## For the gate

1. `git apply docs/changes/r1-quality-fixes.gate.patch`, then delete it. It contains:
   * `src/server/authz/routeTable.ts` (r1-authz): the ELN, template, calibrate, EM correction and stability rules take this track's strict schemas as `body` (so `meaning` is no longer an accepted key and `totpCode` is), and the dispensing rule accepts `verifier`. No permission code or role changes.
   * `src/db/protections/equipment.ts` (new) and one line in `src/db/protections.ts` (r1-migrations): `calibration_history` in the append-only registry, skipped while the table does not exist.
   * `tests/upgrade/upgrade-v0.1.0.test.ts` (r1-migrations): 0070's defaults (`instruments.version`, the three `env_records` columns) and seeded rows (13 meanings, 14 limits).
   * `tests/api/esign-verify.test.ts` (r1-esign): the ELN signature is made without a `meaning` key and found by entity; the `'N/A'` legacy case inserts the v0.1.0 row in SQL, since the route no longer writes one. The assertions are unchanged.
   * `tests/unit/core/occ.test.ts` (r1-core): the EM race now uses a sample type and a QA correction with a reason; still exactly one writer wins.
   * `tests/api/authz-fuzz.test.ts` (r1-authz): the ELN sign payload the screen sends has no `meaning` any more.
2. Regenerate `desktop/schema.sql` (`npx tsx src/server/boot/migrate-cli.ts export-schema`) after the last migration of the wave: it gains 0070.
3. `tests/route-table.json`: no route was added or removed by this track.
4. `scripts/dev/typecheck/baseline.json` (r1-build-shell): one entry no longer occurs (the dashboard's `expirationDate`); shrink with `node scripts/typecheck-server.cjs --update`.
5. Demo seed (`scripts/dev/seed/seeds/environmental.ts`, r1-build-shell): the seeded EM records have no sample type and no limits, and two are marked Pass by the old rule; give them sample types and the limits they are judged against, so the demo shows what the system now enforces.
