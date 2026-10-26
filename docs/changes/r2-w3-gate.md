# Wave gate R2 W3: results, CoA, docs, OOS

Release R2, wave W3. Tracks: r2-result-ui (M19), r2-coa-reports (M25), r2-docs-training (M28), r2-oos-workflow (M26). Merged earlier
in R2: r2-ui-foundation, r2-master-data, r2-methods-calc, r2-qms, r2-raw-data, r2-api-v1, r2-events, r2-audit-tamper. This record lists
what the gate did to the combined tree; each track's own record is `r2-<track>.md`. Nothing here is a review, approval or signature.

## Gate edits (the four tracks' gate patches, applied in this order with `patch -p1`, then removed from the tree)

1. `r2-coa-reports.gate.patch` (clean): coa routes, `coa.issue`, `./reports` schema export, `reportsProtections`, `REPORT_HANDLERS`,
   upgrade-test meaning count.
2. `r2-result-ui.gate.patch` (offsets and fuzz only): `resultsBatchRoutes`, rule for `PUT /samples/:id/results-batch` (`result.enter`,
   `resultsBatchSchema`), the two `!x.ok` to `x.ok === false` lines in `src/server/lib/evaluate.ts` (same behaviour; clears the two
   lint:web errors).
3. `r2-oos-workflow.gate.patch`: two hunks merged by hand, each a one-line list addition: `oosProtections` appended to `protectionSets`;
   in `tests/upgrade/upgrade-v0.1.0.test.ts` the `oos_settings` (1 row) and `oos_checklist_templates` (2 rows) expectations. The other
   hunks (12 route rules, `oos.approve`/`oos.settings`, OOS guard and release blocker, dashboard overdue count, the decision now
   required in four existing tests, upgrade-test column defaults and timestamp strip) applied as written.
4. `r2-docs-training.gate.patch`: five hunks merged by hand, all additions next to lines the earlier patches added: `documentsProtections`
   appended to `protectionSets`; `export * from './documents'` and `'./training'` after `'./reports'` in `src/db/schema/index.ts`; the
   eight `doc.*`/`training.*` permissions after the raw-data entry in `src/lib/permissions.ts`; the `TRAINING_HANDLERS` import and spread
   after `REPORT_HANDLERS`; `training_curricula` (1 row) in the upgrade test. The `training_curricula.created_at` strip landed after
   `...snap`, as the track's fixed patch intends.
   * Upgrade test, combined: signature meanings 39 (28 + COA 2 + docs/training 6 + OOS 3); comments ordered by migration number.
     No assertion was removed.
* `r2-coa-reports.sampledetail.patch` was not applied: r2-result-ui's `SampleDetail.tsx` already carries that change.
* The combined result was compared file by file with the tracks' own combined W3 simulations (scratchpad `oosw-w3`, `r2coa/w3check`):
  the only differences are the order of the added list entries.

## Integration fix

None needed beyond the hand merges above: every gate below passed on the first combined run.

## Regenerated

* `tests/route-table.json`: 48 routes added (10 coa, 1 results-batch, 12 OOS, 25 documents and training), none removed or changed.
* `docs/permission-matrix.csv`: 84 permissions (`coa.issue`, `oos.approve`, `oos.settings` and the eight `doc.*`/`training.*` added);
  `PUT /samples/:id/results-batch` appears under `result.enter`.
* `desktop/schema.sql`: from `drizzle/*.sql` through 0210, now including 0190, 0200 and 0210 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: unchanged (18 known errors, none new).

## Gate evidence (copy of the shared tree plus the edits above, fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 132 files passed, 2 skipped (opt-in scale tests); 1574 tests passed,
  3 skipped, 0 failed; no unhandled errors. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed.
  `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have identical schema (2749 lines of pg_dump) and journal.
* `npx tsx src/server/v1/openapi-cli.ts check`: the contract of /api/v1 is current.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 22 migrations ending at 0210_oos_workflow; the lims_app role
  step reports 23 append-only tables insert and read only, 52 guard triggers set to fire always), the demo seed, and the production
  bundle on 127.0.0.1:3190 (BACKUP_DIR, BLOB_DIR, AUDIT_ANCHOR_DIR and ARTIFACT_DIR in a scratch folder): `tests/security-controls.sh`
  34 PASS, 0 FAIL; `tests/backup-restore.sh` (server's JWT_SECRET and SERVER_BACKUP_DIR exported) 18 PASS, 0 FAIL. As QA, `GET` on
  `/oos`, `/oos/overdue`, `/documents` and `/dashboard` return 200.
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed,
  0 failed.
* `npm run check:root`: root is clean. No browser session was run at the gate; the tracks' runs are in their records.

## Also in this commit

The W1 and W2 follow-up gate changes that were left staged in the shared index (their records `r2-w1-gate.md` and `r2-w2-gate.md`,
section "Follow-up gate": `GET /api/lookup/users` without service accounts; batch audit review bound to `throughSequence`) were part of
the tree every gate above ran on, so they are committed with it.

## Behaviour changes to note

* Migrations 0190, 0200 and 0210 are new; a development database built from the W2 tree upgrades in order (all three sort after 0180).
* Four existing tests now send the OOS closure `decision` that r2-oos-workflow makes required (authz-states, esign-verify,
  oos-lifecycle, samples-workflow); `auth-lifecycle` looks for the Certify audit entry on `TrainingRecord` (r2-docs-training).
* The software-trained flag is derived only from the LIMS-CORE curriculum; certifying any other module no longer enables signing.

## Not done at this gate (carried forward; owners named in the track records)

* The CoA snapshot does not yet print OOS retests after an Invalidated closure (r2-coa-reports with r2-oos-workflow); it errs on the
  safe side ("Does not comply").
* Reagent lot selection in the result grid (r2-reagents), the custody panel (r2-custody-labels), `tests/client-shell.cjs` C11/C12 on the
  new grid selectors and a Playwright test under `tests/ui/` (r2-validation).
* `result.enter` in the default matrix still grants Reviewer and QA, while result entry accepts Analyst, Admin and Instrument (r1-authz).
* The seeded OOS-2026-001 has status 'Phase II QA Review', outside the OOS vocabulary (seed owner).
* No outbox notifications for overdue investigations or training assignments (r2-events); no retention for report_runs PDF bytes.
* No URS/OQ/RTM entries for M19, M25, M26 or M28 (r2-validation). The decisions for the user listed in the four track records are open.
