# Wave gate R2 W6: release and validation

Release R2, wave W6 (final). Tracks: r2-release (M36 controlled release), r2-validation (M37 validated scope, browser flows, traceability).
Their own records are `r2-release.md` and `r2-validation.md`. Nothing here is a review, approval or signature; the audit waivers keep
`approvedBy` blank and no signing key was generated or committed.

## Gate edits

* Applied `r2-validation.gate.patch` (app.ts guard mount, routes/index.ts, schema/index.ts, permissions.ts, authz/routeTable.ts, route
  table, permission matrix, desktop/schema.sql, upgrade test meaning count 47 to 48) and the r2-release gate patch (`.gitignore` `/release/`,
  SHA-pinned actions in build.yml, tests.yml, migrations.yml, `npm run test:installer` in tests.yml). Both applied cleanly, no hand merge.
  `desktop/schema.sql` regenerated (`migrate-cli.ts export-schema`, through 0300) and identical to the patch.
* `.gitignore`: `release/` became `/release/` (so `scripts/release/` is tracked) and `build/` hid `validation/build/` (the RTM, OQ and
  VSR generators and the traceability gate, never committed before); added `!/validation/build/`. `git status --ignored` afterwards lists
  only backups, dist, dist-server, node_modules, public/assets and the root `release/`.
* `package.json`: devDependencies `playwright` 1.56.1 and `axe-core` 4.10.3 (exact), scripts `test:e2e` and `validation:check`;
  `package-lock.json` updated with `npm install --package-lock-only`; `npm ci` verified in a scratch copy.
* `.github/workflows/e2e.yml`: manual only (`workflow_dispatch`) and `continue-on-error`, actions SHA-pinned, uses the new devDependencies
  (only the Chromium download remains in the job). It never ran on a GitHub runner, so it must not fail pushes for infrastructure reasons.
* `.github/workflows/build.yml`: tag trigger and the tag-attach step removed (release.yml attaches the installer, manifest, SBOM and
  checksums on tags and is a superset). Branch pre-release publishing of the Windows installer is kept unchanged.
* `tests/unit/shell/repo-hygiene.test.ts`: the test passed unchanged; it was renamed to "setup and update windows" and tightened (the
  one preload sits in `bridgeWindow()`, sandboxed, context-isolated, no node integration; only two `bridgeWindow({` calls; `openMain`
  has none). Nothing weakened.
* The 22 vitest failures reported by r2-release were all from migration 0300 and are gone with the validation patch and regeneration.

## Gate evidence (fresh database `lims_gate`, server on 127.0.0.1:3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new; eslint 0 errors, 67 warnings (a11y warnings, not errors).
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 155 files passed, 3 skipped; 1862 passed, 4 skipped, 0 failed.
  The W6 files (`qualified-modules`, `qualified-ui`, `validation-traceability`, `repo-hygiene`: 40 tests) and `npm run test:installer`
  (15) also pass as user `nobody` (writable HOME and TMPDIR).
* `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 identical (4359 lines of pg_dump). `openapi-cli check`: current.
* `npm run build`; installer `dist-server/init-db.cjs` to 0300 (31 append-only tables insert and read only, 79 guard triggers); demo
  seed; production bundle: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL; no error-level log line.
  Note: the backup and restore CLI verify the keyed audit chain, so they need the same `JWT_SECRET`/`LIMS_MASTER_KEY` as the server.
* Desktop on Electron 43.8.3: `desktop-upgrade` 8/0, `desktop-shell` 17/0, `tests/installer/desktop-integrity.cjs` 5/0.
  `electron-builder --linux dir` packaged with Electron 43.8.3 (the NSIS Windows build was not run).
* `node validation/build/check.cjs`: 86 requirements, 74 Critical/High, all linked to a passed test or open deviation.
  `npm run check:root`: clean. `npm ci` (scratch copy) succeeds.

## Not done at this gate

* The windows-latest silent install job, e2e.yml on GitHub, and the Playwright flows were not re-run here (evidence is r2-validation's
  run of 2026-10-25). `release:audit` fails until QA signs the waivers. No signing key or Authenticode certificate exists.
* Decisions for the user are listed in `r2-release.md` and `r2-validation.md`.
