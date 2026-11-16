# r1-core: project skeleton, migrations, route registry, test harness (E01)

Built test-first on PostgreSQL 16; no mock of the database anywhere.

## What exists now
- `server/core/`: configuration validated at start-up (a wrong value names its variable); one pool per process whose `error`
  event is handled; `withTx` (one transaction, COMMIT or ROLLBACK); errors leave as JSON with a code and a request id, an
  unexpected error is logged with the id and shown without internals; strict input schemas; the `RouteDef` type, in which
  `permission` is required.
- `server/migrate/`: forward-only SQL migrations `NNNN_name.sql`, each in its own transaction with its ledger row
  (`schema_migrations`, with the SHA-256 of the file). Start-up refuses an applied migration that was edited or deleted.
  An advisory lock makes it safe for several instances to start at once (unlimited users means more than one instance).
- `server/routes/`: the registry is the directory. Each file exports `routes`; a route without a permission, outside `/api/`,
  or defined twice stops the server at load. `tests/route-table.json` is the reviewed list of every route.
- `server/app.ts`: fails closed. Until r1-identity installs an authorizer, every route that is not public answers 401.
- `migrations/0000_jobs.sql`: the background-work table (taken with `FOR UPDATE SKIP LOCKED`, so instances share it).
- `tests/helpers/`: a fresh database per test file or test; the run fails at once, with the reason, when PostgreSQL is not
  reachable (never skips).
- `../.github/workflows/ebr.yml`: lint, tests on a PostgreSQL 16 service, build, and a start of the built server. Path-filtered
  to `ebr/**`. Outside this folder, so it is named here.

## Evidence (this machine)
- `npm run lint`: clean (strict TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- `npm test`: 19 passed, 0 failed, 3 files, on PostgreSQL 16.15.
- With the database stopped: the run fails with exit 1 and "PostgreSQL is not reachable ... The tests do not skip".
- `npm run build`, then the built server on an empty database: `migrations applied: 0000_jobs`, `/api/health` answers
  `{"status":"ok", ..., "migrations":1}`.

## Not done here
- The CI workflow has not run yet: it runs on the push of this change.
- `client/`, `index.html` and the client dependencies belong to r1-shell (wave 2); `vite.config.ts` only names the paths.

## For the tracks of wave 2
- A route file exports `routes = [route({...})]`; give every route a permission name. r1-identity installs the authorizer
  through `createApp({ authorize })` (a gate patch to `server/main.ts`, which r1-core owns).
- A deliberate change of the route table: `npm run test:routes:update`, and say so in the change record.
