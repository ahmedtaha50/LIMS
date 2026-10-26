# B-Pharma LIMS

A GxP laboratory information management system (QC): samples, results, OOS investigations, specifications, instruments,
reagents, electronic notebook, audit trail and electronic signatures (21 CFR Part 11 / EU Annex 11 / ALCOA+).
Project rules: [AGENTS.md](AGENTS.md). Roadmap: [docs/roadmap/ROADMAP.md](docs/roadmap/ROADMAP.md). Change records: [docs/changes/](docs/changes/).

**Stack:** React 19 + Vite + Tailwind (client), Express 4 + Drizzle ORM + PostgreSQL 16 (server), Electron shell for the single-PC install.

## Local run

Prerequisites: Node.js 22, PostgreSQL 16 and a role that may create a database.

```bash
npm ci
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims
ADMIN_EMAIL=admin@example.com ADMIN_NAME="First Admin" ADMIN_PASSWORD='at-least-12-characters' \
  npx tsx src/server/init-db.ts          # schema, audit/signature protections, first administrator
npm run dev                              # http://127.0.0.1:3000, Vite middleware, random JWT secret per run
```

The schema is created and upgraded by the forward-only migrations in `drizzle/` (runner: `src/server/migrate.ts`; rules and authoring: [docs/migrations.md](docs/migrations.md)).
`init-db` installs a new database or upgrades an existing one, and a database that already holds data is migrated only after a verified backup:
set `MIGRATION_BACKUP_PASSPHRASE` (12+ characters; `BACKUP_DIR` chooses the folder), otherwise it refuses. The server only checks at start: it
refuses a database that is behind, ahead of, or different from its own migrations and tells you to run `init-db` or
`npx tsx src/server/boot/migrate-cli.ts migrate`. `MIGRATIONS_DIR` points at the folder when it is not `./drizzle`. `GET /api/system/info` reports the versions.

Optional demo data (users admin/qa/reviewer/analyst1/analyst2@gxp.com, password `password`; refuses to run with `NODE_ENV=production`).
The seed expects an empty `users` table, so start from a database that has only the schema:

```bash
PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER $SQL_DB_NAME -c 'delete from users'   # removes the first administrator created above
npm run seed
```

`npm run dev` is the only mode that serves the Vite dev server, and only because it sets `NODE_ENV=development`.
Everything else (the `start` script, the bundle, the desktop app) is production: `JWT_SECRET` (random, 32+ characters) and the four `SQL_*`
variables are required, the server listens on 127.0.0.1 only, and a malformed variable stops it with one readable message.
Every variable is documented in [.env.example](.env.example) and validated in `src/server/config.ts`.

## Build and run the production bundle

```bash
npm run build        # frontend -> dist/ (served to browsers), server bundles -> dist-server/ (never served)
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") npm start
```

`dist-server/` holds `server.cjs`, `init-db.cjs`, `backup-cli.cjs` and `supervisor.cjs` with source maps (for readable stack traces; not reachable over HTTP).
`GET /api/health` (process is up) and `GET /api/ready` (database answers, schema installed) need no login.

## Checks

```bash
npm run lint         # tsc for the client, then the server project with strictNullChecks against a baseline of known errors
npm test             # Vitest against a real PostgreSQL (see docs/changes/r1-core.md)
npm run check:root   # the repository root holds configuration only (no patch/fix scripts, one lockfile)
tests/security-controls.sh   # black-box checks against a running, seeded server
tests/backup-restore.sh      # backup, verify, restore (needs dist-server/backup-cli.cjs)
```

## Desktop (Windows installer)

`npm run desktop` builds and starts the Electron shell; `npm run dist:win` builds the installer (CI builds it on `windows-latest`).
The shell runs the server as a supervised child process on 127.0.0.1 with a fixed port, keeps its log under the user-data folder (`logs/server.log`, rotated),
and stores the database password and JWT secret encrypted with the operating system's credential store.

GxP audit findings and their status: `docs/gxp-audit-findings.csv`.
