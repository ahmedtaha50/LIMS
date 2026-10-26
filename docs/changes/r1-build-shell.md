# r1-build-shell: repository hygiene, typed config, shell and HTTP hardening (roadmap M02, M03)

Release R1, second wave (after r1-core). Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.
Change record for QA: `docs/change-control.md` (approval block intentionally blank).

Status: **all acceptance criteria of M02 and M03 are met; three design items are not delivered** because they sit in files this track does not own (listed under "Not done" and "Needs from other tracks").

## What changed

### M02 repository hygiene

| Item | Result |
|---|---|
| Root scripts | 143 `patch-*`, `fix-*`, `update-*`, `add-*` and other one-shot `.cjs`/`.js` files removed, plus `clear-audit.ts` (deletes the audit table), `check-db.ts`, `fix-db.ts`, `bun.lock`, `firebase-applet-config.json`, `src/lib/firebase.ts`, `src/lib/firebase-admin.ts`, `src/lib/queue/rabbitmq.ts` (unused copy of `src/server/rabbitmq.ts`). Everything is recoverable from tag `pre-r1` (commit `cc95dbb`); the files were verified byte-identical to it before removal. |
| Root check | `scripts/check-root-clean.sh` (also `npm run check:root`, and a step in `build.yml`): fails on a root `.cjs/.js/.mjs`, a root `.ts` other than `server.ts`, `vite.config.ts`, `vitest.config.ts`, or a second lockfile. Files already deleted from disk but still in the index are ignored, so it works before the commit. |
| Dependencies | `firebase`, `firebase-admin` removed (lockfile pruned; `npm ci --dry-run` is in sync). Added, exact-pinned: `pino` 10.4.0, `@fontsource/outfit` 5.3.0, `@fontsource/plus-jakarta-sans` 5.3.0. `xlsx` stays, see "Not done". |
| Typed config | `src/server/config.ts`: Zod schema over the environment, `loadConfig(env)` (pure), `getConfig()` (memoised), `describeConfig()` (secrets redacted), `formatConfigError()` (one readable message, no stack, no secret values). `.env.example` documents exactly the variables it reads (a test enforces both directions). |
| tsconfig | `tsconfig.json` is now the shared base with an explicit `include` (it used to type-parse 143 root scripts, `dist/` and `release/`: 47 s, now 4 s for the client). `tsconfig.web.json` (client), `tsconfig.server.json` (server, tests and `scripts/dev`, with `strictNullChecks`). `npm run lint` = `lint:web` + `lint:server`. |
| Baseline | `scripts/typecheck-server.cjs` compares the server project with `scripts/dev/typecheck/baseline.json` (21 entries, 34 known errors in other tracks' files). Entries are keyed by file, error code and message with object types collapsed, never by line, and carry a count, so a second identical error is still new. Only new errors fail; `--update` rewrites the file. Two baseline entries are real bugs the new check found: `routes/dashboard.ts` `r.expirationDate` (column is `expiryDate`) and `routes/reports.ts` `r.isOOS` (column is `isOos`). |
| Fonts | `index.html` imports the Latin subsets of Outfit and Plus Jakarta Sans from `@fontsource` (an inline module, which Vite turns into the entry chunk; the built `index.html` has no inline script). No request leaves the PC. |
| Seed | `src/server/seed_pg.ts` (645 lines) became `scripts/dev/seed/index.ts` plus `seeds/{identity,specifications,equipment,environmental,batches,samples,audit,eln,release,training,oos}.ts`, cut mechanically at the existing section markers. Old and new seed were run into two empty databases and compared table by table: identical except run-time timestamps. New: refuses to run with `NODE_ENV=production`, and a failure sets exit code 1 (the old script printed the error and exited 0). `npm run seed`. |
| Docs | `AGENTS.md`: the two lines naming Firebase now describe the real stack (local accounts, scrypt, signed bearer token resolved on every request, TOTP). `README.md` rewritten (the AI Studio banner and instructions are gone). |

### M03 desktop shell, HTTP hardening, observability

| Item | Result |
|---|---|
| Production by default | `src/server/obs/entry.ts` is the entry of the server bundle. It runs `bootstrap()` (validate config, print one error and exit on failure, copy NODE_ENV/HOST/PORT/JWT_SECRET back into `process.env` for the older code that reads them, install the pino logger) and only then imports `server.ts`. Unset `NODE_ENV` is production; `development` has to be asked for (`npm run dev` does, with a random per-run JWT secret). `JWT_SECRET` (32+ characters) and `SQL_*` are required in production; the old public secret is rejected everywhere. |
| Loopback | `HOST` defaults to 127.0.0.1 and any non-loopback value is refused. `LIMS_BIND_LAN` and the TLS file settings are parsed and validated, but LAN mode is refused at start-up (`LAN_LISTENER_WIRED = false` in `config.ts`) until server.ts can create the HTTPS listener. `requireTlsFromRemote` (plain http from another computer gets 403) is in place for the day it is switched on. |
| Bundle out of the static root | `scripts/build-server.cjs` (esbuild API; replaces a 1,000-character npm script) writes `dist-server/{server,init-db,backup-cli,supervisor}.cjs` with linked source maps. `dist/` now holds only the frontend. `static.ts` serves `DIST_DIR` only, never `.cjs/.mjs/.map/.ts`, and a missing file is 404, not `index.html` (the single-page fallback is for routes). `index.html` is `no-cache`. |
| CSP | helmet with `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `style-src-attr 'unsafe-inline'`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no external host, no `unsafe-eval`, no `upgrade-insecure-requests` (the app is plain http on loopback). Off only in development (the Vite client needs inline script). A static page with inline code (`public/backup.html`) gets a CSP that allows exactly its own blocks by sha256 hash; `desktop/setup.html` carries the same in its meta tag (a test checks the hashes match). |
| Rate limits | `src/server/http/rateLimit.ts`. Keys the client cannot choose: socket address (X-Forwarded-For counts only when `TRUST_PROXY` names real proxies; `trust proxy` was 1 unconditionally), a hash of the bearer token (one budget per session), and for sign-in the e-mail address. Failed sign-ins only: 20 per 15 min per address, 10 per e-mail. 3000 per minute per address, 600 per minute per session. The refusal is JSON `{ error, code: 'RATE_LIMITED', retryAfterSeconds, requestId }` with `Retry-After`. Health probes are never limited. |
| Probes | `GET /api/health` (up, uptime, version) and `GET /api/ready` (database answers and `public.users` exists; 503 without any detail on failure, the cause goes to the log). Unauthenticated. The desktop shell waits on `/api/ready`. |
| Socket.IO | The Express app was handed Socket.IO's requests as well (server.ts registers it as a second `request` listener after Socket.IO attached). Whichever wrote second raised `ERR_HTTP_HEADERS_SENT`, and in a browser run that took the server down. `applySecurity` makes the app ignore `/socket.io` requests. Found by the browser run, covered by `socketio.test.ts`. |
| Logs | `src/server/obs/logger.ts`: pino, one JSON object per line (same shape as before: `level` as a word, ISO `time`), info to stdout and warn/error to stderr, credentials redacted by key at four depths. Installed at boot by replacing the methods of the shared `log` object, so no call site changed. Rotation and capture of everything else the process prints (a crash stack trace, Node's own fatal output) is the supervisor's job: `obs/rotate.ts` (5 MB x 10 files). |
| Supervisor | `src/server/obs/supervisor.ts` (loaded by the Electron shell from `dist-server/supervisor.cjs`): forks the server, writes its stdout/stderr redacted to `<userData>/logs/server.log`, restarts after an unexpected exit with back-off 0.5, 1, 2, 4, 8 s (every restart starts within 10 s), logs `SERVER_RESTART` (attempt, exit code, signal, run time), tells the new child `LIMS_RESTART_COUNT` and `LIMS_LAST_EXIT`, clears the failure count after 60 s of healthy running, gives up after 5 early failures with `SERVER_GAVE_UP` and a dialog. |
| Electron shell | `desktop/main.cjs`, `preload.cjs`, `setup.html`. Fixed port (stored in `config.json`; a free one in 20000-29999 on first start, a new one only if the stored one is taken). The application window has no preload; the database bridge exists only in the setup window, and both IPC handlers check that the call comes from the top frame of the live setup window showing `setup.html` and validate the input types. Navigation, redirects and new windows are checked by `new URL(u).origin === origin` (the old `startsWith(origin)` accepted `http://127.0.0.1:PORT@evil.example/`, and any `file://` URL). The backup window gets the same guard. `session` permission handlers grant only `media` (voice notes, barcode camera), only to the local origin. DevTools are off in a packaged build. Menu entry "Open log folder". |
| Build config | `package.json`: `build`, `build:server`, `start` (`node --enable-source-maps dist-server/server.cjs`), `dev`, `lint*`, `seed`, `check:root`; electron-builder ships `dist-server/**`. `.github/workflows/build.yml` now creates the schema with the shipped installer (`dist-server/init-db.cjs`), seeds with the new script, runs the shipped bundle in production mode (it ran `tsx server.ts` and `drizzle-kit push`), asserts the bundles answer 404, and runs the root check. |

## Why

The findings in `synth.mergedGaps` M02/M03 and `topDefects` "Production start mode is insecure", the rate-limit and Electron items of the security review, and the platform review items on tsconfig, silent server output and Google fonts. Details and the risk table are in `docs/change-control.md`.

## Deliberate behaviour changes

1. `npm start` and every other non-development start is production: without `JWT_SECRET` (32+ characters) and `SQL_HOST/USER/PASSWORD/DB_NAME` the process exits 1 with one readable message. Before, it ran the Vite dev middleware with a public secret on 0.0.0.0.
2. Listening address defaults to 127.0.0.1; a LAN address is refused (see above).
3. `GET /server.cjs`, `/server.cjs.map`, `/init-db.cjs`, `/backup-cli.cjs` are 404; any request for a missing file with an extension is 404 instead of `index.html`.
4. A strict CSP is sent; `X-Forwarded-For` is ignored unless `TRUST_PROXY` is set.
5. Rate limits changed from 200 requests per 15 minutes per address, text refusal, to the limits above with a JSON refusal. Two new unauthenticated routes: `/api/health`, `/api/ready`.
6. Server bundles live in `dist-server/`; `tests/backup-restore.sh` calls `dist-server/backup-cli.cjs`.
7. The desktop app keeps its origin across restarts, restarts a dead server, and writes `logs/server.log`.
8. `npm run lint` fails on new strict server type errors (see decisions).
9. The demo seed is `npm run seed`, and refuses `NODE_ENV=production`.

## How to verify

```
# unit and API tests (140 tests, 19 files; 63 of them in tests/unit/shell)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run

npm run lint                 # client + server (baseline)
npm run check:root
npm run build                # dist/ (frontend) and dist-server/ (bundles)

# shared validation evidence against the production bundle (port 3102 used here)
JWT_SECRET=<48+ random chars> PORT=3102 SQL_...=... node --enable-source-maps dist-server/server.cjs &
BASE=http://127.0.0.1:3102/api tests/security-controls.sh     # 34 PASS, output identical to the run on the old code
BASE=http://127.0.0.1:3102/api tests/backup-restore.sh        # 12 PASS

# the real Electron shell, 17 checks (needs a display: xvfb-run -a)
xvfb-run -a node tests/desktop-shell.cjs
xvfb-run -a node tests/desktop-smoke.cjs                       # existing smoke test, still passes
```

## Evidence (test-first)

* All regression tests were written first and run on the old code (`tests/unit/shell`, 27 tests at that point): **24 failed, 3 passed** (the 3 are characterisation of unchanged behaviour: unknown API routes are JSON 404, development has no CSP, successful logins are not throttled). Old behaviour seen: `/server.cjs` and `/server.cjs.map` 200; a missing `.png`/`.map` answered with `index.html`; rotating `X-Forwarded-For` never reached the limit (the old limiter is 200 per 15 minutes); no per-session budget; no CSP; `/api/health` 404. (By reading the code, the old limiter answered plain text.)
* The black-box entry test, pointed at the old `server.ts`: all 4 fail. `PORT=abc` exited 1 but with a JSON log line (stack trace, no mention of the variable); a missing `JWT_SECRET` and `HOST=0.0.0.0` were accepted and the server ran until the 20 s timeout.
* The type-check test shows the old `tsconfig.json` accepts `r.expirationDate` on a Drizzle row and `tsconfig.server.json` reports `TS2339`.
* Electron shell test, run against the pre-r1 shell built in a scratch copy (stopped at its first unexpected error): the IPC call from a foreign page was **allowed**, the application window had the database bridge, the port was random and not stored, and `http://127.0.0.1:PORT@127.0.0.2:9/` was navigated to. 6 failed, 4 passed. The new shell: 17 of 17.
* The socket-request bug was found by the browser run (server exit after the first page load), then pinned by `socketio.test.ts`, which fails without the guard.
* Browser run of the production bundle (headless Chromium, sign-in as QA, 11 views): 0 requests outside 127.0.0.1, 0 CSP violations, 0 console errors, Outfit and Plus Jakarta Sans served from `/assets`, Socket.IO connected. `/backup.html` runs its inline handler under its hash CSP.
* CI job emulated end to end on a fresh database: shipped installer, seed, bundle, readiness poll, 404 checks, 34 and 12 PASS.
* Seed equivalence: old and new seed compared table by table.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: rate-limit numbers; session-token fingerprint instead of a verified user id for the per-user key; log retention (5 MB x 10 files, operational logs, not records); CSP `style-src-attr 'unsafe-inline'`; sourcemaps shipped in the installer; the 14 deleted root scripts outside the ownership globs; baseline contains two real bugs; `NODE_ENV` default production affects tools that call `createApp` (set `NODE_ENV=test`).

## Not done

* `xlsx` is still a dependency: `src/components/Reports.tsx` (r1-results-oos) imports it for the Excel export. Removing the package now would break `vite build`.
* LAN mode with TLS (`LIMS_BIND_LAN`): config and the TLS gate exist; the HTTPS listener has to be created in `server.ts` (r1-core's file).
* `server.ts` still reads `HOST`/`PORT` itself; they are right only because the bundle's entry normalises them. `tsx server.ts` run directly still defaults to 0.0.0.0.
* `src/server/core/auth.ts` still contains the fallback literal secret. No entry point of this track reaches it (production requires a secret, `npm run dev` generates one), but it is still in the source (r1-identity replaces it).
* The pino logger is installed by patching the shared `log` object at boot; `core/logger.ts` should re-export `obs/logger` instead.
* `SERVER_RESTART` is written to `server.log` only, not to an audit/security-event table (needs r1-audit). The restart count and last exit are passed to the new server process in its environment so the server can record them later.
* A crash that leaves a stack trace is covered by the supervisor unit test (child dies with an uncaught exception). The Electron test kills the server with SIGKILL, which by nature leaves no trace.
* "Database connection..." in the application menu needs no login and is not audited (needs an authenticated, audited path from r1-identity/r1-audit).
* Electron 33 advisories (npm audit) are not addressed: a new major version needs IQ-W.
* IQ-W on the target PC has to be re-executed (DEV-06); the validation package still names `dist/*.cjs`.

## Needs from other tracks

1. **server.ts (r1-core / wave gate)**, about ten lines:
   ```ts
   import https from 'https'; import fs from 'fs';
   const config = getConfig();                       // from ./src/server/config
   const httpServer = config.tls ? https.createServer({ cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) }) : createServer();
   httpServer.on('request', app);                    // BEFORE createRealtime(httpServer), so Socket.IO sees it as the fallback
   httpServer.listen(config.port, config.host, ...);
   ```
   then set `LAN_LISTENER_WIRED = true` in `config.ts`.
2. **`.gitignore`**: add `dist-server/` (not matched by any owned pattern; until then do not run a build before the gate commit, or delete `dist-server/`).
3. **r1-identity**: `core/auth.ts` should take its secret from `getConfig().jwtSecret` and lose the literal; `core/logger.ts` should delegate to `obs/logger`; the 429 body shape for the client is `{ error, code: 'RATE_LIMITED', retryAfterSeconds }`.
4. **r1-results-oos** (`Reports.tsx`): replace the XLSX export (CSV, or a vetted library), then `npm uninstall xlsx`. Fix `r.isOOS` in `routes/reports.ts`.
5. **r1-quality-fixes**: `r.expirationDate` in `routes/dashboard.ts`.
   After 4 and 5: `node scripts/typecheck-server.cjs --update` shrinks the baseline (otherwise a reintroduced typo of the same kind in the same file would still pass).
6. **wave gate**: `tests/helpers/dump-route-table.ts` fails with `__dirname is not defined` under tsx (r1-core); `--stdout` works. It must be run with `NODE_ENV=test` now (production is the default). `tests/helpers/db.ts` comment still names `src/server/seed_pg.ts`.
7. **validation refresh**: `validation/build/collect-evidence.sh`, `content.cjs`, `build.cjs` and the evidence files mention `dist/*.cjs`.
8. **r1-audit**: persist `SERVER_RESTART` / `SERVER_GAVE_UP` as security events.

## Files outside this track's ownership that were touched

* `tests/backup-restore.sh`: five occurrences of `dist/backup-cli.cjs` became `dist-server/backup-cli.cjs` (forced by moving the bundle out of the static root; assertions unchanged).
* `tests/route-table.json` (+2 routes) and `tests/unit/core/route-table.test.ts` (the list of routes without `requireAuth` now names the two probes): forced by the new routes; this is the review point that file exists for.
* 14 root scripts that no ownership glob matches but that M02 names among the 143 (`change-oos-status.cjs`, `check-imports.cjs`, `create-batch-endpoint.cjs`, `fix.cjs`, `make-register.cjs`, `mega-fix.cjs`, `patch.cjs`, `patch_oos.js`, `rename-btn.cjs`, `rename-specs.cjs`, `rewrite.cjs`, `seed-spec.cjs`, `test-otp.js`, `test.cjs`).
* New test files (no ownership pattern covers tests): `tests/unit/shell/*`, `tests/desktop-shell.cjs`.
