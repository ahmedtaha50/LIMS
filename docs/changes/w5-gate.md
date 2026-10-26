# Wave gate W5: results and OOS

Release R1, wave W5. Track: r1-results-oos (M10). Merged earlier: r1-core, r1-migrations, r1-build-shell, r1-identity, r1-audit, r1-backup-jobs, r1-esign, r1-authz, r1-client-shell, r1-spec, r1-quality-fixes. This record lists what the gate did to the combined tree; the track's own record is `r1-results-oos.md`. Nothing here is a review, approval or signature.

## Gate edits (the track's `r1-results-oos.gate.patch`, applied unchanged and deleted)

| Files | Why |
|---|---|
| `src/server/authz/routeTable.ts` | Body rules use the track's strict schemas: `bulkImportSchema`, `oosOpenSchema`, `oosUpdateSchema` (so `PUT /oos/:id` accepts `phase`), `batchReleaseSchema` (so release accepts `totpCode`); the OOS close guard moves to `Closed`. |
| `src/server/routes/reports.ts` | `isOOS` to `isOos` (column rename). |
| `src/server/routes/traceability.ts` | The release signature is found by entity `BatchRelease` and the batch when `batch_releases.signature_id` is empty (releases now signed through `signRecord`); v0.1.0 releases are still found by `signature_id`. |
| `tests/api/auth-lifecycle.test.ts`, `eln-integrity.test.ts`, `esign-sign.test.ts`, `esign-verify.test.ts`, `tests/unit/core/occ.test.ts`, `tests/upgrade/upgrade-v0.1.0.test.ts` | Fixtures follow the deliberate behaviour changes: review needs every result entered, results are entered only in Testing, the sample and release routes no longer write unbound legacy signatures (the legacy rows are now inserted directly, as v0.1.0 wrote them), and 0050 adds nullable columns the upgrade test must know. No assertion was weakened. |

## Integration fix

`src/server/routes/traceability.ts`: the patched release-signature lookup added a new server type error (`batchSignatures` was inferred as `never[]`, so `.some(s => s.id ...)` failed; the typecheck baseline count rose from 2 to 3). `batchSignatures` is now typed as the `signatures` row type. That removes the new error and two older baseline errors on the same array.

## Regenerated

* `desktop/schema.sql`: from `drizzle/*.sql` through 0080, now including 0050 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: 21 to 18 known errors; entries removed for `routes/oos.ts`, `routes/reports.ts` (`isOOS`), `routes/samples.ts` and two in `routes/traceability.ts`. Nothing added (the baseline may only shrink).
* `tests/route-table.json`: unchanged (no route added or removed).

## Gate evidence (fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run`: 82 files passed, 2 skipped (opt-in scale tests); 1071 tests passed, 3 skipped, 0 failed; no unhandled errors. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 60 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have the same schema and journal.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 12 migrations including 0050), `delete from users` and the demo seed, and the production bundle on 127.0.0.1:3190: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL.

## Not done at this gate (carried forward, owners named in the track's record)

* Migration 0050 sorts before the already-applied 0060 to 0080: a development or gate database built from the W1 to W4 tree is refused with `OUT_OF_ORDER` and must be rebuilt. Fresh installs and v0.1.0 upgrades are fine. 0050 was the slot assigned to this track, so it was kept.
* `result.enter` is still granted to Reviewer and QA in the default permission matrix (the handler refuses them): r1-authz, with a migration, after QA confirms.
* Legacy OOS status words (the seed's `Phase II QA Review`) block approval and release but cannot be edited or closed through the authz layer: r1-authz (`entityStates.ts`) or r1-build-shell (seed data).
* Demo seed: OOS-2026-001 to status `Open`, phase `Phase II`; specifications in the new parameter shape with decimals; `npm uninstall xlsx`: r1-build-shell.
* `pdfWorker.ts` CoA prints `null - null` for text limits and stamps `Official` on any state: r1-backup-jobs.
* OQ/RTM updates for URS-010 and URS-012 and the deviation extending DEV-2026-10-13-04: validation package owner.
* No browser session was run on the new screens.
* Decisions for the user listed in `r1-results-oos.md` (rounding without declared decimals, censored values, entry roles, OOS model, release blocked by a Rejected sample, CSV export) are open.
