# Wave gate R3 W8: global search and performance

Release R3, wave W8. Track: r3-search-perf (M43 global search, code splitting, scale gate). Its own record is `r3-search-perf.md`. Nothing here is a
review, approval or signature; no signing key was generated or committed.

## Gate edits

* `r3-search-perf.gate.patch` applied with `git apply` against 9d1b2a8: it applied cleanly (nothing rejected, nothing merged by hand), then the patch
  file was deleted. It carried: route registry and the `GET /search: SELF()` rule, six trigram index declarations in `src/db/schema`, the grid search in
  `lookup.ts`, the dynamic import in `BarcodeScanner`, 15 lazy `shell/ext` screens, `tests/perf` in the vitest include, the qualified-modules core list.
* Regenerated once: `desktop/schema.sql` (`migrate-cli.ts export-schema`, through 0340; +48 lines), `docs/permission-matrix.csv` (113 permissions,
  unchanged: the route needs no new permission), `tests/route-table.json` (`GET /api/search`, auth required; one route added, none removed or changed).
* **Fix in `tests/perf/bundle.test.ts`**: the body of a skipped `describe` still runs while vitest collects, and the test called `analyse(dist)` in
  that body, so on a checkout without `dist/` (every CI run of `tests.yml`, which does not build, and any run as another user) the file failed with
  ENOENT instead of skipping. The analysis now runs inside the two tests; both assertions and the 700 KB budget are unchanged. Found by running as `nobody`.
* **Fix in `tests/unit/shell/typecheck.test.ts`**: five or more synchronous `tsc` runs (`spawnSync`, 35 to 90 s in total in one test) blocked the vitest
  worker beyond its 60 s heartbeat, which produced the unhandled error `Timeout calling "onTaskUpdate"` and a non-zero exit in two consecutive full
  runs. The runs are now asynchronous (`spawn`); every expectation is unchanged. This test belongs to an earlier wave and is not caused by this track,
  but a loaded CI runner could hit it as well.

## Gate evidence (fresh database `lims_gate`, server on 127.0.0.1:3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new; eslint 0 errors, 67 warnings (none new).
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset, as root, C.UTF-8 database): **167 files passed, 4 skipped; 2028 passed, 11 skipped, 0 failed,
  no unhandled error.** The skipped files are the opt-in scale tests (`tests/perf/scale.test.ts`, `audit-scale`, `reagents-scale`, `backup-scale`).
* `npx vitest run -c tests/upgrade/vitest.config.ts`: 12 files, 63 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 identical
  (4882 lines of pg_dump, journal equal). `desktop/schema.sql` equals a fresh export (`desktop-schema.test.ts`). `openapi-cli check`: current.
* `npm run build`; `tests/perf/bundle.test.ts` against the fresh `dist/`: **entry 351.9 KB, first load 644.1 KB (budget 700 KB)**, all JS 2822.7 KB. The
  PDF stack (`vendor-pdf` 816 KB), charts (469 KB), QR decoder (375 KB), Reports and Dashboard are outside the first load.
* Installer `dist-server/init-db.cjs` to `0340_global_search` (pg_trgm created, six `*_search_trgm_idx` present; 31 append-only tables, 79 guard
  triggers); demo seed; production bundle: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL (JWT_SECRET and
  LIMS_MASTER_KEY of the server exported to both); no error-level log line. Smoke on the production bundle: `GET /api/search?q=para` gives samples,
  specifications and methods with `indexed: true` for QA and for an analyst, and 401 without a token.
* Desktop (Electron, xvfb): `desktop-upgrade` 8/0, `desktop-shell` 17/0, `desktop-integrity` 5/0, `desktop-embedded` 24/0.
  `npm run test:installer` 27/27. `node validation/build/check.cjs`: 86 requirements, 74 Critical/High, all linked to a passed test or an open
  deviation. `npm run check:root`: clean. The RTM was not touched.

## CI traps checked

* **As `nobody`** (writable HOME and TMPDIR, writable copy of the tree, with and without `dist/`): `tests/perf` (search, search-fallback, bundle),
  qualified-modules, route-contract, desktop-schema all pass after the bundle test fix above.
* **Collation / ICU**: the dev database is C.UTF-8. A second PostgreSQL 16 cluster was initialised with ICU `en-US` (`--locale-provider=icu`) and the
  new search tests, the lookup and list tests (`ui-lookup`, `ui-lists`), worklists and qualified-modules (87 tests) all passed on it. The search SQL
  compares `search_norm(...)` on both sides and orders by rank and date, not by text collation.
* **pg_trgm in the CI service container**: `postgres:16` ships contrib and `pg_trgm` is a trusted extension, so `CREATE EXTENSION` works for the
  `lims` role (it is the container superuser in `tests.yml`). The migration handles both cases: `CREATE EXTENSION` sits in a nested block with
  `EXCEPTION WHEN OTHERS`, and the indexes are created only `IF EXISTS` the extension. The exception branch was exercised on the real server
  (a missing extension raises the notice and the index step is skipped); `search-fallback.test.ts` runs the route without the indexes and expects
  `indexed: false` and correct Latin and Arabic hits. Not verified: pg_trgm inside the bundled embedded PostgreSQL (the fallback covers its absence).
* **Loopback**: the new tests use 127.0.0.1; there is no `localhost` in `tests/perf` or `routes/search.ts`.
* **Duration**: `search.test.ts` about 9 s, `search-fallback.test.ts` 3 to 8 s, whole `tests/perf` under 30 s; the test timeout is 60 s. The scale
  test is opt-in (`PERF_SAMPLES`, `PERF_AUDIT`) and shows as 7 skipped in a normal run, so CI does not seed 50k to 100k samples.

## Observed, not caused by this track

* `tests/api/directory-signon.test.ts` "two first sign-ins of the same person at the same moment create one account" failed once in the second of three
  full root runs on a loaded machine (`[200, 401]` instead of `[200, 200]`); it passed in the third (final) full run and 6 of 6 isolated runs. It
  belongs to r3-directory (`src/server/auth/ldap.ts` retries once on unique violation 23505). Not changed here: a GitHub run could show it. QA/dev
  should look at whether the loser can fail for another reason than 23505 (for example a lock timeout) under load.

## Which new tests run in CI

`tests.yml` (PostgreSQL 16 service, non-root, no build): all of `tests/perf` except the opt-in scale file; the bundle test skips because there is no
`dist/` (it runs wherever `npm run build` ran first, as it did here). `migrations.yml` runs the upgrade suite, dump-diff and the schema.sql diff. The
Electron tests are not run in CI.

## Not done at this gate

* No browser run of the Ctrl+K palette and of the lazy screens (typecheck, eslint jsx-a11y and the production bundle served and fetched only).
* No requirements-traceability rows or OQ/PQ for global search: the traceability gate passes because it only checks existing requirements. QA must add
  them; nothing was invented here.
* Decisions for the user are listed in `r3-search-perf.md` (search visibility follows list permissions; 3-character minimum; Arabic folding).
