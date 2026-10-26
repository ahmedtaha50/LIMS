# Wave gate R2 W1: foundation

Release R2, wave W1. Tracks: r2-ui-foundation (M24), r2-master-data (M17), r2-methods-calc (M18), r2-qms (M27). Merged earlier in R2: none.
This record lists what the gate did to the combined tree; each track's own record is `r2-<track>.md`. Nothing here is a review,
approval or signature.

## Gate edits (the four tracks' gate patches, applied in this order and then deleted)

1. `r2-ui-foundation.gate.patch` (`git apply`): `inboxRoutes`, `lookupRoutes`; 8 route rules.
2. `r2-master-data.gate.patch` (`git apply`): products, batches, customers; 15 rules; `master.*` codes; `./master` schema export;
   `sample_context` protections; `insertSamples` export; upgrade-test expectations.
3. `r2-methods-calc.gate.patch` (`git apply`): calc, methods, test plans; 19 rules; `method.*` codes; `./methods` and `./calc`
   exports; `result_inputs`/`sst_runs` protections; result and transition guards; shell extension; `seedMethods`; upgrade-test expectations.
4. `r2-qms.gate.patch` (`git apply --reject -C1`): it was cut without r2-methods-calc's patch in the tree, so three files were merged by
   hand. Every other hunk applied as written (including the change-control calls in `specifications.ts` and `roleChange.ts`, the
   batch dossier deviations, the backup-failed auto-open and the release blocker).
   * `src/db/protections.ts`: `qmsProtections` appended after `methodsProtections` in the registry.
   * `src/lib/permissions.ts`: the five `qms.*` codes after the `method.*` codes; `qms.view/create/edit` to everyone, `qms.approve` and
     `qms.settings` to the supervisory set, exactly as in the patch.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: signature meanings 24 (14 + 3 methods + 7 QMS; each patch alone said 17 or 21) and the one
     `qms_settings` row. No assertion was removed.

## Integration fix

`scripts/check-root-clean.sh`: r2-ui-foundation's root `eslint.config.js` (eslint's flat config, which eslint reads from the root only)
would be reported as `STRAY SCRIPT` once committed, failing `tests/unit/shell/repo-hygiene.test.ts` ("passes for this repository").
The check now allow-lists that one configuration file by name; any other root `.js/.cjs/.mjs` still fails. Test first: a new case in
`repo-hygiene.test.ts` (a fixture repository with a tracked `eslint.config.js`) failed before the change and passes after it; the case
that names stray scripts (`fix.js`, `patch-api.cjs`, `tool.mjs`) is unchanged and still passes.

## Regenerated

* `tests/route-table.json`: 58 routes added (8 + 15 + 19 + 16), none removed or changed.
* `docs/permission-matrix.csv`: 69 permissions (3 master, 3 method, 5 QMS added); the new lookup, list, calc and batch-registration
  routes appear under their existing permissions.
* `desktop/schema.sql`: from `drizzle/*.sql` through 0180 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: unchanged (18 known errors, none new).

## Gate evidence (fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run`: 99 files passed, 2 skipped (opt-in scale tests); 1294 tests passed, 3 skipped, 0 failed; no unhandled errors.
  Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed. `tests/upgrade/dump-diff.sh`: fresh install and
  upgraded v0.1.0 installation have identical schema (1551 lines of pg_dump) and journal.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 15 migrations ending at 0180_qms), the demo seed, and the
  production bundle on 127.0.0.1:3190: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL.
  As QA, `GET` on `/inbox`, `/lookup/samples`, `/lists/samples`, `/products`, `/batches`, `/customers`, `/methods`, `/calc/formulas`,
  `/test-plans`, `/qms/records`, `/qms/settings` and `/traceability/batch/BATCH-2026-001` all return 200 (the routes are mounted).
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed,
  0 failed.
* No browser session was run at the gate; the tracks' browser runs are in their records.

## Not done at this gate (carried forward; owners named in the track records)

* Accessibility: axe still fails on sample detail, OOS investigations and audit trail (r2-result-ui, r2-oos-workflow, AuditTrail owner).
  About 15 hand-made overlays are not on `ui/Modal`; only samples has a `/lists/<entity>` route.
* eslint and its plugins are not devDependencies and `lint:a11y` is not in `npm run lint` or CI (r2-release, r2-validation).
* Free-text sample registration writes no `sample_context` row; `masterBatchReleaseBlocker` is not registered; the demo seed has no
  master records for its batches (owners of `routes/samples.ts`, release blockers, seed).
* Calculated result entry and SST runs are API only (r2-result-ui); `required_training_module` is not enforced (r2-docs-training).
* QMS auto-open is wired only for failed backups; OOS confirmation, EM excursion, instrument overdue use and audit-chain failure are not
  (r2-oos-workflow, r2-em, r2-instrument-integration, r2-audit-tamper). The document change-control gate waits for r2-docs-training.
* Migration numbers 0100, 0110 and 0180 follow the roadmap's R2 ranges, not the task texts' ranges (decision for the user, in each record).
* No URS/OQ/RTM entries for M17, M18, M24 or M27 (r2-validation). The decisions for the user listed in the four track records are open.

## Follow-up gate (2026-10-20)

The four tracks were dispatched again after the merge. r2-methods-calc and r2-qms changed nothing. r2-master-data added a re-verification
note to its record. r2-ui-foundation took up one item handed back by r2-api-v1 / the W2 gate: `GET /api/lookup/users` no longer offers
API client service accounts (role `Instrument`), also not for `?role=Instrument` or `?id=`. Committed: `src/server/routes/lookup.ts`,
`tests/api/ui-lookup.test.ts`, `docs/changes/r2-ui-foundation.md`, `docs/changes/r2-master-data.md` and this note. The other uncommitted
files in the shared tree belong to later-wave tracks in flight (r2-coa-reports, r2-result-ui, r2-docs-training) and were not committed.

Gate evidence, on a `git archive HEAD` copy (7df6e8e) plus the four files, fresh database `lims_gate`, server on 127.0.0.1:3190:

* Test first: the new ui-lookup case failed on HEAD's `lookup.ts` (returned `usr-lk-svc`, "API client: Lookup HPLC") and passes after.
* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run`: 118 files passed, 2 skipped; 1438 tests passed, 3 skipped, 0 failed; no unhandled errors.
* `npm run build`; `dist-server/init-db.cjs` (19 migrations, to 0180_qms); `npm run seed`; production bundle on port 3190:
  `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL (the backup CLI must run with the server's
  `JWT_SECRET`, the keystore fallback that keys the audit chain; without it `verify` reports the chain broken at sequence 2).
* Desktop: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* `tests/route-table.json`: unchanged (no route added or removed).
