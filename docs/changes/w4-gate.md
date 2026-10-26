# Wave gate W4: specifications and quality fixes

Release R1, wave W4. Tracks: r1-spec (M11), r1-quality-fixes (M12, M13). Merged earlier: r1-core, r1-migrations, r1-build-shell, r1-identity, r1-audit, r1-backup-jobs, r1-esign, r1-authz, r1-client-shell. This record lists what the gate did to the combined tree; the tracks' own records are `r1-spec.md` and `r1-quality-fixes.md`. Nothing here is a review, approval or signature.

## Gate edits (the tracks' `*.gate.patch` files, applied and deleted)

Applied in this order: `r1-spec.gate.patch`, then `r1-quality-fixes.gate.patch`. The second patch's first `routeTable.ts` hunk carried the old `specifications` import line as context; it was applied with that context line updated to r1-spec's import. No other hunk was changed.

| Files | Why |
|---|---|
| `src/server/authz/routeTable.ts` | Body rules use the tracks' strict schemas: `specificationUpdateSchema`, `specificationApproveSchema`, `elnCreateSchema`, `elnUpdateSchema`, `elnSignSchema`, `notebookTemplateSchema`, `calibrateSchema`, `envRecordUpdateSchema`, `stabilityUpdateSchema`; the dispensing rule accepts `verifier`. |
| `src/db/protections/equipment.ts`, `src/db/protections.ts` | `calibration_history` is in the append-only registry (skipped while the table is absent). |
| `tests/api/authz-fuzz.test.ts`, `authz-sod.test.ts`, `authz-states.test.ts`, `esign-sign.test.ts`, `esign-verify.test.ts`, `tests/unit/core/occ.test.ts`, `tests/upgrade/upgrade-v0.1.0.test.ts` | Fixtures follow the new request shapes (no client `version`, the `{limit_kind, lower, upper, decimals}` parameter shape, no ELN `meaning`, EM `sampleType` and QA `reason`) and the new catalog rows (13 meanings, 14 example EM limits). No assertion was weakened. |

## Integration fix

`tests/upgrade/upgrade-v0.1.0.test.ts` failed in the combined tree only ("keeps every record"): 0060_spec adds `revision_label`, `created_by` and `approved_by` to `specifications`, and the test did not know them. They are now listed with the values the migration gives old rows of the v0.1.0 fixture (`revision_label` 1, since each fixture material has one revision; `created_by` and `approved_by` null, since the fixture's audit trail names nobody for seeded rows). The numbering rule itself is covered by `tests/api/spec-schema.test.ts`. The test failed before the line and passes after.

## Regenerated

* `desktop/schema.sql`: from `drizzle/*.sql` through 0080, now including 0060 and 0070 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: the `dashboard.ts` `expirationDate` entry no longer occurs and was removed (the baseline may only shrink).
* `tests/route-table.json`: unchanged (no route added or removed).

## Gate evidence (fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 23 known baseline errors, none new.
* `npx vitest run`: 76 files passed, 2 skipped (opt-in scale tests); 1013 tests passed, 3 skipped, 0 failed. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 60 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have the same schema and journal.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 11 migrations), `delete from users` and the demo seed as in CI, and the production bundle on 127.0.0.1:3190: server bundle, source map, installer and backup CLI are not served (404 each); `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL.

## Not done at this gate (carried forward, owners named in the tracks' records)

* Sample registration must store `spec_id` and `spec_revision` from `resolveActiveSpec` inside the sample transaction, and `src/types.ts` still has the `{min, max}` specification shape: r1-results-oos. Until then registration's `findFirst(material, 'Active')` can pick the wrong row once a future-dated revision is approved.
* The result-entry calibration check in `routes/results.ts` should use `calibrationState()`: r1-results-oos.
* `revisionLabel` in the Specification signature content (future hash version): r1-esign.
* The demo seed's EM records have no sample type: r1-build-shell.
* No routes yet to withdraw a specification or discard a Draft, to approve or retire EM limits, to close an excursion, or to change instrument status; ELN reviewer and witness signatures; validation-package entries for the new controls.
* Decisions for the user listed in both track records (approval blocked by samples in progress, VERIFICATION meaning wording and roles, Annex 1 example limits not site-approved, calibration QA/Admin only) are open.
