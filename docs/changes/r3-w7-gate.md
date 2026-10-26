# Wave gate R3 W7: platform and analytics

Release R3, wave W7. Tracks: r3-embedded-pg (M40 built-in database), r3-spc (M39 trending and SPC), r3-directory (M41 directory sign-on),
r3-periodic-archive (M42 periodic review, retention, archive). Their own records are `r3-<track>.md`. Nothing here is a review, approval or
signature; the audit waivers keep `approvedBy` blank and no signing key was generated or committed.

## Gate edits

* The three code gate patches (`r3-directory`, `r3-spc`, `r3-periodic-archive`) were cut separately against 67f8f43 and conflict in shared files. They were
  applied with `git apply --reject` (derived files excluded) and the rejected hunks merged by hand, then the `.gate.patch` files were deleted:
  `src/db/schema/index.ts` (exports directory, spc, periodic), `src/lib/permissions.ts` (3 + 2 + 6 permissions, positions 310-312, 320-321, 330-335;
  `spc.manage` and the four periodic/archive/retention write permissions are SUPERVISORY, `periodic.view` and `archive.view` go to QA and Reviewer),
  `src/server/authz/routeTable.ts` (imports and rules of all three), `src/server/jobs/handlers/index.ts` and `src/server/schedules/index.ts`
  (OOT and PERIODIC), `src/server/qualified.ts` (modules `trending` and `periodic-archive`; `directory` is listed as core in
  `tests/api/qualified-modules.test.ts`).
* Signature meanings: HEAD 48 + DIRECTORY_MAPPING + SPC_BASELINE_APPROVAL + PERIODIC_REVIEW, ARCHIVE_DECISION, RETENTION_POLICY, LEGAL_HOLD = **54**
  (`tests/upgrade/upgrade-v0.1.0.test.ts`; none of the patches' own numbers 49, 49, 52 was right on its own).
* Regenerated once at the end: `desktop/schema.sql` (`migrate-cli.ts export-schema`, through 0330), `docs/permission-matrix.csv` (113 permissions),
  `tests/route-table.json` (396 routes, 215 added, none removed or changed).
* `r2-validation.gate.patch` is tracked and already applied: left alone.
* **r3-embedded-pg gate patch NOT applied** (`r3-embedded-pg.gate.patch` stays in `docs/changes/`): it adds `npm run fetch:pg` to `build.yml` and
  `release.yml`, which must wait until the PostgreSQL archive SHA-256 is pinned in `desktop/pg-bundle.json` (it is `null`; `fetch:pg` refuses to run).
  Instead of that step, both workflows got an explicit check (`Built-in PostgreSQL bundle check`) that prints a warning annotation and a step
  summary when `build/pgsql` is absent. Reason: electron-builder only logs "file source doesn't exist from=build/pgsql" and still produces the
  installer (verified with `electron-builder --linux dir`), so the Windows CI job would silently ship an installer without a database. At runtime
  the shell refuses the built-in option with a clear message (`NO_BUNDLE`) and "Connect to an existing PostgreSQL" still works. The step does not
  fail the job: failing would stop every installer until the pin exists. Decision for the user: make it fail in `release.yml` (tags) once the pin exists.
* `tests/api/periodic-archive.test.ts`: the tamper test copied a bundle (folders are read-only 0555) over itself, which only works as root. It now
  unlocks the folders and copies into a fresh tree. Found by running as `nobody`; no assertion was changed or removed.

## Gate evidence (fresh database `lims_gate`, server on 127.0.0.1:3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new; eslint 0 errors, 67 warnings.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset, as root): 164 files passed, 3 skipped; 2012 passed, 4 skipped, 0 failed.
* `npx vitest run -c tests/upgrade/vitest.config.ts`: 12 files, 63 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 identical
  (4853 lines of pg_dump). `desktop/schema.sql` equals a fresh export. `openapi-cli check`: current.
* `npm run build`; installer `dist-server/init-db.cjs` to 0330; demo seed; production bundle: `tests/security-controls.sh` 34 PASS, 0 FAIL;
  `tests/backup-restore.sh` 18 PASS, 0 FAIL; no error-level log line.
* Desktop (Electron 43.8.3, xvfb): `desktop-upgrade` 8/0, `desktop-shell` 17/0, `desktop-embedded` 24/0 (real PostgreSQL 16 started by the shell),
  `tests/installer/desktop-integrity.cjs` 5/0; `npm run test:installer` 27/27.
* As user `nobody` (writable HOME and TMPDIR, writable copy of the tree): spc, directory, periodic-archive, qualified-modules, route-contract,
  repo-hygiene and the other shell unit tests, `app-pool` and `test:installer` all pass (after the test fix above).
* Collation: the dev box database is C.UTF-8, which hides ordering bugs. spc, directory, periodic-archive and qualified-modules (130 tests) were
  re-run on a database created with ICU `en-US`: all pass (the new SQL orders text with `COLLATE "C"`).
* Loopback: the new tests use 127.0.0.1 (no `localhost`).
* `electron-builder --linux dir` packages (Electron 43.8.3) without `build/pgsql` (warning only). `npm ci` in a scratch copy succeeds, `ldapts` installs.
* `node validation/build/check.cjs`: 86 requirements, 74 Critical/High, all linked to a passed test or open deviation. `npm run check:root`: clean.

## Which new tests run in CI

`tests.yml` (ubuntu-latest, PostgreSQL 16 service on 5432, non-root): the vitest suite including all new API/unit files and `tests/upgrade/app-pool.test.ts`;
`npm run test:installer` including `pg-supervisor.test.cjs` (initdb and a real postgres as the runner user on its own port, coexisting with the service;
skipped with a message if the 16 binaries are not found). `migrations.yml` runs the upgrade suite, dump-diff and the schema.sql diff. The
`tests/desktop-*.cjs` Electron tests (including `desktop-embedded`) are not run in CI. The Windows job and the embedded database were not run on GitHub.

## Not done at this gate

* No requirements-traceability rows or OQ/PQ protocols exist for the R3 modules (trending, directory, periodic-archive, embedded database):
  the traceability gate passes because it only checks existing requirements. QA must add them; nothing was invented here.
* PostgreSQL archive SHA-256 not pinned; Windows 11 clean-VM acceptance, NSIS/icacls/DPAPI paths, a real Active Directory and the screens in a browser
  were not exercised (see the track records). `release:audit` still fails until QA signs the waivers. No signing key or certificate exists.
* Decisions for the user are listed in each `r3-<track>.md`.
