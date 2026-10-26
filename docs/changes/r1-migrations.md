# r1-migrations: versioned migrations, schema split, timestamptz, indexes (roadmap M04)

Release R1, second track. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate. Operating guide for everyone who writes or runs a migration: `docs/migrations.md`.

## What changed

| Area | Files |
|---|---|
| Migrations (forward-only SQL, frozen once applied) | `drizzle/0000_baseline.sql` (exactly the v0.1.0 installer schema, with its structural fingerprint in the header), `0001_timestamptz.sql`, `0002_counters.sql`, `0003_indexes.sql` |
| Runner | `src/server/migrate.ts`: advisory lock, journal `schema_migrations(id, sha256, applied_at, app_version)`, checksum check, downgrade guard, out-of-order guard, legacy adoption by fingerprint, verified pre-migration backup, one transaction, one `SCHEMA_MIGRATED` audit entry |
| Boot | `src/server/boot/`: `index.ts` (`bootDatabase({ migrate })`), `structure.ts` (structural fingerprint), `preMigrationBackup.ts`, `schemaSql.ts`, `version.ts`, `migrate-cli.ts` (status, migrate, structure, export-schema, draft) |
| Installer | `src/server/init-db.ts` now installs or upgrades through the runner (it only created a missing schema before and never touched an existing one) |
| Schema split | `src/db/schema.ts` removed; `src/db/schema/{identity,signatures,audit,samples,oos,specifications,eln,equipment,ops}.ts` + `index.ts`. Import paths (`../db/schema`) are unchanged. Every timestamp is `withTimezone: true`; the index set is declared next to the tables; `counters` is in `ops.ts` |
| Append-only registry | `src/db/protections.ts` (list of sets, `applyProtections(conn)`, `ensureProtections()`, `protectionStatements` kept for `backup.ts`), `src/db/protections/{common,audit,signatures,ops}.ts`. Same ten statements v0.1.0 installed, regrouped by domain |
| Connections | `src/db/index.ts`: every connection opens with `timezone=UTC` |
| Restore support | `desktop/schema.sql` is now generated from the migrations (`export-schema`); `buildSchemaSql(files, upTo)` gives the schema of an older version |
| System info | `src/server/routes/system.ts`: `GET /api/system/info` (not registered yet, see needsFromOtherTracks) |
| CI | `.github/workflows/migrations.yml`, `tests/upgrade/**` (10 files, 54 tests, `dump-diff.sh`) |
| Config | `src/db/drizzle.config.ts` points at the new schema; `out` is a scratch folder |

Files that match other tracks' `ownsFiles` but were created here because the roadmap tells this track to split them: `src/db/schema/<domain>.ts` (except `index.ts`) and `src/db/protections/{audit,signatures,ops}.ts`. They belong to the owning track from now on.

### Migration contents

* **0000_baseline**: drizzle-kit output of `schema.ts` at commit cc95dbb; byte-for-byte the same statements as the old `desktop/schema.sql` apart from comment lines. Header line `baseline-structure-sha256: 978487bd...` is the fingerprint a legacy installation must have (columns in order with type, nullability and default; constraints; indexes).
* **0001_timestamptz**: 15 columns in 11 tables become `timestamptz` (`USING col AT TIME ZONE 'UTC'`, defaults re-set to `now()`); the database default zone is set to UTC when the role may (a WARNING otherwise).
* **0002_counters**: `counters(key, value)`; seeds `sample:<year>` from the highest existing `SMP-<year>-<n>`.
* **0003_indexes**: 14 indexes, each justified in the file by an existing query: `results(sample_id)`, `signatures(sample_id, timestamp)`, `samples(batch|material|state|created_at)`, `oos_investigations(sample_id, status)` and `(result_id)`, `lab_notebook(sample_id, entered_at)`, `batch_materials(batch)`, `training_records(user_id)`, `specifications(material, status)`, `audit_trail(entity, entity_id)` and `(user_id)`. No unique constraint was added, so no behaviour changes.

## Why

Findings addressed (roadmap M04 and `synth.topDefects`):

* "init-db.ts never upgrades an existing schema and there is no migration journal, so any new column cannot reach an installed PC." Now every installation has a journal and an upgrade path.
* "The schema also mixes defaultNow() in the PG session zone with drizzle's UTC reads." Measured on the original code under a Cairo session: a `DEFAULT now()` value came back 3 h in the future, an application-supplied one correctly.
* "Backup timestamp corruption ... shifting signature and entry times by the machine's UTC offset." Measured with the original `createBackup`/`restoreBackup` on the v0.1.0 schema in a Cairo-zone process: signature `13:16:52.196` came back as `10:16:52.196`. With `timestamptz` the backup/restore round trip no longer moves any instant (tested under `TZ=Africa/Cairo`); the remaining parts of that defect (RangeError near 512 MB, text-exact export) stay with r1-backup-jobs.
* "The sample id is COUNT(*)+1 with no lock": the `counters` table that `nextSequence` needs now exists and is seeded.
* No indexes beyond the primary keys.

## Deliberate behaviour changes

1. `src/server/init-db.ts` upgrades an existing database. Without `MIGRATION_BACKUP_PASSPHRASE` (or `BACKUP_PASSPHRASE`), a database that holds data is not touched and the installer exits 1 with the instruction; a new database needs nothing.
2. A database that has tables but is neither journaled nor exactly the v0.1.0 schema (for example one created by `drizzle-kit push`) is refused by the runner. `build.yml` already uses the installer (r1-build-shell), so CI is not affected; developers must create databases with the installer or `migrate-cli migrate`.
3. Every database the installer creates starts with audit entry 1: `SCHEMA_MIGRATED`, entity `SYSTEM_MIGRATION`, actor `migration:<os user>`. The demo seed fills its sample audit rows only into an empty audit trail, so it now skips them.
4. All timestamp columns are `timestamptz`; the application's connections run in UTC.
5. `ensureProtections()` no longer goes through drizzle (`db.execute`) but through the pool; same statements, same result (`tests/backup-restore.sh` still counts 4 `gxp_%` triggers).
6. `desktop/schema.sql` changed meaning: it is the generated current schema (journal table + migrations), not the v0.1.0 schema. `backup-cli restore` keeps working with it.

## How to verify

```
# migration, drift and upgrade tests: 10 files, 54 tests (needs a role that may CREATE DATABASE)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_migrations npx vitest run -c tests/upgrade/vitest.config.ts
# the same under a Cairo environment
TZ=Africa/Cairo PGTZ=Africa/Cairo PGOPTIONS='-c timezone=Africa/Cairo' <same command>
# pg_dump of a fresh install against an upgraded v0.1.0 installation
tests/upgrade/dump-diff.sh
# shared validation evidence on a database made with the shipped installer (node dist-server/init-db.cjs) and seeded
BASE=http://127.0.0.1:3101/api tests/security-controls.sh      # 34 PASS, 0 FAIL, identical to r1-core
BASE=http://127.0.0.1:3101/api tests/backup-restore.sh         # 12 PASS, 0 FAIL
```

Acceptance criteria:

| Criterion | Evidence |
|---|---|
| v0.1.0 fixture upgrades with a valid audit chain, verifying signatures, a pre-migrate backup and a SCHEMA_MIGRATED row | `upgrade-v0.1.0.test.ts`: all rows of all 18 tables read back identical (timestamps compared as the same UTC wall clock); chain of 31 rows verifies; `/signatures/verify` is `valid` for all 5 signatures (2 with a recomputed content hash); `/audit/verify` valid; the backup verifies and restores to a v0.1.0 schema with identical data to the microsecond, then migrates again; one `SCHEMA_MIGRATED` row; a second run changes nothing |
| Under PGTZ=Africa/Cairo DB-default and app-supplied timestamps read back identically | `timezone.test.ts` (fails on the old code, see below); `timezone-pool.test.ts` (application connections are UTC even with `PGOPTIONS` Cairo; backup then restore in a Cairo process moves no instant); whole suite passes with `TZ`, `PGTZ`, `PGOPTIONS` all Cairo |
| CI fails when schema.ts changes without a migration; an edited applied migration is refused by checksum | `schema-drift.test.ts` (extra column, missing column, new table, missing index and a naive timestamp are each detected by drizzle-kit's differ against a database built only from the migrations); `runner.test.ts` (edit refused, CRLF/BOM checkout accepted); `desktop-schema.test.ts` (generated file up to date); `migrations.yml` runs them |

## Evidence recorded while building this track

* **Test first.** `timezone.test.ts` and `upgrade-v0.1.0.test.ts` were written against the untouched code and failed: the first with `createdAt (DEFAULT now()): expected 1791908328451 to be less than or equal to 1791897558456` (3 h ahead; Cairo is UTC+3 in October); the second with `expected false to be true` on `schema_migrations` (old `init-db` printed "Schema already present" and left the v0.1.0 schema in place). Both pass now. The remaining tests exercise the new runner, which did not exist, so they could only fail by absence.
* **The fixture is genuine v0.1.0 output.** `git archive HEAD` (cc95dbb) was run in a scratch copy: original `desktop/schema.sql`, original demo seed, then the original server on port 3101 executed a failed e-signature, approve with two signatures, an out-of-specification value, notebook entry and ELN signature, instrument, reagent and environmental records, settings change, batch release and an encrypted backup. `pg_dump --data-only --column-inserts` of that database is `tests/upgrade/fixtures/v0.1.0.data.sql` (111 rows in 15 tables; 30 audit rows with a valid chain; 5 signatures: two sample transitions with a recomputable hash, an ELN, a batch release and a notebook observation with the `N/A` hash the old code wrote).
* **Mutation check.** Replacing `AT TIME ZONE 'UTC'` by `'Africa/Cairo'` in a copy of 0001 makes `keeps every record` fail on `batch_materials` and `audit_trail`; the unmodified file passes. The first version of that test skipped `audit_trail`; the mutation exposed it and it was corrected.
* **Production bundle.** `node scripts/build-server.cjs` builds; the bundled `init-db.cjs` upgrades the fixture (refuses without a passphrase, upgrades with one) and records `app_version` 0.1.0 from the bundle.
* **Least privilege.** An unprivileged role without `ALTER DATABASE` completes the upgrade with a printed warning.
* **Whole suite.** `npx vitest run` (root config): 137 pass, 3 fail; the 3 failures belong to r1-build-shell's in-flight work (`/api/health` and `/api/ready` are not yet in `tests/route-table.json`, two route-table tests; one repo-hygiene documentation test). All r1-core database tests pass on the migrated template. `npm run lint`: my files are clean under both tsconfigs; the only message at the end of the run is a new error in `src/server/http/security.ts` (build-shell).

## Decisions that need confirmation

See the structured report (`decisionsForUser`). In short: the backup passphrase policy (no passphrase, no upgrade of a database with data), one transaction for the whole run instead of one per file, audit naming and writing the entry on fresh installs, the UTC reading of legacy naive timestamps, strict forward-only numbering, exact-match adoption of legacy databases, best-effort `ALTER DATABASE ... SET timezone`, the 14 indexes, no trigger on the journal, `sample:<year>` counter keys, and who may read the journal.

## Needs from other tracks (for the wave gate)

| File (owner) | Change |
|---|---|
| `server.ts` (r1-core) | **Done at wave gate W1** with `await bootDatabase({ migrate: false })` in place of `ensureProtections()`: the server only checks (refuses a database that is behind, newer or different) and never changes a validated database by starting. `{ migrate: true }` (auto-migrate at start after the verified backup) stays an open decision; it needs the `desktop/main.cjs` row below to be useful on the desktop |
| `package.json` `build.files` (r1-build-shell) | **Done at wave gate W1** (`"drizzle/**"`; the installer reads the SQL files at run time, `asar` is off; pinned by `tests/upgrade/desktop-schema.test.ts`) |
| `desktop/main.cjs` (r1-build-shell) | Run `dist-server/init-db.cjs` before **every** server start, not only in `config:save` (an upgraded installation never reaches the setup window), with `MIGRATION_BACKUP_PASSPHRASE` and `BACKUP_DIR` in its environment (the passphrase store is M14); start both processes with `cwd` = the application folder or set `MIGRATIONS_DIR` |
| `src/server/config.ts`, `.env.example` (r1-build-shell) | Document `MIGRATIONS_DIR`, `MIGRATION_BACKUP_PASSPHRASE` (secret), `APP_VERSION`; `README.md` still says `drizzle-kit push` |
| `src/server/routes/index.ts`, `tests/route-table.json` (r1-core) | **Done at wave gate W1**: `systemRoutes` registered, `GET /api/system/info` (auth required) in the table; `tests/upgrade/server-start.test.ts` calls it on a real server process |
| `vitest.config.ts` (r1-core) | **Done at wave gate W1**: `'tests/upgrade/**/*.test.ts'` is in `include` (timeouts raised to 60 s / 120 s for them), so `npm test` and `tests.yml` run them; `migrations.yml` still runs them alone with `tests/upgrade/vitest.config.ts` |
| `src/db/utils.ts` / `src/db/schema/audit.ts` (r1-audit) | Columns added to `audit_trail` must be nullable or have a default, because `appendAudit` in `migrate.ts` inserts the v1 column list; or point `appendAudit` at your writer. `protections/audit.ts` is yours now |
| `src/db/schema/signatures.ts`, `protections/signatures.ts` (r1-esign) | Yours now. A backfill of `signatures` must disable the guard trigger inside its own migration file (the runner re-creates every guard before COMMIT); the file needs QA review |
| `src/server/backup.ts`, `src/db/schema/ops.ts`, `protections/ops.ts` (r1-backup-jobs) | Restore: build the empty target with `buildSchemaSql(loadMigrations(), manifestSchemaVersion)` and run `migrate` afterwards; keep `createBackup(pool, passphrase, dir)` returning `{file, sha256, verified}` or adapt `boot/preMigrationBackup.ts`; add `...appendOnlyTable('backup_runs')` to `protections/ops.ts` with your migration (the OQ trigger count of 4 changes then) |
| `src/server/routes/samples.ts` (r1-results-oos) | Sample numbers: `nextSequence(tx, 'sample:' + year)`; migration 0002 seeded those keys from existing ids. Tests that count `audit_trail` rows must filter by entity (entry 1 is the installer's) |
| Seeds (r1-build-shell) | The demo seed fills audit rows only into an empty audit trail, so it now skips them; continue the chain from the head if the demo needs them |

## Not done

* ~~Nothing calls `bootDatabase` at server start~~ and ~~`GET /api/system/info` is not registered~~: both wired at wave gate W1 (see the table above; `tests/upgrade/server-start.test.ts`). The server checks only (`migrate: false`); whether it should auto-migrate (`migrate: true`) is still the open decision under "Decisions for you".
* The desktop shell still runs the installer only at first setup, does not package `drizzle/`, and does not give the installer a backup passphrase (r1-build-shell's `main.cjs` and `package.json`; the passphrase store is r1-backup-jobs' M14). Until then a v0.1.0 PC cannot upgrade without a person supplying `MIGRATION_BACKUP_PASSPHRASE`.
* The first-administrator row created by `init-db` still writes no audit entry (pre-existing; r1-identity's bootstrap rule, M05).
* The journal table is not trigger-protected: `tests/backup-restore.sh` asserts exactly four `gxp_%` triggers and I did not change that assertion. Tampering with the journal is detectable because every `SCHEMA_MIGRATED` entry carries the same checksums.
* Old (pre-journal) backups restored with the default `desktop/schema.sql` get the newest structure and an empty journal; the operator must use `export-schema <file> 0000_baseline` (documented). Teaching `backup-cli restore` to do this from the backup's manifest belongs to r1-backup-jobs (M14, "schema version in the manifest").
* The `RangeError` of `createBackup` near 512 MB and text-exact export of every table remain in `backup.ts` (r1-backup-jobs); the pre-migration backup reads timestamps as text through its own pool, so the migration backup is exact for timestamps.
* No data migration of legacy values written by `DEFAULT now()` under a non-UTC PostgreSQL zone (none exist in production according to the roadmap).
* The validation package (URS/OQ/RTM under `validation/`) has no entries yet for the new controls (journal and checksums, downgrade guard, pre-migration backup, `SCHEMA_MIGRATED` entry); `docs/migrations.md` and `tests/upgrade/**` are the material for them.

## Wave gate W1 (integration)

* **Defect found by the gate and fixed:** the pre-migration backup (`boot/preMigrationBackup.ts`) copied the pool's options with a spread, and pg-pool keeps `password` as a non-enumerable property, so the copy had none: against any password-authenticated PostgreSQL the backup failed with `SASL: client password must be a string` and a v0.1.0 database could not be upgraded. The track's tests passed only because `PGPASSWORD` was set in the engineer's shell, which node-postgres falls back to. Fixed (the password is copied explicitly), and `tests/upgrade/helpers.ts` no longer passes `PG*` connection variables to the child processes it spawns, so this cannot be masked again.
* Wired: server start check, `/api/system/info`, `drizzle/**` in the installer, upgrade tests in `npm test`, `dist-server/` in `.gitignore`.
* Still open: `desktop/main.cjs` runs the installer only at first setup and passes no backup passphrase (M14), so an installed v0.1.0 PC that receives this build is refused at start (readable message, nothing changed) until someone runs the installer with `MIGRATION_BACKUP_PASSPHRASE`.
