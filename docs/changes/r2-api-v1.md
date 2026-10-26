# r2-api-v1: machine integration API with scoped tokens, batch writes, idempotency keys and OpenAPI 3.1 (roadmap M22)

Release R2, second wave (beside r2-raw-data). Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-api-v1.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** The three M22 acceptance criteria pass in a gate simulation (`git archive HEAD` + this
track + the patch + the three regenerations; scratchpad `r2api-sim`). In the shared tree without the patch, `/api/v1` and `/api-clients` are
not mounted, so 17 of the 24 new tests fail with 404 (that is the evidence the wiring is missing, not a defect); the 7 that read the committed
contract files pass.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, additive) | `drizzle/0140_api_v1.sql`: tables `api_clients` and `api_idempotency_keys`. No existing table or row is touched; no permission or signature meaning is added |
| Schema | `src/db/schema/api-clients.ts` |
| Token principal | `src/server/auth/principals/apiToken.ts`: token format, SHA-256 at rest, `authenticateApiToken`, `refuseApiTokensOutsideV1` |
| The v1 API | `src/server/v1/`: `index.ts` (`mountApiV1`, dispatcher), `registry.ts` (`defineRoute`), `scopes.ts`, `problem.ts` (RFC 9457), `idempotency.ts`, `dto.ts` (response schemas), `routes/{samples,results,quality,index}.ts`, `openapi.ts` (generator + structural validator), `breaking.ts` (breaking-change detector), `docsSite.ts` (docs page), `openapi-cli.ts` (`write` / `check`), `entities.ts` (`ApiClient` signable type) |
| Administration route | `src/server/routes/api-clients.ts`: list, create (signed), revoke (signed) |
| Screen | `src/components/ApiClients.tsx` (shell entry `#/api-clients`, Administrators, through the gate patch) |
| Published contract | `docs/api/openapi.json`, `openapi.js`, `index.html`, `docs.js`, `docs.css` (generated; a test fails when they are stale) |
| Tests | `tests/api/api-v1.test.ts` (15), `tests/api/api-v1-openapi.test.ts` (9) |

### The API (`/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`, docs at `/api/v1/docs/` and `docs/api/index.html`)

| Operation | Scope | Behaviour |
|---|---|---|
| `GET /samples?limit&cursor&state&batch` | `samples:read` | Newest first, keyset cursor (`nextCursor`, null on the last page). The cursor carries `created_at` at microsecond precision, so rows registered in one transaction are not skipped |
| `GET /samples/{sampleId}` | `samples:read` | The sample and its results: id, limit as registered, value, `version` (sent back as `expectedVersion`). Explicit DTOs: no internal column (attachment bytes) leaves the server |
| `POST /samples:batch` | `samples:write` | 1 to 500 registrations, all or nothing, through `insertSamples` (the session API's write: per-year counter, specification revision in force, one result per parameter, one audit entry per sample). 201 |
| `POST /results:batch` | `results:write` | 1 to 500 values, all or nothing, each through `saveResult` (the bench's write: sample locked and in Testing, version predicate, evaluation against the registered limit, result guards for instrument calibration, method, calculated inputs and SST, audit entry, OOS investigation opened in the same transaction, notification after COMMIT). The first refused item rolls back the call; the problem names it (`errors[].index`, pointer `/items/<i>`). A result that already has a value is 409 `RESULT_ALREADY_ENTERED`. A machine cannot replace an OOS value. A client bound to an instrument records every value on that instrument |
| `GET /specifications/active[?material]` | `specifications:read` | `resolveActiveSpec`: the revision in force for one material, or for every material |
| `GET /batches/{batch}/disposition` | `batches:read` | Quarantine Hold, Released or Rejected; for a batch on hold, `findReleaseBlockers` and `releasable`. The release itself stays an e-signature by a person |
| `GET /openapi.json` | none | The contract (no data) |

Every write needs an `Idempotency-Key` (400 without one). A repeat with the same key and body gets the stored answer (header
`Idempotent-Replayed: true`) and writes nothing; the same key with another body is 422. A transaction-scoped advisory lock on
(client, key) serialises two simultaneous calls with the same key, and the answer is stored in the transaction of the write, so a
refused call leaves no key behind. Every error is `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `code`,
`requestId`, `errors[]`), including 401, 403, 404, 405, malformed JSON and oversized bodies. The body limit of `/api/v1` is 2 MB.

### Tokens and API clients

* **Token** `lims_<8>_<43>`: 32 random bytes; only SHA-256 is stored, with the public prefix for identification. Shown once.
* **Client** (`api_clients`): name (unique ignoring case), scopes, optional instrument, mandatory expiry (1 to 365 days), status, `version`.
  Each client has its own **service account** (`users` row, role `Instrument`, no e-mail, no password): every row it writes is attributed
  to it (audit `user_id`, `entered_by`, `created_by`). The role is not in the permission matrix, so it holds no permission of the
  interactive API; it is also in `RESULT_ENTRY_ROLES` (gate patch) so `saveResult` accepts it.
* **Create** `POST /api/api-clients` and **revoke** `POST /api/api-clients/:id/revoke` (Admin: `admin.integrations.manage`) are e-signed
  through `signRecord` with `ADMIN_AUTHORISATION` on record type `ApiClient`, bound to the record version (1 at creation, 2 at revocation).
  Revocation also deactivates the service account; a revoked client is final (423). A stale version is 409. `GET /api/api-clients`
  (`admin.integrations.view`) never returns the hash.
* **Authentication** on `/api/v1`: missing token 401 `UNAUTHORIZED`; a session token, an unknown token 401 `INVALID_TOKEN`; revoked 401
  `TOKEN_REVOKED`; expired 401 `TOKEN_EXPIRED`; inactive service account 401. Each rejected token is a security event
  `API_TOKEN_REJECTED` (prefix only, never the secret). A token without the operation's scope is 403 `INSUFFICIENT_SCOPE`, recorded as
  `AUTHZ_DENIED`.
* **Everywhere else in `/api`** an API token is refused before the session layer: 401 if not valid, otherwise 403 `API_TOKEN_NOT_ALLOWED`
  recorded as `AUTHZ_DENIED`. No token can reach a signing route, and no scope exists for anything that is signed.
* **Rate limit**: the existing per-bearer limiter (`http/rateLimit.ts`, key = hash of the token) gives each token its own budget, so the
  per-address defect of `synth.topDefects` does not apply to machine clients.

### The contract and CI

`defineRoute` is the deny-by-default table of `/api/v1`: an operation exists only through it, with a scope, strict Zod schemas for path,
query and body, and Zod schemas of its answers; it refuses a write that is not idempotent, an undeclared path parameter, a duplicate.
The dispatcher runs those schemas and `openapi.ts` turns the same schemas into the OpenAPI document (`z.toJSONSchema`, draft 2020-12),
so the contract cannot drift from the code. `openapi-cli.ts write` regenerates `docs/api` and refuses a breaking change without
`--allow-breaking "<reason>"`; `openapi-cli.ts check --base <ref>` fails when `docs/api` is stale or the contract breaks the one at `<ref>`
(removed operation or success status, changed scope, new required parameter or field, removed request field under a strict schema, narrower
type, enum, length, range or item count, removed or optional response field, new response enum value). The gate patch adds that step to
`tests.yml`. The session API's route table (`authz/routeTable.ts`) does not govern `/api/v1` (its rules are permissions of people's roles):
the v1 router is mounted ahead of it and ends every `/api/v1` request; its routes are matched by the registry, so `assertRouteContract`
sees no Express route under `/api/v1`.

## Why

M22: the only credential was an interactive session token; no versioned prefix and no OpenAPI; one call per result; an instrument could only
act as a person. GxP risk named by the roadmap: machine-entered results need an attributable bounded identity (own service account, scopes,
expiry, signed issue and revocation) and the same gates as manual entry (the same `saveResult`).
`synth.topDefects`: the only item in this scope is the per-address rate limit, already replaced by r1-build-shell with a per-bearer limiter
that gives each API token its own budget. The paging defect found while building this track is in another track's file (see "Needs").

## For the gate

1. Apply `docs/changes/r2-raw-data.gate.patch` first, then `git apply docs/changes/r2-api-v1.gate.patch`, then delete both. Since the
   re-verification below, this patch is cut on top of r2-raw-data's patch (both add lines at the same places in `routes/index.ts`,
   `routeTable.ts` and `schema/index.ts`), so the two apply cleanly in that order. If r2-raw-data's patch is not applied (or changes),
   use `git apply --3way` and keep both sides of each conflict: every conflict is two independent added lines. The patch changes:
   * `src/server/app.ts` (r1-core): `mountApiV1(app, { db })` right after `applySecurity`, before `express.json()` and `authorize`.
   * `src/server/routes/index.ts`: `apiClientsRoutes`.
   * `src/server/authz/routeTable.ts` (r1-authz): `GET /api-clients` on `admin.integrations.view`; `POST /api-clients` and
     `POST /api-clients/:id/revoke` on `admin.integrations.manage` with the route's strict schemas as `body`. No new permission code.
   * `src/db/schema/index.ts` (r1-migrations): `export * from './api-clients'` (without it the drift test sees two undeclared tables).
   * `src/lib/constants/results.ts` (r1-results-oos): `'Instrument'` in `RESULT_ENTRY_ROLES`.
   * `src/components/shell/ext/api-clients.tsx` (new, r2-ui-foundation's directory): the shell entry, `adminOnly`.
   * `.github/workflows/tests.yml`: checkout with history and the step `npx tsx src/server/v1/openapi-cli.ts check --base origin/<target>`.
2. Regenerate: `NODE_ENV=test JWT_SECRET=<any> npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (3 routes added),
   `npx tsx scripts/authz/export-matrix.ts` (69 permissions at HEAD, 70 with r2-raw-data's; the two integration rows list the new routes),
   `npx tsx src/server/boot/migrate-cli.ts export-schema` (adds 0140).
3. Migration 0140 sorts before the already applied 0180: a development or gate database built from the R2 W1 tree is refused with
   `OUT_OF_ORDER` and must be rebuilt (fresh installs and v0.1.0 upgrades are fine; same situation as 0050 at W5).

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/api-v1-openapi.test.ts                 # shared tree: 7 of 9 pass (2 need the wiring)
# after the gate steps:
npx vitest run tests/api/api-v1.test.ts tests/api/api-v1-openapi.test.ts   # 24
npx vitest run && npm run lint
npx tsx src/server/v1/openapi-cli.ts check [--base <ref>]
```

## Evidence (2026-10-20, gate simulation `scratchpad/r2api-sim`)

* **Test first.** Both files were run on the untouched code before any implementation: 15 of 15 in `api-v1.test.ts` failed (404 `NOT_FOUND`
  for `POST /api/api-clients`, legacy JSON, no `/api/v1`), and `api-v1-openapi.test.ts` could not load (`src/server/v1/openapi` did not exist).
  They fail by absence: the old system had no machine principal, no batch write and no contract.
* **Acceptance (M22)**, all in the simulation:
  1. *500 results in one call, and replaying the Idempotency-Key creates no new rows*: 100 samples registered through `samples:batch`,
     500 values in one `results:batch`: 500 result rows at version 2, exactly 500 new audit entries, all with the service account as actor
     and the key in the reason; the replay answers byte-identical with `Idempotent-Replayed: true`, no audit entry and no row change; the
     same key with another body is 422; two simultaneous calls with one key give `[200, 200]` and one set of audit entries; the same for
     `samples:batch` (no new samples on replay). The 500-value test takes about 4.6 s including the registration of the 100 samples.
  2. *A results:write token calling any signing endpoint returns 403, and a revoked token returns 401*: every mutating rule of the route
     table that signs, decides or changes a status (read from `ROUTE_RULES`: 20 routes at HEAD) answers 403 `API_TOKEN_NOT_ALLOWED`, each with an
     `AUTHZ_DENIED` event; after revocation the same token is 401 there and on `/api/v1` (`TOKEN_REVOKED`); expired 401 `TOKEN_EXPIRED`.
  3. *openapi.json validates and the docs page loads offline*: the committed document equals the generated one, is OpenAPI 3.1.0 and passes
     the structural validator (which itself rejects an unresolved `$ref`, a duplicate `operationId` and an undeclared path parameter); the
     docs files contain no external host and no inline script or style; `docs.js` renders every operation from the committed files in a
     sandbox; in Chromium with the network off, `file://.../docs/api/index.html` rendered the 7 operations and requested nothing outside
     the file system; the server serves the same files under the application's CSP.
* **Mutation checks** (each must turn a test red; `scratchpad/r2api-mutations.txt`): scope check off (2 red), idempotency replay off (3),
  API tokens accepted outside v1 (1), item errors skipped instead of aborting (2), first-entry rule off (1), revocation ignored (1), expiry
  ignored (1), idempotency lock removed (1, the race test). One survived as expected: removing the pre-signature version check of the
  revocation changes nothing observable, because the version predicate inside the signing transaction (`updateVersioned`) still answers 409.
* **Whole suite** in the simulation: 101 files passed, 2 skipped (opt-in scale tests); **1318 passed, 3 skipped, 0 failed**. `npm run lint`:
  web clean; server 18 known baseline errors, none new (also in the shared tree).
* **Drift.** The first version stored scopes as `text[]` and keyed idempotency rows by a composite primary key; drizzle-kit's introspection
  (used by `schema-drift`, `migrate-cli draft` and two migration tests) crashes on both (`there is no parameter $1`). Scopes are now `jsonb`
  with a CHECK that it is an array, and the key table has a surrogate id with a unique index on (client, key); `migrate-cli draft` reports
  no difference.
* **Production bundle** (`npm run build`; fresh database by `dist-server/init-db.cjs`, 16 migrations including 0140; demo seed; server on
  127.0.0.1:3105): `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**, run again with an
  `api_clients` row present (jsonb scopes, foreign keys to the service account): 18 PASS. Smoke with curl: client created with a signature,
  `GET /v1/samples` 200, a write without the scope 403 problem+json, the token on `POST /samples/:id/transition` 403, docs page served with the CSP.
* **Desktop** after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* **Browser** (Chromium, production bundle): the API Clients entry is in the navigation; create with the signature dialog, the token is
  shown once, the new token gets 403 outside its scope, revoke with the signature dialog shows Revoked and the token then gets 401; no
  script error (`scratchpad/r2api-screen.png`, `r2api-token.png`, `r2api-docs.png`).

## Re-verification (2026-10-20, 12:00 UTC, fresh simulation `scratchpad/r2api-sim2`)

The shared tree had moved since the first evidence (r2-raw-data's files and gate patch; r2-events in progress). A new simulation was built
from `git archive HEAD` + every untracked file except r2-events' (`*events*`, `0150_*`) + r2-raw-data's patch + this track's patch + the three
regenerations. Findings and results:

* The old patch no longer applied after r2-raw-data's (`routes/index.ts`, `routeTable.ts`, `schema/index.ts`: adjacent added lines). It was
  re-cut on top of r2-raw-data's patch; the added and removed lines are identical to the old patch (only context changed). Checked:
  HEAD + r2-raw-data's patch + this patch apply with plain `git apply`.
* Regenerations: `tests/route-table.json` (+3 api-clients routes beside raw-data's 7), `docs/permission-matrix.csv` (70 permissions with
  raw-data's), `desktop/schema.sql`. The dump and the matrix export need `JWT_SECRET` and `LIMS_MASTER_KEY` set (the keystore refuses to
  start without a key of 16 characters); without them the dump writes an empty file.
* `npx vitest run`: 109 files, 1355 passed, 3 skipped; the only 2 failures were in `auth-keystore.test.ts` and were caused by my shell
  exporting `LIMS_MASTER_KEY` and a `JWT_SECRET` into the run. With only the `SQL_*` variables set, that file, both api-v1 files and the
  upgrade suite pass: 14 files, 95 tests, 0 failed.
* `npm run lint`: exit 0. `openapi-cli.ts check`: "The contract of /api/v1 is current." (also in the shared tree).
* `npm run build`; fresh database; `dist-server/init-db.cjs` (17 migrations: ... 0120_raw_data, 0140_api_v1, 0180_qms); demo seed; bundle on
  127.0.0.1:3105: `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL** (second fresh database,
  `SERVER_BACKUP_DIR` set to the server's backup directory). Smoke: `/api/v1/openapi.json` 200, `/api/v1/docs/` 200, `/api/v1/samples` without
  a token 401 problem+json, an unknown `lims_` token on `/api/samples` 401 `INVALID_TOKEN`.
* Desktop after the build: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* Shared tree without the patch: `api-v1-openapi.test.ts` 7 of 9 pass (the 2 others need `/api/v1` mounted), as stated above.
* Migration number: this run's task text reserves 0150 to 0159 for this track, but the roadmap reserves 0140 for the API and 0150 for
  r2-events, and `drizzle/0150_events.sql` (r2-events) is already in the tree. Renumbering to 0150 would collide, so 0140 is kept.

## Re-verification after the W2 commit (2026-10-20, 22:27 UTC)

The track was merged by the R2 W2 gate (`docs/changes/r2-w2-gate.md`) and committed in `fedb5f0`; none of its files have changed since.
On a clean `git archive HEAD` (scratchpad `r2api-head`, database `lims_r2_api_v1`): `api-v1.test.ts` and `api-v1-openapi.test.ts`
24 passed, 0 failed; `openapi-cli.ts check`: current. In the shared tree, `openapi-cli.ts check` is also current, but both test files stop
at `createApp`: `assertRouteContract` refuses the in-flight W3 training routes (`/training/assignments*`, `/training/qualifications*`)
that have no route-table rule yet. That belongs to the W3 track that owns them and its gate patch, not to this track.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: migration number 0140 (roadmap range) instead of the task's 0150 to 0159;
existing integration permissions and the existing `ADMIN_AUTHORISATION` meaning for clients; token validity at most 365 days and no renewal;
machine entry is first entry only and never replaces an OOS value; an Idempotency-Key on every write and kept indefinitely; the `Instrument`
service-account role; the public contract and docs page; the default audit reason of machine entries; session tokens refused on `/api/v1`.

## Needs from other tracks

* **Gate**: the patch and the three regenerations above.
* **r1-results-oos (`src/server/routes/samples.ts`)**: `GET /api/samples` builds its cursor from a JavaScript `Date` (milliseconds), but rows
  registered in one transaction share `created_at` to the microsecond, so the next page skips them. Reproduced in the simulation: a bulk
  import of 4 samples paged with `limit=1` returns 1 sample and no further page. `/api/v1/samples` carries the timestamp as microsecond text.
* **r2-ui-foundation (`routes/lookup.ts`)** and **r1-identity (`AdminPanel.tsx`, `routes/training.ts`)**: service accounts (role `Instrument`,
  name `API client: ...`) appear in user pickers (OOS assignee), the user list and the training matrix. They should be filtered out of
  pickers, and the role dropdown should not offer to change an `Instrument` account (if it is changed, the token stops working, by design).
* **r2-raw-data / r2-instrument-integration**: `results:batch` takes no raw file; the record of the instrument's raw data with a
  machine-entered value (the GxP risk named by M22) belongs to the raw-data store and the instrument integration that builds on this API.
* **r1-audit (`audit/securityEvents.ts`)**: `API_TOKEN_REJECTED` is a new event type (the writer accepts any upper-case code); add it to
  `SECURITY_EVENT_TYPES` if that list is meant to be complete.
* **r2-validation**: URS/OQ/RTM entries for M22 (token issue and revocation, scopes, refusal outside v1, batch atomicity, idempotency, contract
  check). Nothing was approved or signed.

## Not done

* No webhooks or event subscriptions (not part of M22's design here; r2-events).
* No raw-file upload with results (see above), no `GET` of results outside a sample, no configurable per-client rate limit (the per-token
  budget is the general per-bearer limit, 600 per minute by default).
* Idempotency rows are never purged (small; a retention job is a decision, see above).
* The OpenAPI document is checked by the repository's structural validator, not by the official OpenAPI 3.1 JSON Schema: no validator
  package is available in this offline build, and adding one is a dependency decision.
* **Scratch directory incident**: when the simulation was first set up, this track deleted an existing `scratchpad/sim` directory and
  overwrote `scratchpad/sync.sh`, assuming they were its own. They may have belonged to an earlier track or to r2-raw-data's simulation;
  only scratch copies were affected (nothing in the shared tree), and this track's own copies were removed from `sim` again. All later work
  used `r2api-` names.
