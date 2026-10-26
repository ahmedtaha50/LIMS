# Wave gate R2 W5: instruments, worklists, KPIs

Release R2, wave W5. Tracks: r2-instrument-integration (M32 instrument capture), r2-worklists (M33), r2-tat-kpi (M34 turnaround and
dashboard). Merged earlier in R2: W1 to W4 (r2-ui-foundation through r2-em). This record lists what the gate did to the combined tree;
each track's own record is `r2-<track>.md`. Nothing here is a review, approval or signature.

## Gate edits (the three gate patches, applied in this order, then removed from the tree)

The patches were each cut against the W4 HEAD without the others. The three generated files in each (`tests/route-table.json`,
`docs/permission-matrix.csv`, `desktop/schema.sql`) were left out and regenerated once at the end.

1. `r2-instrument-integration.gate.patch` (clean): routes, `instrumentProtections`, schema export, `unaccepted-imports` transition
   guard, events, backup of instrument blobs, config and `.env.example`, `server.ts`, shell extension `imports.tsx`, upgrade test count.
2. `r2-worklists.gate.patch`: applied with fuzz except one hunk merged by hand. `worklistsRoutes`, `assignedAnalyst` result guard (first
   in `RESULT_GUARDS`), `WORKLIST_HANDLERS`, `worklist.view`/`worklist.manage`, route table entries.
3. `r2-tat-kpi.gate.patch`: applied with fuzz. `./tat` schema export, `TAT_SCHEDULES`, `TAT_HANDLERS`, `sample.tat_alert` event, route
   table entries (`metricsRoutes` is mounted from `routes/dashboard.ts`).

Hand merges (all additions kept, none dropped):

* `src/lib/permissions.ts`: the `DEFAULT_MATRIX` lines of QA (`instrument.profile.manage`, `worklist.manage`) and Analyst
  (`worklist.manage`) combine the instrument and worklist additions; `instrument.profile.approve` stays in `SUPERVISORY`, `worklist.view`
  in `EVERYONE`.
* `src/db/schema/index.ts`: `./instrument-data`, `./tat`, `./worklists` exports (order does not matter).
* `src/server/jobs/handlers/index.ts`: `TAT_HANDLERS` and `WORKLIST_HANDLERS` next to the W4 handlers.
* `tests/upgrade/upgrade-v0.1.0.test.ts`: signature meanings 47 (46 + `INSTRUMENT_PROFILE_APPROVAL`); worklists and TAT add none. No assertion
  removed.

## Integration fixes

None needed beyond the merges: no test failed on the combined tree and no existing test was edited by this gate.

## Regenerated

* `tests/route-table.json`: 49 routes added (instrument profiles and files, worklists, metrics, TAT settings), none removed or changed.
  (`tests/helpers/dump-route-table.ts` writes with `__dirname`, which fails under tsx ESM; the gate used `--stdout` redirected to the file.)
* `docs/permission-matrix.csv`: 100 permissions (`instrument.profile.manage/approve`, `worklist.view/manage` added).
* `desktop/schema.sql`: from `drizzle/*.sql` through 0280 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: unchanged (18 known errors, none new).

## Gate evidence (shared tree plus the edits above, fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 152 files passed, 3 skipped (opt-in scale tests); 1834 tests passed, 4 skipped,
  0 failed, no unhandled errors. `npx tsx src/server/v1/openapi-cli.ts check`: the contract of /api/v1 is current.
  `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have identical schema (4339 lines of pg_dump) and journal.
* The eleven new W5 test files (153 tests) run again as user `nobody` (HOME and TMPDIR writable, repository read-only to that user):
  all passed, so none depends on running as root or on file modes. New tests use no `localhost`, no collation-dependent text ordering
  (`COLLATE "C"` or JS sort).
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`: schema at 0280_tat; lims_app role step: 31 append-only tables
  insert and read only, 79 guard triggers set to fire always), the demo seed (`scripts/dev/seed/index.ts` after the README's
  `delete from users`), and the production bundle on 127.0.0.1:3190 (scratch BACKUP_DIR, BLOB_DIR, AUDIT_ANCHOR_DIR, ARTIFACT_DIR):
  `tests/security-controls.sh` 34 PASS, 0 FAIL (fresh database); `tests/backup-restore.sh` 18 PASS, 0 FAIL; no error-level line in the
  server log.
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed,
  0 failed.
* `npm run check:root`: root is clean. No browser session was run at the gate.

## Behaviour changes to note

* Migrations 0260, 0270 and 0280 are new (tables for instrument capture, worklists and turnaround).
* An analyst who is not assigned on a Released worklist gets 403 NOT_ASSIGNED when entering a result for a worklisted item.
* Instrument files are only accepted into results through the review screen or API, by Analyst or Admin; capture profiles need QA
  approval with an e-signature.
* The first TAT sweep after install gives received open samples a Routine due date and announces overdue ones.
* Default weekend (Saturday, Sunday, UTC) and default SLA days (10, 3, 1) are placeholders until QA saves a calendar.

## Not done at this gate (carried forward; owners named in the track records)

* No screen for the business calendar, holidays, SLA rules or sample priority (API only); no priority or due column in the sample list.
* Instrument: no serial connector or XML/Excel parsers; no restore test for instrument blobs.
* Worklists: no DB triggers on the new tables, no outbox events. No URS/OQ/RTM entries for M32 to M34 (r2-validation).
* The decisions for the user listed in the three track records are open.
