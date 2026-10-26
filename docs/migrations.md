# Database migrations

How the schema of B-Pharma LIMS is created, changed and upgraded (roadmap M04). Annex 11 s.10 (change control) and 21 CFR Part 11.10(e) apply: the migration journal, the audit entry and the pre-migration backup together are the record of every schema change.

## The rules

1. **Migrations are numbered SQL files in `drizzle/`**, named `NNNN_lowercase_name.sql`. They are applied in file-name order, once, forward only. There is no "down".
2. **An applied migration is immutable.** Its SHA-256 (line ends normalised to LF, BOM removed) is stored in `schema_migrations`; if the file changes, the runner refuses to start (`CHECKSUM_MISMATCH`). Fix a mistake with a new migration.
3. **Numbers are reserved per track.** `0000-0009` this track (migrations), `0010` identity, `0020` esign, `0030` audit, `0040` authz, `0050` results-oos, `0060` spec, `0070` quality-fixes, `0080` backup-jobs; a track uses its own ten (`0010`..`0019`), and later releases continue above the highest number ever released. Two files with the same number are rejected (`BAD_MIGRATIONS`), and a new file numbered *below* one that is already applied is rejected (`OUT_OF_ORDER`), because the order of a forward-only history must be the order it was applied in.
4. **`src/db/schema/*.ts` and the migrations must agree.** `tests/upgrade/schema-drift.test.ts` builds a database only from `drizzle/*.sql` and asks drizzle-kit's differ what it would change to reach the schema. A schema edit without a migration (or the reverse) fails CI.
5. **Timestamps are `timestamptz`**, declared `timestamp('x', { withTimezone: true })`. The drift test fails on any `timestamp without time zone`.
6. **Never rewrite append-only rows.** `audit_trail` and `signatures` are guarded by triggers; a migration may add columns (nullable, or with a default) and tables, not UPDATE or DELETE their rows. A migration that must backfill a guarded table disables that table's guard trigger inside its own file; the runner re-creates every guard (`DROP TRIGGER IF EXISTS` + `CREATE`) before it commits, whatever the file did. Such a file needs QA review: its checksum is in the journal and in the audit entry.
7. **Sample numbers** come from `counters` (`nextSequence(tx, 'sample:<year>')`). Migration `0002` starts each year's counter at the highest `SMP-<year>-<n>` already in the database.

## Writing a migration

1. Change the table in `src/db/schema/<domain>.ts` (the file of the track that owns the domain).
2. Write `drizzle/NNNN_name.sql` by hand. To see what is missing: build a database from the current migrations and run

   ```
   SQL_HOST=... SQL_USER=... SQL_PASSWORD=... SQL_DB_NAME=scratch npx tsx src/server/boot/migrate-cli.ts migrate
   npx tsx src/server/boot/migrate-cli.ts draft        # prints the SQL that turns the database into src/db/schema
   ```

   Use it as a draft, not as the migration: add the index for every foreign key you add (PostgreSQL does not), keep data changes explicit, and put the reason for the change in a header comment.
3. If the table must be append-only, add `...appendOnlyTable('<table>')` to `src/db/protections/<domain>.ts` (see "Append-only registry").
4. Regenerate `desktop/schema.sql`: `npx tsx src/server/boot/migrate-cli.ts export-schema`.
5. `npx vitest run -c tests/upgrade/vitest.config.ts` and `tests/upgrade/dump-diff.sh`.

Do not run `drizzle-kit generate` or `drizzle-kit migrate` on `drizzle/`; the runner keeps its own journal. `src/db/drizzle.config.ts` points `out` at a scratch folder for that reason.

## What a run does (`src/server/migrate.ts`)

One run, in this order. Everything from step 5 on happens in **one transaction**: the upgrade is complete, with its audit entry, or it did not happen.

1. Take a session advisory lock (key 7002; waits up to 120 s), so two processes starting together cannot both migrate.
2. Classify the database against the files:
   * **new** (no tables): install everything;
   * **journaled**: every applied file must exist with the same checksum; an applied id this build does not contain means a newer build migrated it, and this build refuses (`SCHEMA_NEWER`, the downgrade guard); a pending file below an applied one is `OUT_OF_ORDER`;
   * **tables but no journal**: accepted only if the structural fingerprint equals the one in the header of `0000_baseline.sql` (the exact v0.1.0 installer schema: columns in order, types, nullability, defaults, constraints, indexes); then the journal starts at `0000` without executing it. Anything else (`LEGACY_MISMATCH`: hand-edited, created by `drizzle-kit push`, extra tables) is left untouched, with the fingerprint and a table summary in the message. `migrate-cli structure` prints the full description.
3. If the database already holds data: a **verified backup** is made first (`src/server/boot/preMigrationBackup.ts` calls `createBackup`, which re-reads and verifies the file). No passphrase configured, a failed backup or one that does not verify stops the run with nothing changed (`BACKUP_REQUIRED` / `BACKUP_FAILED`).
4. `BEGIN`, `lock_timeout` 30 s (a session that still holds locks on the tables, such as a running server, makes the run fail instead of hang).
5. Create `schema_migrations(id, sha256, applied_at, app_version)` if absent; journal the adopted baseline; execute each pending file and journal it. A failing file reports its name and, where PostgreSQL gives a position, its line; everything rolls back (`MIGRATION_FAILED`).
6. Install the append-only triggers (`afterSchema`).
7. Append one audit entry: action `SCHEMA_MIGRATED`, entity `SYSTEM_MIGRATION`, entity id = newest migration, field `schema_version`, old value = previous newest id, new value = JSON `{version, appVersion, baselineAdopted, fresh, applied: [{id, sha256}], backup: {file, sha256}}`, actor `migration:<operating-system user>`. It uses the same advisory lock (7001) and the same hash input as `writeAudit` (`src/db/utils.ts`), so rows from both writers verify under one chain check.
8. `COMMIT`.

`verifySchema` is the read-only variant for a normal server start: it throws unless the database is exactly at this build's newest migration (`SCHEMA_BEHIND`, `SCHEMA_NEWER`, `CHECKSUM_MISMATCH`, ...).

### What `0001_timestamptz` does to existing values

A naive `timestamp` becomes `timestamptz` by reading it as UTC, which is how the application always displayed it, so every value shows the same instant before and after (tested row by row on the v0.1.0 fixture). Values that v0.1.0 wrote through `DEFAULT now()` on a PostgreSQL whose zone was not UTC keep the offset they always had; `audit_trail.timestamp_str`, the value the hash chain covers, is untouched. The database default zone is set to UTC when the role may do so (otherwise a warning is printed and the upgrade continues); the application opens every connection with `timezone=UTC` regardless (`src/db/index.ts`).

## Running it

| Who | Command |
|---|---|
| Installer / IT (installs or upgrades, creates the first administrator) | `node dist-server/init-db.cjs` (env: `SQL_*`, `ADMIN_*`, and for an existing database `MIGRATION_BACKUP_PASSPHRASE`, `BACKUP_DIR`) |
| Developer / CI | `npx tsx src/server/boot/migrate-cli.ts status \| migrate \| structure \| export-schema [file] [upTo] \| draft` |
| Server start | `server.ts` calls `await bootDatabase({ migrate: false })` from `src/server/boot` (wave gate W1): it only checks, refuses a database that is behind, newer or different, and re-installs the append-only triggers. The installer (`init-db`) or `migrate-cli migrate` migrates. `{ migrate: true }` (auto-migrate at start, after the verified backup) is available but not used: see the open decision in `docs/changes/r1-migrations.md` |

Environment: `MIGRATIONS_DIR` (default `./drizzle` relative to the working directory; the desktop shell must ship `drizzle/` and start the process in the application folder), `MIGRATION_BACKUP_PASSPHRASE` (>= 12 characters; falls back to `BACKUP_PASSPHRASE`), `BACKUP_DIR` (default `./backups`), `APP_VERSION` (default: the version baked into the bundle, else `package.json`).

### Development databases

Create an empty database and run `migrate-cli.ts migrate`, then the seed (`scripts/dev/seed/index.ts`). A database created by `drizzle-kit push` or by an older checkout has no journal and is refused unless it is exactly the v0.1.0 schema (then set `MIGRATION_BACKUP_PASSPHRASE` and it is upgraded like an installed PC); otherwise drop and recreate it. Every database the installer creates starts with audit entry 1 = `SCHEMA_MIGRATED`, so the demo seed (which only seeds its sample audit rows into an empty audit trail) skips them, and tests should filter `audit_trail` by entity instead of counting rows.

### Upgrading an installed PC

1. Close the application. 2. Install the new version. 3. Start it: the installer step runs with the backup passphrase, makes `bplims-<time>.bak` in the backups folder (verified), migrates, and writes the `SCHEMA_MIGRATED` entry. 4. `GET /api/system/info` (Admin/QA) shows the schema version and the journal with checksums.

### Rolling back

There is no down-migration. Restore the pre-migration backup into an **empty** database with the schema of its version, then start the old build, or upgrade again:

```
npx tsx src/server/boot/migrate-cli.ts export-schema /tmp/v010.sql 0000_baseline
RESTORE_DB_NAME=<new empty db> SCHEMA_FILE=/tmp/v010.sql BACKUP_FILE=<file>.bak BACKUP_PASSPHRASE=... node dist-server/backup-cli.cjs restore
```

(`tests/upgrade/upgrade-v0.1.0.test.ts` performs exactly this and migrates again.) `buildSchemaSql(files, upTo)` in `src/server/boot/schemaSql.ts` is the function behind it; `desktop/schema.sql` is its output for the newest version and is what `backup-cli restore` uses by default.

## Append-only registry

`src/db/protections.ts` lists `ProtectionSet`s; each domain keeps its statements in `src/db/protections/<domain>.ts` (`common` = the shared refusal function, `audit`, `signatures`, `ops`). `appendOnlyTable('t')` makes triggers `gxp_t_row_guard` (UPDATE/DELETE) and `gxp_t_truncate_guard` (TRUNCATE); `tests/backup-restore.sh` counts triggers named `gxp_%`, so a new append-only table changes that number deliberately. `applyProtections(conn)` runs inside the migration transaction and again at every start (`ensureProtections()`).

## Contracts other tracks rely on

* **Audit rows written by the runner** use the v1 column list (`id, sequence, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash, timestamp_str`). Columns that r1-audit adds to `audit_trail` must be nullable or have a default, or `appendAudit` in `migrate.ts` must be switched to their writer.
* **`src/server/backup.ts`** is called from `src/server/boot/preMigrationBackup.ts` only (`createBackup(pool, passphrase, dir)` returning `{file, sha256, verified}`). The adapter reads through a pool that returns timestamps as stored text in a UTC session, so the backup of a naive v0.1.0 database restores to the microsecond.
* **`counters`**: key `sample:<year>`; `nextSequence(tx, key)` in `src/server/core/tx.ts`.

## Tests

`npx vitest run -c tests/upgrade/vitest.config.ts` (needs PostgreSQL and a role that may `CREATE DATABASE`; `SQL_DB_NAME` is only a name prefix) and `tests/upgrade/dump-diff.sh` (pg_dump of a fresh install against an upgraded v0.1.0 installation). `.github/workflows/migrations.yml` runs both and checks that `desktop/schema.sql` is up to date. Fixture: `tests/upgrade/fixtures/v0.1.0.*.sql` is the schema, the triggers and the data of a real v0.1.0 installation, written by the original v0.1.0 server code (see the header of `v0.1.0.data.sql`).
