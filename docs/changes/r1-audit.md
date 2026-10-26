# r1-audit: audit v2, scalable verification, queries and export, security events, history UI (roadmap M08)

Release R1, wave 2. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.

Status: **partial**. Three of the four acceptance criteria are met and tested here. The first ("`/signatures/verify` in under 300 ms with under 50 MB at 1M rows") is met by the verifier this track delivers, measured at 1M rows through the route with the one-hunk change in `routes/signatures.ts` applied to an integration copy; the route itself belongs to r1-esign and still runs its own whole-table loop in the shared tree (see "Integration for the gate", item 5).

## What changed

| Area | Files |
|---|---|
| Migration | `drizzle/0030_audit_v2.sql`: seven additive columns on `audit_trail`, two indexes, tables `audit_checkpoints` and `security_events` (both append-only, triggers from the registry) |
| Schema and protections | `src/db/schema/audit.ts`, `src/db/protections/audit.ts` (the two new tables' triggers are skipped while the table does not exist, so a backup of an older version can still be restored into that version's schema) |
| Writer | `src/db/utils.ts` `writeAudit`: actor snapshot, session, app version, `hash_version` 2, seal, checkpoint at every 5,000th sequence. Same signature, same transaction, same advisory lock (7001). New `lockAuditChain(tx)` |
| Hash formulas and verifier | `src/server/audit/hash.ts` (pure), `src/server/audit/chain.ts`: `verifyAuditRows` (in memory), `verifyAuditChain` (whole chain, keyset batches, records proven checkpoints), `verifyAuditChainTo` (from the nearest checkpoint) |
| Reads and export | `src/server/audit/query.ts`, `schemas.ts` (strict Zod), `access.ts`, `src/server/routes/audit.ts`: `POST /audit/verify`, `GET /audit/head`, `GET /audit` (filters, cursor), `GET /audit/history`, `POST /audit/export` (streamed CSV) |
| Security events | `src/server/audit/securityEvents.ts`, `src/server/routes/security-events.ts` (mounted by `routes/audit.ts`): `GET /security-events`, `/security-events/types`, `POST /security-events/verify`; writer `recordSecurityEvent(db, ...)` (own transaction) and `writeSecurityEvent(tx, ...)` |
| Session context | `src/server/audit/context.ts`: `auditContext` middleware, `setAuditSessionId`, `currentSessionId` |
| Activity aggregate | `src/server/audit/activity.ts`: `activityHeatmap(db, timeZone)`, counts of real rows by role and hour (SQL `GROUP BY`, no invented workload) |
| UI | `src/components/AuditTrail.tsx` (filters, Reason column, field diff, actor name and role, load-more, verify summary, export with reason, "Security events" tab), `RecordHistory.tsx` (the History tab of one record, plus the shared paging hook and `FieldDiff`), `SecurityLog.tsx` |
| Tests | `tests/api/audit-chain.test.ts` (30), `audit-routes.test.ts` (21), `audit-security-events.test.ts` (15), `audit-scale.test.ts` (2, opt-in) |
| Outside the track's file list, on purpose | `desktop/schema.sql` regenerated (the documented step 4 of writing a migration, and what keeps `tests/backup-restore.sh` restoring); `tests/backup-restore.sh`, one assertion (see "Shared checks") |

### How a row is protected now

Every audit row keeps the **link** it always had: `hash = SHA-256(JSON{sequence, timestamp_str, userId, action, entity, entityId, field, oldValue, newValue, reason} + prevHash)`. Rows written by this release (`hash_version` 2) add a **seal** over the new columns, chained to the previous seal: `seal = SHA-256(JSON{v:2, ...link fields, actorName, actorRole, sessionId, appVersion, hash} + prevSeal)`, where `prevSeal` is the previous row's seal, or its hash when that row is a v1 row. `hash_alg` names the algorithm for both.

Why a second chain instead of changing the link: the same verification loop was copied into `routes/signatures.ts`, `routes/traceability.ts` and `backup.ts`, and `tests/security-controls.sh` (GX-08) and the backup check run them. A changed link formula would make every one of them report a tamper alarm on the first new row. With an unchanged link they keep working (tested: "a v2 row keeps the v1 link hash", GX-08 passes), and they get stronger when they delegate to the shared verifier. v1 rows are never rewritten: the new columns read `hash_version` 1, `hash_alg` 'sha256', no seal, and the 30 rows of the v0.1.0 fixture still verify.

Verification outcomes: `LINK_BROKEN`, `SEAL_BROKEN`, `CHECKPOINT_MISMATCH`, `UNSUPPORTED_ALG`, `UNSUPPORTED_VERSION` (a row it cannot check is reported, never skipped), `ENTRY_NOT_FOUND` (bounded check of an entry that does not exist).

A **checkpoint** is `(sequence, hash, seal)` of the row at every 5,000th sequence, written by `writeAudit` in the same transaction as that row, and by a full verification for every multiple it has proven (on an installation that already has history). `verifyAuditChainTo` finds the nearest checkpoint at or below the entry, checks that the audit row at that sequence still has the hash and seal the checkpoint recorded, and verifies only the rows after it (at most 5,000). `verifyAuditChain` always starts at the first row and is what proves the part before a checkpoint.

## Why

Findings addressed (roadmap M08, `synth.topDefects`):

* "GET /audit returns the whole table": now keyset pages, filters, a hard limit of 500.
* "The verifier loop exists in 5 places; every /signatures/verify loads and re-hashes all rows": one verifier; at 200,000 rows the old signature check took 3.0 s and 769 MB, at 1,000,000 rows the new one takes 0.1 s and under 15 MB (numbers below).
* "POST /audit/verify registered twice": already removed by r1-core; a test now pins one registration, Admin/QA only.
* "Rows carry userId only, with no name, role or app version": snapshot columns, stamped by the writer from the user row.
* "Logins, lockouts and exports are not audited": `security_events` chain; the export writes an audit entry (who, why, filter, through which sequence) and an `EXPORT` event; a verification writes `AUDIT_VERIFY`. The sign-in side is wired by r1-identity, which already calls `recordSecurityEvent` / `writeSecurityEvent` from `src/server/auth/events.ts`.
* "The UI hides the reason column": the Reason column is on the screen next to the change, with the actor's name and role.
* "Math.random heatmap padding": removed by r1-identity in `routes/admin.ts`; `activityHeatmap` is the bounded-memory replacement for its in-memory loop (optional swap).

## Deliberate behaviour changes

1. `GET /api/audit` answers `{ entries, hasMore, nextCursor }` instead of `{ total, entries }`, newest first, 50 per page (max 500). Unknown query parameters are 400. `GET /api/audit/head` is unchanged.
2. `POST /api/audit/verify` also answers `reason`, `headSequence`, `headHash`, `versions`, `checkpointsAdded`, `verifiedAt` (the fields `isValid`, `compromisedSequence`, `totalRecords` are unchanged), takes an empty strict body, and records an `AUDIT_VERIFY` security event. `totalRecords` counts the rows examined.
3. New: `GET /api/audit/history` (Admin, QA, Reviewer), `POST /api/audit/export` (Admin, QA), `GET /api/security-events`, `GET /api/security-events/types`, `POST /api/security-events/verify` (Admin, QA).
4. Audit rows written from now on carry the actor snapshot and seal; the audit timestamp column now holds the same instant as `timestamp_str` (it used to be the transaction start).
5. `tests/backup-restore.sh` counts the append-only triggers of the restored database against the source database (8 since this track: `audit_trail`, `audit_checkpoints`, `security_events`, `signatures`, two triggers each) instead of the literal 4, and requires at least 4.

## How to verify

```
# this track's tests (needs PostgreSQL and a role that may CREATE DATABASE)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r1_audit npx vitest run tests/api/audit
# the scale evidence (about one minute of set-up; AUDIT_SCALE_ROWS=100000 shows the shape)
AUDIT_SCALE_ROWS=1000000 npx vitest run tests/api/audit-scale.test.ts
# shared checks against a server built from this tree (HOST=127.0.0.1 PORT=3104)
BASE=http://127.0.0.1:3104/api tests/security-controls.sh    # 34 PASS, as before
BASE=http://127.0.0.1:3104/api tests/backup-restore.sh       # 13 PASS (12 before, plus the source-database trigger floor)
```

### Acceptance

| Criterion | Evidence |
|---|---|
| With 1M rows, signature verification in under 300 ms with under 50 MB | `audit-scale.test.ts` at 1,000,000 generated rows (chain built inside PostgreSQL, then proven by a full verification, 17.4 s, 200 checkpoints): `verifyAuditChainTo` for an entry 4,900 rows past a checkpoint, median **83 ms**, peak allocation **14.5 MB**. Through `GET /api/signatures/verify/:id` with the delegation hunk of `docs/changes/r1-audit.gate.patch` applied (integration copy): median **103 ms**, peak **7.7 MB**. The same route with the old whole-table loop at only 200,000 rows: median **3,016 ms**, peak **769 MB**. |
| Analyst gets 403 on POST /audit/verify, exactly one handler | `audit-routes.test.ts`: Analyst and Reviewer 403, no token 401, Admin and QA 200; the app's route table holds `POST /api/audit/verify` once, behind `requireAuth` |
| `GET /audit?entity=Sample&entityId=X` pages by cursor, a pre-upgrade v1 chain still verifies | `audit-routes.test.ts`: 120 rows in pages of 50 with an entry added between two page requests (no repeat, no gap); `audit-chain.test.ts`: v1 chains built with the old formula, mixed v1/v2 chains, snake_case rows; a row written with the old writer's column list verifies through the route; `upgrade-v0.1.0` (30 rows, 5 signatures) passes with the gate patch |
| A scripted login failure, lockout and logout each create one security event | `audit-security-events.test.ts` last test (it runs by itself once the sign-in code uses `src/server/audit/securityEvents.ts`; it did not run in the integration copy, it **does run and passes in the shared tree** now that r1-identity's `auth/events.ts` re-exports it). Writer, chain, own-transaction durability, routes and tamper detection are tested independently of it |

### Test-first evidence

The four test files were written before any implementation and run on the unmodified code (`git archive HEAD` plus the tests): **18 failed, 2 passed**, and three files could not load because the modules did not exist (44 tests not run). The two that passed are characterisations of what r1-core already fixed (one verify handler; `GET /audit/head`). Typical old behaviour: `GET /audit/history` and `POST /audit/export` answered 404; the verify answer had no `reason`; the heat-map and security-event modules did not exist.

Mutation checks (change the code, the named test must fail): ignoring the seal fails 3 tests (changed actor name, lost seal, rewritten snapshot); trusting a checkpoint without comparing its row fails "a checkpoint whose row was altered"; removing the spreadsheet-formula guard fails the CSV test; using unguarded `appendOnlyTable` for the new tables fails "the registry can be applied to a schema that lacks the newer tables" (the failure that otherwise breaks restoring an old backup).

### Whole suite

Shared tree (`npx vitest run`, including r1-identity's work in progress): 330 pass, 12 fail, 2 skipped. **Nine** of the failures are caused by this track and are fixed by the gate patch plus the route table; the other three are r1-identity's work in progress (`server-start`, `system-info` x2). This track's own 66 tests pass; the 2 skipped are the opt-in scale file.

| Failing test | Why | Fix |
|---|---|---|
| `tests/unit/core/route-table.test.ts` | five new routes | regenerate `tests/route-table.json` |
| `tests/upgrade/boot.test.ts` x2, `protections.test.ts` x2, `upgrade-v0.1.0.test.ts` x4 | they pin "4 triggers", "exactly the v0.1.0 statements", "upgraded to 0003_indexes", the v0.1.0 table list and the exact column set of an audit row | `docs/changes/r1-audit.gate.patch` makes them follow the registry and the migration list (and check that the new audit columns hold only their defaults on old rows) |

Integration copy (`git archive HEAD` + this track + the gate edits, own database): 265 pass, 3 skipped (the opt-in scale file and the sign-in test, which needs r1-identity's code), 0 fail. `tsc` of the web project and the server baseline check show no error in this track's files.

## Integration for the gate

Ordered by importance. Mechanical items first.

1. **`tests/route-table.json`** (r1-core): add `POST /api/audit/export`, `GET /api/audit/history`, `GET /api/security-events`, `GET /api/security-events/types`, `POST /api/security-events/verify`, all `auth: true`. `NODE_ENV=test JWT_SECRET=x SQL_HOST=x SQL_USER=x SQL_PASSWORD=x SQL_DB_NAME=x npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (without `--stdout` the script fails under `tsx` with `__dirname is not defined`).
2. **`desktop/schema.sql`** (r1-migrations): `npx tsx src/server/boot/migrate-cli.ts export-schema` once the last migration of the wave has landed (regenerated here for the migrations that exist now, 0010 and 0030).
3. **`git apply docs/changes/r1-audit.gate.patch`**, then delete the patch. Hunks: `tests/upgrade/{boot,protections,upgrade-v0.1.0}.test.ts` (r1-migrations, required), `src/server/backup.ts` `verifyAuditChain` delegating to `verifyAuditRows` (r1-backup-jobs), `src/server/routes/signatures.ts` (r1-esign), `src/server/routes/traceability.ts` verify-chain (r1-quality-fixes).
4. **`src/server/app.ts`** (r1-core): `app.use('/api', auditContext)` from `./audit/context`, **after** `express.json()` (a context opened before the body is read is lost when the parser's stream callbacks run) and before the routes. r1-identity's `requireAuth` already calls `setAuditSessionId(session.id)`; without the middleware the session column simply stays null.
5. **`src/server/routes/signatures.ts`** (r1-esign): the signature check must call `verifyAuditChainTo(db, { id: signature.auditEntryId })` instead of re-hashing the table (hunk in the patch; an entry that does not exist, such as a legacy signature whose entry id is 'N/A', is `ENTRY_NOT_FOUND`: the hunk keeps the old whole-chain check for those, r1-esign decides how to show them). This is what makes acceptance 1 true for the route.
6. **UI mounts**: `<RecordHistory token entity entityId related />` as a History tab in `SampleDetail.tsx` (entity `Sample`, `related` = the sample's results, `{ entity: 'Result', entityId }`) (r1-results-oos), ELN, Specifications, OOS, Instruments (r1-spec, r1-quality-fixes). Reviewers see it for data records, not for accounts or settings.
7. **`routes/admin.ts`** (r1-identity), optional: `res.json(await activityHeatmap(db, Intl.DateTimeFormat().resolvedOptions().timeZone))` replaces the loop that reads the whole audit table into memory.
8. **r1-authz**: replace the three role checks in `src/server/audit/access.ts` usage by permission codes (read, history, export, verify) and write `AUTHZ_DENIED` security events (`recordSecurityEvent(db, { type: 'AUTHZ_DENIED', outcome: 'denied', ... })`); r1-identity or whoever changes settings: `CONFIG` events.
9. **Run once after upgrading an installation that has history**: Admin or QA presses "Verify Cryptographic Integrity". Until then there are no checkpoints and a bounded verification starts at the first row (as long as a full one). `src/server/jobs` (r1-backup-jobs) should schedule it.
10. `node scripts/typecheck-server.cjs --update`: the baseline now has entries that no longer occur.

Locks: audit chain 7001 (`AUDIT_CHAIN_LOCK`), migration runner 7002, security events 7003, identity bootstrap 7010. A transaction that writes both an audit entry and a security event writes the audit entry first.

## Decisions that need confirmation

1. **Second chain for the seal** instead of changing the link formula (reason above). Cost: two SHA-256 per row. When the three copies of the loop are gone the link could move to a keyed hash (roadmap M35) without touching old rows.
2. **Checkpoints are system bookkeeping**, not signed records: written inside `writeAudit` and by a full verification, not themselves audited. The full verification, not the checkpoint, proves history.
3. **Who may read the history of one record**: Admin, QA and Reviewer; a Reviewer is refused for `User`, `SystemSettings`, `System`, `SYSTEM_MIGRATION` and `AuditTrail`. Analysts have no access, as for `GET /audit`. Reading the audit trail is not itself recorded.
4. **An export needs a reason** (3-500 characters), is streamed (memory is flat), covers rows up to the head at the time of the request, writes an `Export` audit entry and an `EXPORT` security event first, and prefixes any cell starting with `= + - @` or a tab/return with an apostrophe so a spreadsheet cannot run it.
5. **Security event content**: free-text `detail` is capped at 4,000 characters and keys that look like credentials (`password`, `token`, `secret`, `totp`, `code`, ...) are dropped; an event that cannot be written throws (fail closed); the type vocabulary is open (`UPPER_SNAKE`). Whether attempts for an address that matches no account are recorded is the caller's decision (an immutable table grows with every call; r1-identity's rate limits bound it); retention and archival of both chains is R3.
6. `role` filters are free text (roles become configurable in r1-authz); the heat-map aggregate adds a `System` row for entries whose actor is not a user (the installer, migrations, the break-glass CLI).
7. `app_version` is `unknown` when neither the bundle nor `package.json` in the working directory gives one.

## Not done

* "Full verify runs as a job": it runs inside the request (17 s per million rows, flat memory). The job queue and scheduler belong to r1-backup-jobs; `verifyAuditChain` is the function a job handler calls.
* `routes/signatures.ts`, `backup.ts`, `traceability.ts` are not edited here (not this track's files); the shared tree still has their own loops (they keep working, they verify the link only).
* The audit PDF and `Reports.tsx` still read fields that do not exist (r1-results-oos); `RecordHistory` is not mounted in any record screen yet.
* Keyed hash, daily anchors, the `lims_app` role and audit review (M35). `AUTHZ_DENIED` and `CONFIG` events are written by the tracks that own those code paths.
* The audit trail still lets a database owner remove a trigger and re-chain every row; the head (`GET /audit/head`) filed outside the system, the checkpoints and M35's anchors are the detection.
* Entity names in `audit_trail` are not normalised (`OOS` and `OosInvestigation` both exist), so a record's History needs its `related` list.
