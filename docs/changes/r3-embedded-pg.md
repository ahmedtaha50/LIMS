# r3-embedded-pg: built-in PostgreSQL with least-privilege roles (roadmap M40, PLT-04)

Status: **partial**. Everything that can run on Linux is built and tested against real PostgreSQL 16 and the real Electron shell. The Windows
parts (bundled binaries, icacls, DPAPI, NSIS) are written but have **not been run on Windows**, and the bundle is not pinned yet.

## What changed

* `desktop/pg-supervisor.cjs` (new, no Electron API): `provision` (initdb: `lims_owner` superuser, scram-sha-256 on every rule, data checksums,
  UTF-8, `--no-locale`, loopback only, UTC, `idle_in_transaction_session_timeout=60s`, data folder restricted to the user), `superviseEmbedded`
  (starts postgres as its own child, polls `pg_isready`, restarts after a crash with back-off 0.5 s to 5 s, gives up after 8 crashes in 2 minutes, stops
  a postgres left by a crashed application, graceful stop through `pg_ctl stop -m fast`), `bootstrapDatabase`, `finalizeAppRole` (statement timeout 120 s,
  connection limit 40 on `lims_app`), `checkDisk`, `findBinDir`, `verifyBinaries` (SHA-256 of the bundled executables against `PG_BINARIES.json`).
  Passwords go through a 0600 file (initdb) or the child's environment (psql), never a command line.
* `desktop/main.cjs`: config `mode: 'embedded' | 'external'` (a config without `mode` is external, so v0.1.0/v0.2.0 installations are unchanged). Embedded:
  random 32-character owner and app passwords stored with safeStorage, a saved loopback port (20000-29999, replaced and saved if another program has taken it),
  data in `<userData>/pgdata`. First run: disk guard (2 GB), initdb, start, create database, `init-db` as `lims_owner` with `LIMS_APP_ROLE=required` and the
  generated `LIMS_APP_DB_PASSWORD` (the existing r2-audit-tamper role step), role limits, then the server starts with `SQL_APP_USER=lims_app`. Every later start
  starts postgres first (warning below 512 MB free). Quit order: server, then postgres, then exit (`before-quit` is deferred until both stopped). Events
  `DATABASE_PG_EXIT / _RESTART / _READY / _GIVE_UP / _ORPHAN_STOPPED` go to `release-events.jsonl`; postgres output to `logs/postgres.log`. A packaged build verifies the
  bundled binaries before starting them (`SYSTEM_INTEGRITY_FAIL` on mismatch). Dev/CI-only (never honoured when packaged): `LIMS_PG_BIN`, `LIMS_PG_RUN_AS=uid:gid`, `LIMS_PG_MIN_FREE_MB`.
* `desktop/setup.html` + `preload.cjs` (unchanged API): "Built-in database (recommended)" is the default and asks for no database input; "Connect to an existing PostgreSQL"
  shows the old fields. CSP hashes recomputed (`repo-hygiene` test passes).
* `src/db/index.ts`: `SQL_PORT`; `SQL_APP_USER`/`SQL_APP_PASSWORD` give the request path (`db`) its own pool as `lims_app`; `createPool()` stays the owner pool and `db.$client`
  is pinned to it, because `backupService` takes its pool from there and a restore needs owner rights. `SQL_STATEMENT_TIMEOUT_MS` (optional), `idleTimeoutMillis`.
  Without `SQL_APP_USER` nothing changes.
* `desktop/pg-fetch.cjs` + `desktop/pg-bundle.json` + `package.json` (`extraResources build/pgsql -> pgsql`, `npm run fetch:pg`, `npm run test:desktop-embedded`): build-time download of
  the pinned Windows zip, keeps bin/lib/share, writes `PG_BINARIES.json`. Refuses to run while `sha256` is null.

## How to verify (Linux)

```
npm run build
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims
npm run test:installer                       # includes tests/installer/pg-supervisor.test.cjs (12 tests, real PostgreSQL 16 binaries)
npx vitest run tests/upgrade/app-pool.test.ts
xvfb-run -a node tests/desktop-embedded.cjs  # 24 checks: first run with no DB input, roles, kill -9 recovery, quit leaves no postgres, restart, backup
xvfb-run -a node tests/desktop-shell.cjs ; xvfb-run -a node tests/desktop-upgrade.cjs ; xvfb-run -a node tests/installer/desktop-integrity.cjs
```
Test-first: the supervisor tests failed on the missing module, `app-pool.test.ts` failed on the old `src/db/index.ts` (one identity, no port), `desktop-embedded.cjs` needs the new setup page.

## Honest limits

* **Not run on Windows**: postgres.exe from the EDB zip, `pg_ctl stop` there, `icacls`, DPAPI via safeStorage, NSIS packaging with the extra resource. Acceptance 1 (clean Windows 11 VM) is therefore **unmet/untested**; acceptance 2 and 3 are shown on Linux with the same code.
* `pg-bundle.json` has `sha256: null` and an unverified URL/version; `npm run fetch:pg` refuses until someone pins it. `pg-fetch.cjs` was not executed against a real archive (no network to the vendor here).
* electron-builder was run on Linux (`--linux dir`): a missing `build/pgsql` is skipped with a warning, so a build without the fetch step silently ships no database (the app then says so and offers the external mode). The gate patch adds the fetch step to the two Windows workflows.
* Uninstall: the NSIS default does not touch `%APPDATA%`, so `pgdata` is kept; no custom uninstall page was added ("opt in to delete" is not implemented).
* `tests/backup-restore.sh` / `security-controls.sh` need a seeded database and a running server and were not run; the backup path was instead exercised through the embedded run (backup verified with requests as `lims_app`). Whole-project `lint:server` currently fails only in other tracks' files (`src/server/schedules/periodic.ts`).
* The server process still holds the owner password (lazy owner pool for backup/restore). Moving backup/restore into a separate helper would remove it; not done.
* The binaries manifest (`PG_BINARIES.json`) lives outside `resources/app`, so `scripts/release/manifest-lib.cjs` does not cover it; recording its hash in the release manifest/IQ is a follow-up for the release track.

## Decisions for the user

See the report (`decisionsForUser`): data folder location, `--no-locale` (C collation), licence and size, Windows install account, port range, timeouts, 2 GB disk threshold, owner = superuser of the private cluster, uninstall behaviour.
