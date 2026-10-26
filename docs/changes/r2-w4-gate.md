# Wave gate R2 W4: lab operations

Release R2, wave W4. Tracks: r2-custody-labels (M29), r2-reagents (M30), r2-stability (M31), r2-em (M27 monitoring). Merged earlier
in R2: r2-ui-foundation, r2-master-data, r2-methods-calc, r2-qms, r2-raw-data, r2-api-v1, r2-events, r2-audit-tamper, r2-result-ui,
r2-coa-reports, r2-docs-training, r2-oos-workflow. This record lists what the gate did to the combined tree; each track's own record is
`r2-<track>.md`. Nothing here is a review, approval or signature.

## Gate edits (the four tracks' gate patches, applied in this order, then removed from the tree)

The patches were each cut against the W3 HEAD without the others. The three generated files in each (`tests/route-table.json`,
`docs/permission-matrix.csv`, `desktop/schema.sql`) were left out and regenerated once at the end.

1. `r2-custody-labels.gate.patch` (clean): custody, resolve routes; `custodyProtections`; `./custody` schema export; custody-received
   transition guard on `Testing`; shell extension, `App.tsx`, `SampleDetail.tsx`, `Samples.tsx`; permissions; ten existing tests that
   now call `receiveSample` (a fixture the patch adds) before testing starts.
2. `r2-reagents.gate.patch`: applied with fuzz except two hunks merged by hand (below). Result guard `reagent-lots`, `lotIds` on result
   saves (single and batch), `REAGENT_SCHEDULES`/`REAGENT_HANDLERS`, `reagent.expiry_alert` event, dashboard lot counts.
3. `r2-stability.gate.patch`: applied except three hunks merged by hand (below). `stabilityProgrammeRoutes`, `STABILITY_*`, the
   `stability-pull-missed` auto-open source, `equipment-stability` rewritten for the new `PUT /stability/:id` (ends a study only),
   authz-fuzz, occ and robustness test adjustments.
4. `r2-em.gate.patch`: applied except two hunks merged by hand (below). EM schedules and handlers, traceability batch dossier,
   demo seed, `./em` schema export.

Hand merges (all additions kept, none dropped):

* `src/server/routes/index.ts`: `stabilityProgrammeRoutes` import and module entry next to the custody and reagent additions
  (`reagentInventoryRoutes`, `custodyRoutes`, `resolveRoutes`).
* `src/lib/permissions.ts`: `stability.approve` appended to `SUPERVISORY`; `stability.manage` added to the QA and Reviewer default
  lists next to `reagent.manage`.
* `src/db/protections.ts`: `reagentsProtections` and `emProtections` appended to `protectionSets` after `custodyProtections`.
* `src/db/schema/index.ts`: exports in order `./em`, `./stability`, `./reagents`, `./custody` (order does not matter).
* `tests/upgrade/upgrade-v0.1.0.test.ts`: signature meanings 46 (39 + custody 2 + reagents 3 + stability 1 + em 1); `stability_conditions`
  7 rows and `em_limit_profiles` 25 rows expected; the `created_at` strips for both tables added; comments for 0220, 0230, 0240 and 0250.
  No assertion removed.

## Integration fixes (smallest changes)

* `tests/api/stability-programme.test.ts`: the pulled-sample test submitted a sample straight after the pull; r2-custody-labels now
  requires a receipt before testing, so the test calls `receiveSample` first (assertion unchanged).
* `tests/security-controls.sh`: the same guard blocked `workflow-start` and everything after it (9 FAIL). The script now records the
  receipt of each sample it creates (`recv`) before submitting. No assertion changed.
* `tests/api/em.test.ts`: `const ids: string[] = []` (an untyped empty array added a new strict type error).
* CI traps (database collation): in `stability-migration.test.ts`, `stability-programme.test.ts` and `em.test.ts` the ORDER BY on text
  columns whose result is compared with an expected list now use `COLLATE "C"`. This matters: `LT-5`, `LT-M20` and `LT-25-60` sort
  differently under en_US (hyphens ignored). No new test uses chmod, file modes, localhost or a user-dependent path.
* r2-custody-labels' ten edited existing tests were compared line by line: only the import and a `receiveSample` call were added.
  `equipment-stability.test.ts` is rewritten on purpose (r2-stability: `PUT /stability/:id` only ends a study, with a reason; edit of
  product, batch and condition no longer exists).

## Regenerated

* `tests/route-table.json`: 74 routes added, none removed or changed (custody, resolve, reagent lots and solutions, stability programme,
  environmental monitoring).
* `docs/permission-matrix.csv`: 96 permissions (custody.view/handle/locations/approve, label.print, reagent.manage/use/approve,
  stability.manage/approve, env.manage/env.correct added; existing view and record permissions list the new routes).
* `desktop/schema.sql`: from `drizzle/*.sql` through 0250 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: unchanged (18 known errors, none new).

## Gate evidence (shared tree plus the edits above, fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 141 files passed, 3 skipped (opt-in scale tests); 1681 tests passed, 4 skipped,
  0 failed. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed. `tests/upgrade/dump-diff.sh`: fresh
  install and upgraded v0.1.0 installation have identical schema (3888 lines of pg_dump) and journal.
* `npx tsx src/server/v1/openapi-cli.ts check`: the contract of /api/v1 is current.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, schema at 0250_em; lims_app role step: 28 append-only tables
  insert and read only, 71 guard triggers set to fire always), the demo seed, and the production bundle on 127.0.0.1:3190 (scratch
  BACKUP_DIR, BLOB_DIR, AUDIT_ANCHOR_DIR, ARTIFACT_DIR): `tests/security-controls.sh` 34 PASS, 0 FAIL (fresh database);
  `tests/backup-restore.sh` 18 PASS, 0 FAIL. As QA, `GET` on `/custody/locations`, `/stability`, `/em/points`, `/em/limit-profiles`
  and `/dashboard` return 200.
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed,
  0 failed.
* `npm run check:root`: root is clean. No browser session was run at the gate; the tracks' runs are in their records.

## Behaviour changes to note

* Migrations 0220, 0230, 0240 and 0250 are new. A sample must have a receipt (and a QA-signed deviation if one was raised) before it
  moves to Testing; existing tests, the security script and stability pulls were adjusted for that.
* Result saves refuse expired, quarantined, rejected or retest-overdue reagent lots named in `lotIds`.
* `PUT /stability/:id` only ends a study (Completed or Aborted, with a reason); studies are started from an Approved protocol.
* The 25 limit profiles seeded by 0250 stay Draft and unapproved: QA must review them against Annex 1 and the site SOP.
* The seven installed ICH storage conditions need QA review against site conditions.

## Not done at this gate (carried forward; owners named in the track records)

* Per-row lot picker in the result grid (r2-result-ui); instrument and reagent labels; chamber excursion logging and trending (r2-stability);
  notifications for retain due, stability pulls and EM trends (r2-events).
* Unused `stabilitySchema`, `stabilityUpdateSchema`, `DEFAULT_PULL_POINTS` and `StabilityStudy` in `src/lib/validations/stability.ts` and
  `src/types.ts` are left for their owner.
* No URS/OQ/RTM entries for M27, M29, M30 or M31 (r2-validation). The decisions for the user listed in the four track records are open.
* The full vitest run showed one transient "terminating connection due to administrator command" unhandled error in one of three runs
  (attributed to `samples-workflow.test.ts`, which passes alone three times); the next full run had no errors at all (141 files, 1681 passed).
