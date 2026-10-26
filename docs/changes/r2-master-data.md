# r2-master-data: products, batches, customers and registration from them (roadmap M17)

Release R2, first track. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-master-data.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** All three M17 acceptance criteria pass in a gate simulation
(`git archive HEAD` + this track + the patch). In the shared tree without the patch, the new routes are not mounted. Six existing
tests that count catalog rows or triggers then fail, as they did for r1-authz and r1-esign (listed under "For the gate").

**Re-verified 2026-10-19** against the shared tree as it now stands (with r2-ui-foundation's screens and patch, and r2-methods-calc's
work in progress). No code of this track changed. Two things changed: the `routes/index.ts` hunks of the gate patch now carry one line of
context each, so the patch applies whether or not r2-ui-foundation's patch is already in (see "For the gate", step 1), and the screens are
now reachable through r2-ui-foundation's shell (`shell/ext/master-data.tsx`, "Register from product and batch" in `Samples.tsx`) and
were exercised in a browser. Results are under "Evidence (re-verification)".

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0100_master_data.sql`. Tables `products`, `product_batches`, `customers`, `sample_context`. Backfill from the existing specifications and samples with a zero-orphan check. Append-only triggers on `sample_context`. Meaning `MASTER_DATA_STATUS`. Permissions `master.view`, `master.manage`, `master.status` with their grants (catalog rows only under the runner) |
| Schema | `src/db/schema/master.ts` |
| Validation (strict) | `src/lib/validations/master.ts`. Server-controlled fields (`id`, `status`, `version`, `origin`, `created_by`) are never accepted. A status moves only through its own route |
| Routes | `src/server/routes/products.ts`, `batches.ts`, `customers.ts` (new), `traceability.ts` (master batch in the list and in the dossier; invented names removed) |
| Screens | `src/components/RegisterSampleDialog.tsx` (product picker, then batch picker, then optional customer; shows the Active specification), `src/components/MasterData.tsx` (products, batches, customers; signed status changes), `src/components/Traceability.tsx` (batch list from the API instead of three hard-coded numbers; master record panel; no invented QP name) |
| Tests | `tests/api/master-data.test.ts` (18), `tests/api/master-migration.test.ts` (5), `tests/api/master-ui.test.ts` (6) |

### API

| Route | Permission | What it does |
|---|---|---|
| `GET /products`, `GET /products/:id` | `master.view` | The list. One product with its batches and the specification revision in force (`resolveActiveSpec`) |
| `POST /products` | `master.manage` | `{code, name, description?}`. 409 if the name matches another product's name after case and spaces are normalised (the key the specifications already use), or the code matches another code ignoring case |
| `PUT /products/:id` | `master.manage` | `{description, expectedVersion}`. Name and code never change, because they are the text that samples and specifications hold |
| `POST /products/:id/status` | `master.status` | Active and Inactive. E-signed (`MASTER_DATA_STATUS`, reason required) and bound to the new record version |
| `GET /batches[?productId&status]`, `GET /batches/:id` | `master.view` | Batches with the product name. One batch with the samples registered against it (through `sample_context`) |
| `POST /batches` | `master.manage` | `{productId, batchNo, manufacturedOn?, expiresOn?, batchSize?}`. Starts in Quarantine. Unique per product: the same number under another product is allowed, and a duplicate within one product (any case or spacing) is 409. Expiry before manufacture, or a date that does not exist, is 400. An Inactive product is 409 |
| `PUT /batches/:id` | `master.manage` | Dates and size, only while the batch is in Quarantine (423 after that). Uses the version predicate and writes one audit entry per changed field |
| `POST /batches/:id/status` | `master.status` | E-signed. Allowed moves: Quarantine to Released (only after the formal release `POST /traceability/batch/:batch/release` has released that batch number, otherwise 409 `RELEASE_REQUIRED`) or Rejected; Released to Recalled. Rejected and Recalled are final (423) |
| `POST /batches/:id/samples` | `sample.register` | `{customerId?}`. One transaction: locks the batch, checks that the batch is Quarantine or Released, the product is Active, the customer (if given) is Active, and a specification is in force. It then runs the same `insertSamples` as `POST /samples`, with `samples.material` and `samples.batch` filled from the master rows, inserts the `sample_context` row and writes its audit entry |
| `GET /customers`, `POST /customers`, `PUT /customers/:id`, `POST /customers/:id/status` | `master.view` / `master.manage` | Customers. The code is unique ignoring case. A status change is audited with its reason but is not e-signed |

Every create and update writes its audit entry in the same transaction. Every update carries the version predicate. Every e-signature goes
through `signRecord`. Two new record types are registered: `Product` (covers id, code, name and the status as signed) and `ProductBatch`
(covers id, product, number, dates, size and the status as signed; its fields are frozen once it leaves Quarantine).

### Migration 0100 on existing data

* One product per material key found in `specifications` or `samples`. The name comes from the Active specification with the latest
  effective date, else from any specification, else from the first sample. The code is the same text. The file reads only columns of the
  v0.1.0 baseline, so it runs whichever other migrations are present (`spec-schema.test.ts` builds a database without 0060).
* One batch per (product, `samples.batch`). The text is exact. The status is Released or Rejected when `batch_releases` holds that word for
  the number, otherwise Quarantine. Dates and size stay NULL: they were never recorded and are not invented.
* One `sample_context` row per sample, with no customer. If any sample is left unmapped, the whole run aborts and nothing changes.
* Backfilled rows have `origin = 'migration'`, `created_by` NULL and `created_at` set to the run time. The run's `SCHEMA_MIGRATED` audit
  entry, which carries the file checksum, is their record.
* `samples`, `results`, `signatures` and `specifications` are not touched.

## Why

* M17 (gap G12 plus the traceability fixes): material and batch were free text that had to match an Active specification exactly. There
  was no manufacturing date, expiry date or customer, so a CoA could not show them. Traceability hard-coded `BATCH-2026-001..003`.
* Fabricated data on GxP screens (the family named in `synth.topDefects`), in files this track now owns:
  * The batch list invented the product name `'Pharmaceutical Formulation'` (or `Batch <n>`).
  * The release record named `'Qualified Person'` / `'QP'` when it named nobody.
  * The release certificate printed `'Dr. Sarah Jenkins'` as the QP when the record named nobody, and `'Archived'` as the release time.

  Now the records' values are shown, or "not recorded".
* "Strict Zod schemas for the dispense and verify routes": already done by r1-quality-fixes (`batchMaterialSchema`, second-person
  verification). I checked it and left it unchanged.

## Deliberate behaviour changes

1. `GET /traceability/batches` lists master batch numbers too. It adds `products` and `masterStatus`, and `material` is `null` instead of
   an invented name. `GET /traceability/batch/:batch` adds `master`. `releasedByName` and `releasedByRole` are `null` when the release
   names nobody.
2. The traceability screen starts on the first batch the API returns instead of `BATCH-2026-001`.
3. With the gate patch: 15 new routes, 3 new permission codes (61 in all), 1 new signature meaning (14), 2 new `gxp_` triggers
   (`sample_context`), and `insertSamples` is exported from `routes/samples.ts`.

## How to verify

```
# shared tree, no wiring needed: migration, drift and screens (11 tests)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/master-migration.test.ts tests/api/master-ui.test.ts

# after `git apply docs/changes/r2-master-data.gate.patch` and the regeneration below
SQL_... npx vitest run tests/api/master-data.test.ts
SQL_... npx vitest run
npm run lint
```

## Evidence

* **Test first.** On the untouched code, `master-data.test.ts` failed 18 of 18 (every route answered 404 `No such API route`).
  `master-migration.test.ts` could not load (no `src/db/schema/master.ts`, no 0100). The screens test came after the components, but its
  source assertion fails on the HEAD `Traceability.tsx`, which contains fixed `BATCH-2026-00x` numbers (initial value, quick-select list, placeholder) and `Dr. Sarah Jenkins`.
  One failure on the first green run was my own test's ordering (it created a batch after deactivating the product, which is correctly
  refused). The test was fixed to assert that refusal.
* **Acceptance (M17), all in `master-data.test.ts` and `master-migration.test.ts`:**
  1. Registering via product and batch fills `samples.material` and `samples.batch` and stores the ids in `sample_context`. Asserted
     exactly, together with the results seeded from the specification revision, the `Sample` then `SampleContext` audit entries, and no
     writes when refused.
  2. On the real v0.1.0 fixture, the migration maps all 5 samples (3 products, 5 batches with their release state) with zero orphans and
     no mismatch between ids and text. `samples`, `results`, `signatures` and `specifications` are byte-identical. Every signature's
     verification result (status, valid, content-hash match) is the same before and after 0100.
  3. The same batch number under two products gives 200 and 200. A duplicate within a product gives 409, also in another spelling and
     under a race (two simultaneous creates give `[200, 409]` and one row). The database index refuses it too.
* **Mutation checks** (each must turn a test red, and each did): the `ProductBatch` signature not covering the expiry date; Released
  allowed without the formal release; the duplicate-batch check removed; the `sample_context` backfill removed (the zero-orphan guard
  aborts the migration).
* **Gate simulation** (`git archive HEAD` + this track + the gate patch + regenerated files):
  * `npx vitest run`: 85 files passed, 2 skipped; 1100 passed, 3 skipped, 0 failed.
  * There were 2 unhandled errors: a `57P01` during `schema-drift` teardown (the harness race r1-esign recorded; the file passes alone,
    7 of 7) and a vitest RPC timeout under load.
  * `npm run lint`: web clean; server 18 known baseline errors, none new.
* **Shared tree:** `npm run lint` is clean for my files (server: 18 known, none new). `batches.ts` reaches `insertSamples` through a typed
  lookup until the patch exports it.
* **Shared checks**, run on the production bundle of the simulation (`npm run build`). The database was made by `dist-server/init-db.cjs`
  (13 migrations including 0100), then `delete from users` and the demo seed, with the server on 127.0.0.1:3101:
  * `tests/security-controls.sh`: 34 PASS, 0 FAIL.
  * `tests/backup-restore.sh`: 18 PASS, 0 FAIL.
  * Smoke: QA created a product and a batch, and an Analyst registered `SMP-2026-00007` from the batch, bound to `SPEC-PARA-500` rev 1.
* **Desktop**, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17
  passed, 0 failed.

## Evidence (re-verification, 2026-10-19)

Simulation `scratchpad/r2md-sim2`: `git archive HEAD`, plus every modified and untracked file of the shared tree (all tracks of the wave),
plus `r2-ui-foundation.gate.patch`, then `r2-master-data.gate.patch` (both with plain `git apply`), then the three regenerations below.

* `npx vitest run`: 91 files passed, 2 skipped, 4 failed; 1179 tests passed, 3 skipped, 16 failed. Every failure is in r2-methods-calc's
  in-flight tests (`methods-calc`, `methods-migration`, `methods-ui`, `unit/calc`), which cannot load or pass until that track's
  migration 0110, schema and modules exist. All of this track's files pass (`master-data` 18, `master-migration` 5, `master-ui` 6), as do
  the files that depend on the patch (`upgrade-v0.1.0` 10, `schema-drift` 7, `protections` 4, `boot` 2, `desktop-schema` 4,
  `authz-matrix` 57, `authz-migration` 5, `route-table` 4) and r2-ui-foundation's (`ui-inbox`, `ui-lists`, `ui-lookup`, `unit/ui-foundation`).
  One unhandled `57P01` came from a scratch database of `upgrade-v0.1.0` being dropped during teardown (the harness race recorded by
  r1-esign, r1-results-oos and r2-ui-foundation); that file passed 3 of 3 runs on its own.
* `npm run lint`: web clean; server 7 errors, all in r2-methods-calc's test files (modules not yet written). None in this track's files.
* Shared tree without the patch: `master-migration` and `master-ui` 11 of 11.
* `npm run build`, then `dist-server/init-db.cjs` on a new database (13 migrations, ending at 0100), `delete from users`, the demo seed, and
  the production bundle on 127.0.0.1:3101: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL.
* API smoke on the bundle: QA created product and batch `PCM-26-101` (Quarantine, dates kept); a duplicate in another spelling was 409;
  an Analyst creating a batch was 403; an Analyst registered `SMP-2026-00007` from the batch, and `sample_context` holds its product and
  batch ids.
* Browser (Playwright, Chromium, same server): QA opened `#/master-data`, saw the product and batch, added a customer (toast "created
  (audit logged)"); the Analyst saw no "Add product" control; from `#/samples`, "Register from product and batch" showed
  `SPEC-PARA-500` for the chosen product and registered `SMP-2026-00008` with the customer (success toast); `#/traceability` listed
  `PCM-26-101` and showed no invented QP name. The only browser error was the missing `/favicon.ico` (404), which this track does not own.
* Desktop, after `npm run build` in the simulation: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed.

## Evidence (re-verification after merge, 2026-10-20)

The W1 gate merged this track (commit `7106164`); W2 (`fedb5f0`) has merged since. No code of this track changed. On a `git archive HEAD`
export (scratch database `lims_r2_master_data`): the three track files 29 of 29; the whole suite 118 files passed, 2 skipped, 1437 tests
passed, 3 skipped, 0 failed; `npm run lint` web clean, server 18 known baseline errors, none new. In the shared working tree,
`master-data.test.ts` cannot start and the drift check in `master-migration.test.ts` fails, because other tracks' uncommitted training,
documents and CoA routes and migrations (0190, 0200) are not yet in the route table or the schema index. That is expected until their
gate patches are applied; it is not a defect of this track.

## For the gate

1. Apply `docs/changes/r2-ui-foundation.gate.patch` first, then `git apply docs/changes/r2-master-data.gate.patch`, then delete both.
   This patch applies with plain `git apply` to the shared tree with or without r2-ui-foundation's patch. The reverse order does not
   work with plain `git apply`: r2-ui-foundation's `routes/index.ts` hunk has `oosRoutes`/`reagentsRoutes` as context, and this patch
   inserts `productsRoutes` between them (`patch -p1` accepts it with fuzz 1). Regenerate `tests/route-table.json` and
   `docs/permission-matrix.csv` after both patches are in (step 2); r2-ui-foundation's patch also carries versions of them.
   It changes:
   * `src/server/routes/index.ts`: register `productsRoutes`, `batchesRoutes`, `customersRoutes`.
   * `src/server/authz/routeTable.ts`: 15 rules, each with the route's strict schema as `body`.
   * `src/lib/permissions.ts`: 3 codes at positions 59 to 61. `master.view` goes to everyone; `master.manage` and `master.status` go to
     QA (and Admin).
   * `src/db/schema/index.ts`: `export * from './master'`.
   * `src/db/protections.ts` and a new `src/db/protections/master.ts`: `sample_context` is append-only through the registry. The
     migration installs the same triggers.
   * `src/server/routes/samples.ts`: `export` on `insertSamples`.
   * `src/server/routes/batches.ts` (mine): the temporary lookup becomes `import { insertSamples } from './samples'`.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: 14 meanings; the products, batches and context rows 0100 derives; and in the rollback
     comparison, the derived rows are compared without their run time (`created_at`). No assertion about kept data was removed.
2. Regenerate the derived files:
   * `npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (needs `JWT_SECRET` in the environment)
   * `npx tsx scripts/authz/export-matrix.ts`
   * `npx tsx src/server/boot/migrate-cli.ts export-schema`
3. Without step 1, these fail in the shared tree, by design:
   * `upgrade-v0.1.0` (catalog and row counts)
   * `protections` and `boot` (trigger count)
   * `schema-drift` (tables not in the schema index)
   * `desktop-schema` (file not regenerated)
   * `authz-matrix` and `authz-migration` (permission rows that are not in the catalog)
4. Migration number: see the first decision.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short:
* migration number 0100, not the 0110-0119 named in the task text: the roadmap (ROADMAP.md, R2) reserves 0100 for master-data and
  0110 for methods, `drizzle/010*` is this track's `ownsFiles` pattern, and r2-methods-calc is building `drizzle/0110_methods_calc.sql`
  in this wave, so 0110 would collide. r2-ui-foundation (task range 0100-0109) ships no migration;
* who may manage master data and who signs its status;
* the batch lifecycle, and Released only after the formal release;
* which batch, product and customer statuses take a registration;
* how backfilled rows are attributed and dated;
* name and number uniqueness rules;
* the new signature meaning;
* customer status audited but not signed;
* free-text registration still possible (those samples get no context).

## Not done

* **Screens** are now reachable through r2-ui-foundation (its `shell/ext/master-data.tsx` and the "Register from product and batch"
  button in `Samples.tsx`) and were exercised in a browser (see the re-verification). The signed status changes (product and batch) were
  exercised through the API tests, not by clicking through the signature dialog in a browser. `MasterData.tsx` and
  `RegisterSampleDialog.tsx` still use their own overlays, not r2-ui-foundation's `Modal`.
* **The demo seed's batches** (`BATCH-2026-001..003`) have no master record, so the traceability screen says "No master batch record" for
  them. That is the seed point below, not a screen defect.
* **Free-text registration** (`POST /samples`, `POST /samples/bulk-import`, file `routes/samples.ts` with no R2 owner) still works, and
  the samples it creates have no `sample_context` row. The migration's zero-orphan guarantee holds at the time of the migration only.
* **The formal batch release does not move the master batch to Released.** `routes/release.ts` has no R2 owner. QA signs the master
  status after the release. Rejected or Recalled master batches do not block the formal release yet: `masterBatchReleaseBlocker` is
  exported from `routes/batches.ts` for the owner of `src/server/release-blockers` to list.
* **The demo seed** (`scripts/dev/seed`) inserts samples after the migrations, so seeded samples have no products, batches or context.
  A seed for master data belongs to the seed owner.
* **No edit of a product's name or code, and no correction of a `sample_context` row.** Both are frozen by design (the text the signed
  hashes cover).
* **CoA, stability and the other dependants** (r2-coa-reports, r2-stability) still have to read product, batch, dates and customer through
  `sample_context`.
* **The validation package** (`validation/`) has no URS, OQ or RTM entries for master data yet. This document and the three test files are
  the material. Nothing was approved or signed.
* **A process incident.** The session scratchpad is shared between the tracks of this wave. My first gate simulation used the folder
  name `scratchpad/sim`, which r2-ui-foundation was also using. I deleted and re-created it once and applied my wiring there before I
  noticed. I then reverted my four wiring edits in that folder, left `scratchpad/NOTE-from-r2-master-data.txt` for that track, and moved
  to `scratchpad/r2-master-data-sim`. No file in the shared tree was affected. r2-ui-foundation should rebuild its simulation and
  regenerate `docs/permission-matrix.csv` there.
