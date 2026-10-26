# r1-core: platform core (roadmap M01)

Release R1, first track, run alone. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.

## What changed

`src/server/api.ts` (3,085 lines, 64 route registrations plus one mounted router) is now one module per domain, assembled by `createApp()`. Behaviour is the same except for the items under "Deliberate behaviour changes".

| Area | Files |
|---|---|
| Application factory | `src/server/app.ts` (`createApp({ db, io, rateLimit })`), `server.ts` (thin composer: listen, Socket.IO, DB bootstrap, frontend) |
| Route modules (24 domains in the roadmap, 21 with routes today) | `src/server/routes/<domain>.ts`, registry in `src/server/routes/index.ts` |
| Core primitives | `src/server/core/`: `tx.ts`, `asyncHandler.ts`, `router.ts`, `auth.ts`, `process.ts`, `logger.ts`, `context.ts` |
| HTTP layer | `src/server/http/errors.ts`, `http/validate.ts`; initial extractions `http/security.ts`, `http/static.ts`, `src/server/realtime.ts` |
| Validation | `src/lib/validations/lims.ts` split into `samples, results, oos, stability, env, specifications, instruments, reagents` plus new `eln.ts`; `index.ts` re-exports |
| Test harness | `vitest.config.ts`, `tests/helpers/`, `tests/unit/core/`, `tests/route-table.json`, `.github/workflows/tests.yml` |
| Shim | `src/server/api.ts` is now 10 lines: it only exports `requireAuth`, because `src/server/reports.ts` (r1-backup-jobs) imports it from there |

Files that match other tracks' `ownsFiles` but were created here because the roadmap tells r1-core to extract them: `routes/<domain>.ts`, `validations/<domain>.ts`, `http/security.ts`, `http/static.ts`, `realtime.ts`. They belong to their owning track from now on.

### Primitives (`src/server/core/tx.ts` and friends)

| Primitive | Use |
|---|---|
| `updateVersioned(tx, table, id, expectedVersion, set)` | `UPDATE ... WHERE id = $1 AND version = $2 ... version = version + 1 RETURNING *`. `ConflictError` (409) when the version moved, `NotFoundError` (404) when the row is gone. `set` may not contain `id` or `version`. |
| `lockRow(tx, table, id)` | `SELECT ... FOR UPDATE` for read-validate-write flows over several rows. |
| `withTransaction(db, (tx, afterCommit) => ...)` and `emit(io, event, payload)` | Side effects (socket emits, queue publishes) registered with `afterCommit` run only after COMMIT and never on rollback; a failing hook is logged, not thrown. |
| `nextSequence(tx, key)` | Gap-free counter. Needs table `counters(key text primary key, value bigint not null)`, which r1-migrations ships. Not used by any route yet. |
| `asyncHandler`, `createRouter()` | Express 4 does not forward a rejected async handler to the error middleware, so Node exited. `createRouter()` wraps every handler registered through it. Use it instead of `express.Router()`. |
| `AppError` family, `requestContext()`, `notFoundHandler`, `errorHandler()` | One JSON error shape `{ error, code, requestId, details? }`; `error` stays a string because the UI shows it. Unexpected errors answer 500 `Internal server error`; the detail is logged with the request id. |
| `validate(schema, source = 'body')` | Strict Zod as middleware; failure is 400 `VALIDATION_FAILED` with the issue texts joined (what the UI already shows) and `details: [{ path, message }]`. |
| `requireStringCredentials` | Applied to every `/api` request: `password`, `newPassword`, `currentPassword`, `passphrase`, `tempToken` must be strings when present. |
| `installProcessHandlers()` | `unhandledRejection`: log and continue. `uncaughtException`: log, run `onFatal` (closes the HTTP server), exit 1. |

### How a route module looks (for the other tracks)

```ts
export const thingRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  router.put('/things/:id', requireAuth, validate(thingUpdateSchema), async (req, res) => {
    const user = (req as any).user;                      // actor always from the token
    const updated = await withTransaction(db, async (tx, afterCommit) => {
      const row = await updateVersioned(tx, things, req.params.id, req.body.expectedVersion, { ...changes });
      await writeAudit(tx, user.id, 'Update', 'Thing', row.id, ...);   // same transaction
      afterCommit(() => emit((req as any).io, 'thing:updated', { id: row.id }));
      return row;
    });
    res.json(updated);
  });
  return router;
};
```

Registering a new domain: one import and one entry in `src/server/routes/index.ts`, and the new routes in `tests/route-table.json` (`npx tsx tests/helpers/dump-route-table.ts`). The list is explicit, not discovered from the directory, because the production server is one esbuild bundle and a directory scan would find nothing at run time.

### Test harness

`npx vitest run` against a real PostgreSQL (`SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`; user must be allowed to `CREATE DATABASE`).

* `tests/helpers/globalSetup.ts` builds `<SQL_DB_NAME>_tpl` once through the product's own installer (`src/server/init-db.ts`: `desktop/schema.sql`, append-only triggers, first admin) and replaces the admin with five fixed users (`admin@gxp.com`, `qa@gxp.com`, `reviewer@gxp.com`, `analyst1@gxp.com`, `analyst2@gxp.com`, password `password`). It drops the template at the end.
* Each test file that needs data gets its own copy, `<SQL_DB_NAME>_t<pid>` (`useTestDb()`), so files run in parallel and never share rows. The harness only ever drops databases it derived from `SQL_DB_NAME`, never `SQL_DB_NAME` itself.
* `startTestApp()` (`tests/helpers/app.ts`) imports the real `createApp`, with a recording Socket.IO stand-in, and returns a supertest client plus `auth(email)` headers and `db.pool` for arranging rows. Build the auth header before creating a supertest request (explained in the file).
* `tests/helpers/fixtures.ts`: `registerSample`, `insertActiveSpec`, `race(n, send)` (n simultaneous requests, sorted status codes).

## Why

Findings addressed (roadmap M01 and the matching entries in `synth.topDefects`):

* One 3,000-line file made every later track edit the same file. Domain files let the tracks run in parallel.
* "Any authenticated user can crash the server": non-string `password` or `content` at `POST /samples/:id/notebook`, `certify`, `adminWithPassword` were unhandled rejections in Express 4. There was no error middleware and no process handler.
* AGENTS.md section 2: no `UPDATE` carried a version predicate; about seven routes did read-compare-write, which loses updates under READ COMMITTED.
* Error bodies could contain SQL text and bound parameters (`Failed query: insert into ... params: ...`).
* MFA bypass (top defect 1): the pre-MFA `tempToken` was accepted by `requireAuth` as a full session. Fixed in `core/auth.ts` because the function moved here; r1-identity still owns the real token redesign.
* Duplicate `POST /audit/verify`: the unguarded handler shadowed the Admin/QA one.
* The OOS socket notification was emitted inside the transaction, before COMMIT.

## Deliberate behaviour changes

1. `POST /api/audit/verify` now requires Admin or QA (403 otherwise) and also returns `totalRecords`. The unguarded duplicate was deleted. The UI callers (`AdminPanel`, `AuditTrail`) are Admin/QA screens; `tests/security-controls.sh` calls it as QA.
2. Every `/api` request with a non-string `password`, `newPassword`, `currentPassword`, `passphrase` or `tempToken` gets 400, before authentication.
3. Pre-MFA tokens are rejected by `requireAuth` (401). `/auth/totp-setup` and `/auth/totp-verify` are unaffected.
4. Ten writes now carry the version predicate: ELN save and seal, result save, sample transition, OOS save and close, stability save, environmental record save, specification save and approve. A losing writer gets 409 and writes no audit entry. Where the client sends no `expectedVersion` (ELN save, OOS close) the version read in the same request is the predicate.
5. The OOS "New OOS Detected" notification is emitted after COMMIT, once per committed write.
6. `POST /samples/:id/notebook` has a strict schema (`content`, `password` only): non-string content is 400 instead of a crash, unknown fields are 400.
7. Unknown `/api/*` routes, malformed JSON and oversized bodies answer JSON (404 `NOT_FOUND`, 400 `INVALID_JSON`, 413 `PAYLOAD_TOO_LARGE`) instead of HTML. Every error body from any handler gets `requestId` (also header `X-Request-Id`); an error body that contains drizzle's `Failed query:` text is replaced by a generic `DATABASE_ERROR` message and the original is logged.
8. Five create routes (`/stability`, `/env-records`, `/specifications`, `/instruments`, `/reagents`) use `validate()` instead of inline `safeParse`; same schemas, same 400 text.
9. Conflict messages are now one text (`Conflict: the record was modified by another user. ...`) on the converted routes. The UI shows `error` verbatim and does not match on it.
10. `server.ts` exits with code 1 when start-up fails (it used to log and carry on), and installs the process handlers.

## How to verify

```
# unit and API tests (77 tests, 8 files)
SQL_DB_NAME=<base> npx vitest run

# shared validation evidence against a running, seeded server (port 3100 used here)
SQL_DB_NAME=lims_r1_core BASE=http://127.0.0.1:3100/api tests/security-controls.sh     # 34 PASS, identical to before the split
SQL_DB_NAME=lims_r1_core BASE=http://127.0.0.1:3100/api tests/backup-restore.sh        # 12 PASS, identical to before the split
```

Evidence recorded while building this track:

* Test-first. The same 24 behavioural tests (`route-table`, `occ`, `robustness`) were run against a pristine `git archive HEAD` copy of the old code with a 10-line `createApp` shim: 20 failed, 4 passed (the 4 are characterization of unchanged behaviour). Examples of the old behaviour: 7 of the 8 race tests failed, with 4 to 6 of the 6 simultaneous writers answered 200 (the eighth passed by timing; it varies from run to run); `{"password":123}` ended in a 500 or a hung request, `{"content":{}}` in `Unhandled Rejection: content.trim is not a function`; the pre-MFA token got 200 on `GET /samples`; the SQL text came back in the 500 body.
* Mechanical equivalence of the split: the move was done by a script over the TypeScript AST. It asserts that each of the 64 route statements and every template literal (the AI prompts are whitespace-sensitive) appears unchanged in its new file, modulo indentation. Only afterwards were the deliberate edits above made by hand.
* Route table: `tests/route-table.json` was recorded from the old code (66 registrations, `POST /audit/verify` twice) and is the 65 distinct entries. The test fails on the old code and passes now.
* Read-only API surface: 34 GET and failure-path responses collected from the old and the refactored server against the same database are identical except for the added `requestId`, the `totalRecords` field of the surviving `/audit/verify`, and `updatedAt` on a settings row the old server created on first read.
* `npm run lint` (tsc, whole project) is clean. The production bundle (`esbuild server.ts --bundle ...`, as in `npm run build`) builds and serves the API and the single-page app.

## Decisions that need confirmation

See the structured report (`decisionsForUser`); in short: process-level policy (log and continue on unhandled rejection, exit on uncaught exception), the audit-verify access change, the pre-authentication credential type guard, and the explicit route registry.

## Not done

* Of the 27 `update().set()` calls, 17 still have no version predicate: 11 on `users` (login and signature counters, lockout, training flag, admin edit), 1 `system_settings`, 1 `instruments`, 2 on `signatures` (the single allowed `pending` to audit-id link), 1 `batch_releases` (same-transaction link), 1 `specifications` (Obsolete on supersede). Those tables have no `version` column, or belong to a redesign (esign, identity, spec, quality-fixes).
* Strict Zod on the remaining inputs. Only the five create routes and the notebook route use `validate()`; the others keep their inline checks for the owning tracks to replace.
* Legacy handlers still end in `catch (e) { res.status(500).json({ error: e.message }) }`. The central backstop removes SQL text and adds the request id, but other internal messages still reach the client until those handlers are rewritten.
* `lockRow` and `nextSequence` have tests but no caller yet (results-oos, esign and spec will use them).
* Resolved at the wave gate: `vitest@3.2.7`, `supertest@7.3.1` and `@types/supertest@6.0.3` are now exact-pinned devDependencies in `package.json` and `package-lock.json` (lockfile change is additive only), with `"test": "vitest run"`. Without them a fresh `npm ci` followed by `npm run lint` failed on the test imports, which would have turned `build.yml` red. `tests.yml` now runs `npm ci` and `npm test`. r1-build-shell no longer needs to add these.
* Sockets are still unauthenticated (r2-events owns `realtime.ts`); production start mode, CSP, per-user rate limits (r1-build-shell); the `isOOS` read in `GET /reports/metrics` (no R1 track owns `routes/reports.ts`; r1-results-oos needs it).
