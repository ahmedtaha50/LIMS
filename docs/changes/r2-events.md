# r2-events: transactional outbox, persistent notifications, authenticated sockets, signed webhooks, e-mail and file sinks (roadmap M23)

Release R2, second wave (beside r2-raw-data, r2-api-v1 and r2-audit-tamper). Branch `claude/project-implementation-tirr4j`. My changes are
not committed; the wave gate commits them. This is a resumed track: an earlier attempt had written the catalog, `emitEvent`, the HMAC
helpers, the SSRF guard, the schema, migration 0150 and the four test files. I reviewed those, kept them (one catalog change, below) and wrote
the rest. Companion file: `docs/changes/r2-events.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** All three M23 acceptance criteria pass in a gate simulation (`git archive HEAD` +
every untracked file except r2-audit-tamper's + r2-raw-data's patch + r2-api-v1's patch + this patch + the three regenerations; scratchpad
`r2events-sim`). In the shared tree without the patch, the routes are not mounted and `saveResult` still broadcasts, so the route-level
tests fail with 404 (that shows the wiring is missing; it is not a defect).

## What changed

| Area | Files (owned by this track) |
|---|---|
| Migration (forward-only, additive) | `drizzle/0150_events.sql`: `outbox_events`, `notifications`, `event_subscriptions`, `event_deliveries`. No existing table or row is changed; no permission or signature meaning is added |
| Schema | `src/db/schema/events.ts` |
| Event catalog | `src/server/events/catalog.ts`: `result.oos_detected`, `batch.released`, `instrument.calibration_due`, `system.alert`, each versioned, with a strict payload schema, an audience permission and the notification text |
| Outbox | `src/server/events/emit.ts`: `emitEvent(tx, ...)` inserts the outbox row in the caller's transaction and checks the payload against the catalog (an unknown key, such as a result value, fails the business transaction) |
| Dispatcher | `src/server/events/dispatcher.ts`: `dispatchOnce` (fan-out with `FOR UPDATE SKIP LOCKED`, then one attempt per due delivery per pass, under a lease) and `startDispatcher` (every 5 s and at once after a commit) |
| Sinks | `src/server/events/sinks/webhook.ts` (HMAC-signed POST, connects to the address the SSRF guard checked, no redirects), `email.ts` (small SMTP client: STARTTLS by default, AUTH PLAIN only over TLS), `file.ts` (temp file, fsync, atomic rename to `<event id>.json`) |
| Security helpers | `src/server/events/ssrf.ts` (deny by default, LAN allow-list, link-local/metadata/multicast/reserved always refused, IPv4-mapped IPv6 handled), `hmac.ts` (`X-LIMS-Signature: t=..,v1=..`, constant-time verify, timestamp tolerance) |
| E-signature | `src/server/events/entities.ts`: `EventSubscription` is a signable record type |
| Sockets | `src/server/realtime.ts`: `io.use` authentication with the session token, per-user rooms, periodic revalidation that disconnects ended sessions |
| Routes | `src/server/routes/notifications.ts` (`GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`), `src/server/routes/subscriptions.ts` (list, create signed, status signed, deliveries, requeue audited) |
| Scheduled job | `src/server/jobs/handlers/events.ts`: `calibration.due`, daily scan that emits `instrument.calibration_due` once per due date (within 30 days) and once more when overdue |
| Screens | `src/components/NotificationBell.tsx`: the bell (unread count, persistent list, mark read, live push, toast) and the Administrators' `EventSubscriptions` screen |
| Tests | `tests/api/events-outbox.test.ts` (9), `events-subscriptions.test.ts` (12), `events-calibration.test.ts` (2), `events-ui.test.ts` (3), `tests/unit/events/guard.test.ts` (5) |

### Behaviour

* **Outbox.** A business change writes its event with `emitEvent(tx, ...)` in its own transaction. A change that rolls back leaves no row,
  so nothing is announced that did not happen. The old code emitted the OOS socket message after COMMIT but to **every** socket, including
  unauthenticated ones. Now nothing is broadcast to all sockets.
* **Fan-out.** For each committed event the dispatcher writes one `notifications` row for every active user whose role holds the event's
  audience permission when the fan-out runs (`'*'`: every active user of a role in the matrix; service accounts and the scheduler principal
  hold no matrix role). It also writes one `event_deliveries` row for every Active subscription to the type. After COMMIT each new
  notification goes only to the socket room `user:<id>` of its user. A user who was offline sees it at the next sign-in (`GET /notifications`).
* **Deliveries.** Each pass makes one attempt per due delivery. A failure is retried with back-off (30 s, 2 min, 10 min, 30 min, 2 h);
  after `max_attempts` = 6 attempts (the first try and 5 retries) the delivery is `dead`. An Administrator can requeue a dead delivery with a
  reason and the version (audit `Requeue` on `EventDelivery`). The attempt counter keeps the true total, and the requeue grants 6 more.
  Every attempt carries the same `X-LIMS-Event-Id`, so a receiver can drop a duplicate after a crash between the attempt and its record.
* **Webhook.** The body is `{ id, type, version, occurredAt, entity, entityId, data }` and the header is `X-LIMS-Signature: t=<s>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
  The secret is 32 random bytes. It is shown once and stored as keystore ciphertext bound to the subscription id, and
  `admin-cli rotate-keys` now moves it to the current key generation. Only its fingerprint (16 hex digits of SHA-256) is listed.
  The destination is checked at creation and again before every attempt, against the address actually connected to (DNS rebinding).
  A 3xx is a failed attempt and is never followed.
* **SSRF guard.** Deny by default. `EVENTS_WEBHOOK_ALLOWLIST` (addresses and CIDR ranges) must contain every address the host resolves to.
  `0.0.0.0/8`, `169.254.0.0/16`, multicast, `240.0.0.0/4`, `::`, `fe80::/10`, `ff00::/8` and `fd00:ec2::254` are refused even when the list
  would admit them (so `0.0.0.0/0` cannot open the metadata service). The URL must be http(s) and must not carry credentials. A malformed
  list stops the server at start-up (config.ts, gate patch).
* **E-mail / file.** E-mail needs `EVENTS_SMTP_HOST` and `EVENTS_SMTP_FROM` (otherwise creation is 400). The text is the notification's,
  with the event id and a sentence saying it is not a GxP record. A file subscription needs `EVENTS_DROP_DIR`, and its folder is a single
  name inside it.
* **Subscriptions.** Create, disable and re-enable are e-signed through `signRecord` (ADMIN_AUTHORISATION, record type
  `EventSubscription`, bound to version 1, 2, ...). Each one writes its audit entry in the signing transaction, and a stale version is 409.
  Sink, target, event types and secret never change after creation. A disabled subscription gets no new deliveries, and its pending ones
  wait. Permissions are the existing `admin.integrations.view` / `admin.integrations.manage` (Admin only).
* **Sockets.** `io.use` needs `auth.token`. It applies the checks of `requireAuth` (signature and purpose, live session, not revoked, not
  expired, not idle, active user, no pending password change) without touching the session. A socket does not count as activity. Any
  refusal is `UNAUTHORIZED: <why>`. Every 30 s the sessions of open sockets are checked again, and a revoked, expired or idle session, or a
  deactivated user, is disconnected by the server. The client opens the socket with the current token and closes it while the screen is locked.
* **Notifications** are the user's own (`self` routes, another user's id is 404). `read_at` is written once and never cleared.
* **Catalog change** from the earlier attempt: `batch.released` carried `signatureId`, which does not exist yet inside the signing
  transaction. It now carries `{ batch, releaseId }` (the `batch_releases` row) and is emitted in the signature's transaction.

## Why

M23: `io.emit('notification')` went to every socket, sockets were unauthenticated (SEC-11), nothing was persisted (a user who was away
never saw an OOS), toasts disappeared after 5 s, and there was no outbound integration. GxP risk named by the roadmap: notifications are not
GxP records and never replace a signature (the UI and the e-mail say so), subscription changes are e-signed and audited, and payloads
exclude result values (strict schemas, tested).
`synth.topDefects`: none falls inside this track's files. The socket broadcast and the unauthenticated socket were the in-scope defects
(M23 evidence), and both are fixed.

## For the gate

1. Apply `r2-raw-data.gate.patch`, then `r2-api-v1.gate.patch`, then `git apply docs/changes/r2-events.gate.patch`, and delete the patch.
   It is cut on top of the other two (checked: HEAD + the two patches + this one apply with plain `git apply`). It changes:
   * `server.ts` (r1-core): `createRealtime(httpServer, { db })`, and `startDispatcher(db, { io })` after `initRabbitMQ()`.
   * `src/server/routes/index.ts`: `notificationsRoutes`, `subscriptionsRoutes`.
   * `src/server/authz/routeTable.ts` (r1-authz): `GET/POST /notifications...` as `SELF` (no body); the five subscription routes on
     `admin.integrations.view` / `.manage` with the routes' strict schemas as `body`. No new permission code.
   * `src/db/schema/index.ts`: `export * from './events'`.
   * `src/server/services/saveResult.ts` (r1-results-oos): `emitEvent(result.oos_detected)` in the transaction instead of the
     after-commit broadcast. The `io` argument stays in the interface, unused, so the three callers need no change.
   * `src/server/routes/admin.ts` (r1-identity): the broadcast writes `system.alert` with its audit entry instead of `io.emit`.
   * `src/server/routes/release.ts` (r1-results-oos): `batch.released` inside the signing transaction.
   * `src/components/Layout.tsx` (r2-ui-foundation): the socket effect, which connected without a token and would now be refused, is
     replaced by `<NotificationBell />` in the header.
   * `src/components/shell/ext/event-subscriptions.tsx` (new): the shell entry, `adminOnly`.
   * `src/server/jobs/handlers/index.ts` and `src/server/schedules/index.ts` (r1-backup-jobs): job and daily schedule `calibration.due` (06:15).
   * `src/server/crypto/rotate.ts` (r1-identity): webhook secrets are re-encrypted with the others (`webhookSecrets` in the report).
   * `src/server/config.ts` and `.env.example` (r1-build-shell): the eight `EVENTS_*` variables (the SMTP password is marked secret).
   * Tests of other tracks: four assertions that counted `io.emit('notification')` now count the outbox row, with payload and actor
     (`results-entry`, `auth-lifecycle`, `occ`, `api-v1`). They check the same thing (announced once, by the committed write) more strictly.
     `results-entry` also asserts that nothing is broadcast. No assertion was removed.
2. Regenerate (with `JWT_SECRET` and `LIMS_MASTER_KEY` set, or the dump is empty): `NODE_ENV=test npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json`
   (8 routes added by this track), `npx tsx scripts/authz/export-matrix.ts` (70 permissions; the integration rows list the new routes),
   `npx tsx src/server/boot/migrate-cli.ts export-schema` (adds 0150).
3. Migration 0150 sorts before the already applied 0180. A development or gate database built from the R2 W1 tree is refused with
   `OUT_OF_ORDER` and must be rebuilt (fresh installs and v0.1.0 upgrades are fine, as for 0120 and 0140).

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/unit/events tests/api/events-ui.test.ts tests/api/events-calibration.test.ts   # pass in the shared tree
# after the gate steps:
npx vitest run tests/api/events-outbox.test.ts tests/api/events-subscriptions.test.ts               # 21
npx vitest run && npm run lint
```

## Evidence (2026-10-20, gate simulation `scratchpad/r2events-sim`)

* **Test first.** Before this session's implementation, the three files that need the server could not load (`src/server/events` and
  `NotificationBell` did not exist), and only the guard unit test (written with the SSRF/HMAC modules) passed. Against the old behaviour:
  with HEAD's `realtime.ts` the outbox file has 4 of 9 tests red (unauthenticated sockets accepted, no rooms). With the old `saveResult`,
  3 tests in `events-outbox` + `results-entry` are red (no outbox row, broadcast to every socket). In the shared tree (no wiring) the new
  "rolled-back OOS result" test is red, because no outbox row is ever written. The key-rotation test was red until `rotate.ts` learned the
  webhook secrets.
* **Acceptance (M23)**:
  1. *A rolled-back result produces no outbox row and no socket message*: `saveResult` with an OOS value inside a transaction that then
     fails writes its outbox row in the transaction (checked inside it). After the rollback there is no outbox row and no investigation, and a
     connected QA socket receives nothing after a dispatcher pass. The same holds for a bare `emitEvent` that rolls back.
  2. *A webhook returning 500 three times then 200 receives the event once with a valid HMAC and 4 attempts*: 4 requests, the last
     verifies with the secret shown at creation (a wrong secret and a tampered body do not verify), the same `X-LIMS-Event-Id` on all 4, and
     the delivery is `delivered`, `attempts` 4, `last_status_code` 200. A receiver that never succeeds is `dead` after 6, and a requeue
     (Admin, audited, 409 on stale version, 403 for QA) delivers it.
  3. *A user offline during an OOS sees it at next login; an unauthenticated socket is rejected; 169.254.169.254 is refused*: notification
     listed at the next sign-in, marked read, another user's is 404. Sockets without a token, with a malformed or forged token, with a revoked
     session or with a deactivated user are refused with `UNAUTHORIZED`, and an open socket is disconnected when its session is revoked.
     `http://169.254.169.254/...` is 400 at creation even with `EVENTS_WEBHOOK_ALLOWLIST=0.0.0.0/0`. Outside-the-list, credentials in the
     URL, `ftp:` and `file:` are 400, and a destination no longer allowed at delivery time is not contacted.
* **Mutation checks** (each must turn a test red): handshake refusal removed (1 red), revalidation removed (1), push to all sockets instead
  of the user's room (1), audience permission ignored (1), dead-letter never reached (1), SSRF check skipped at delivery (1), wrong HMAC
  key (2), 3xx counted as success (1), payload schema check removed (1), calibration de-duplication removed (1), notification read without
  the owner check (1). Two survived the first round (handshake refusal, payload check), so I added the revoked-session/deactivated-user
  handshake test and made the payload assertion exact. Both are red now.
* **Whole suite** in the simulation, final run with the patch as cut: 112 files passed (2 skipped, opt-in scale tests),
  **1386 passed, 3 skipped, 0 failed**. Migration suite (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed. `npm run lint`:
  web clean; server 18 known baseline errors, none new.
* **Production bundle** (`npm run build`; fresh database by `dist-server/init-db.cjs`, 18 migrations including 0150; demo seed; server
  on 127.0.0.1:3106): `tests/security-controls.sh` **34 PASS, 0 FAIL**. Smoke run with a real receiver: unauthenticated socket refused,
  authenticated socket receives the admin broadcast, webhook delivered once with a valid HMAC, 169.254.169.254 refused, an offline
  reviewer finds the alert at sign-in. Then `tests/backup-restore.sh` **18 PASS, 0 FAIL** with event rows present.
* **Desktop** after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* No browser session was run: the bell and the subscriptions screen are covered by server-side rendering tests only.

## Decisions that need confirmation

See `decisionsForUser` in the structured report.

## Needs from other tracks

* **Gate**: the patch and the three regenerations above.
* **r2-validation**: URS/OQ/RTM entries for M23. Nothing was approved or signed.
* **r2-oos-workflow, r2-em, r2-instrument-integration, r2-audit-tamper, r2-stability**: further event types (OOS phase changes, EM
  excursion, audit-chain failure, stability pull due) are one catalog entry plus one `emitEvent` call in the owning track's transaction.
* **r1-audit**: no new security event type. Socket refusals are not recorded as security events (there would be one per reconnect); say if they should be.

## Not done

* No browser run of the bell and the subscriptions screen.
* No retention or purge of `outbox_events`, `notifications` and `event_deliveries` (see decisions).
* Socket rooms are per user, not per permission. The permission is applied when a notification is created for a user.
* Webhook TLS uses the system trust store only (no pinned or private CA option); an internal CA needs `NODE_EXTRA_CA_CERTS`.

## Resumption check (2026-10-20, after the W2 gate)

A workflow run relaunched this track as "resumed". There was nothing to resume: the W2 gate had already applied
`r2-events.gate.patch` and committed the track in `fedb5f0`, and `git status` shows no uncommitted change in any file this track owns.
No code, migration or test was changed in this run. The track's migration stays `drizzle/0150_events.sql` (the roadmap gives this track
`drizzle/015*`). The relaunch prompt named 0160 to 0169, but no migration was added, because the forward-only 0150 is already shipped.

* On committed HEAD (`git archive HEAD` in a scratch folder, database `lims_r2_events`):
  `npx vitest run tests/unit/events tests/api/events-ui.test.ts tests/api/events-calibration.test.ts tests/api/events-outbox.test.ts tests/api/events-subscriptions.test.ts tests/api/results-entry.test.ts`
  gives 6 files, **43 passed, 0 failed**.
* In the shared working tree the same run fails before any events assertion. `createApp` refuses to start because the 10
  `/training/...` routes that r2-docs-training adds in progress are not yet in `routeTable.ts` (that track's gate patch). This is
  not an r2-events defect, and it goes away when that patch is applied.
