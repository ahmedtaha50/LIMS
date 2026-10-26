# r1-authz: server-enforced permission matrix, deny-by-default route table, entity state machines, record-level SoD (roadmap M09)

Release R1, wave 3, run beside r1-esign and r1-client-shell. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.
Companion file: `docs/changes/r1-authz.gate.patch` (the wiring in `app.ts`, one line in `schema/index.ts`, and two edits to other tracks' tests that this change forces; see "For the gate").

Status: **partial, in one respect only: nothing is enforced until the gate applies the wiring.** Every file this track owns is done and tested, and the four acceptance criteria are met and tested on the real application with the wiring applied (gate simulation below: 681 tests pass, 0 fail). The wiring is three lines in `src/server/app.ts` (r1-core's file), which the house rules forbid editing, so it is in the gate patch. In the shared tree without the patch, the 37 tests that go through `createApp()` fail by design (they are the evidence that the layer is not mounted); the 105 that do not need it pass. Also not done: the client screens for role changes, and `permissions` inside `GET /auth/me` (a file of r1-identity); see "Not done".

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0040_authz.sql`: tables `roles`, `permissions`, `role_permissions`, `sod_rules`, `user_roles` and the default matrix rows |
| Schema | `src/db/schema/authz.ts` |
| Catalog and default matrix (shared by server and client) | `src/lib/permissions.ts`: 58 permission codes, `DEFAULT_MATRIX` per role, `SOD_RULES`, `hasPermission()` |
| The route table | `src/server/authz/routeTable.ts`: 100 rules (87 permission, 8 self-service, 5 public; 56 of them mutating) |
| The layer | `src/server/authz/`: `middleware.ts` (`authorize({ db })`), `match.ts`, `contract.ts` (`assertRouteContract`), `stateGuard.ts`, `sod.ts`, `roleGrant.ts`, `roleChange.ts`, `grants.ts`, `denied.ts`, `csv.ts`, `schemas.ts`, `types.ts`, `index.ts` |
| State machines | `src/server/workflow/entityStates.ts`: OOS, Specification, BatchRelease, ELN, Instrument |
| Routes | `src/server/routes/permissions.ts` (mounted by the layer, not by `routes/index.ts`): `GET /permissions/me`, `GET /permissions/matrix[?format=csv]`, `GET/POST /permissions/role-changes`, `POST .../:id/{approve,reject,cancel}` |
| Matrix export | `docs/permission-matrix.csv` (generated; a test fails when it is stale), `scripts/authz/export-matrix.ts`, `scripts/authz/generate-seed.ts` |
| Tests | `tests/api/route-contract.test.ts` (12), `authz-matrix.test.ts` (57), `authz-sod.test.ts` (6), `authz-states.test.ts` (10), `authz-fuzz.test.ts` (35), `authz-rolechange.test.ts` (17), `authz-migration.test.ts` (5): 142 tests against the real application and PostgreSQL |

Files outside the ownership list that this change touches: **none** (the four files in the gate patch are listed there, not edited).

### How it works

One table, `ROUTE_RULES`, maps `"METHOD /path"` to who may call it. The middleware `authorize({ db })` runs in front of every route module, so the route files are not edited:

1. No rule for the request, no route: **404**, the handler is never reached. A new route is unusable until someone has decided who may call it.
2. `perm('code')` rules: authenticate (the same `createRequireAuth` as every route: session, idle, forced password change), then the role must hold the permission (**403 `PERMISSION_DENIED`**, with `details.permission`), then the body may carry only the keys the rule lists (**400**), then the record's state must allow the action (**423 `RECORD_LOCKED`** / **409 `ILLEGAL_TRANSITION`**), then the signer must be independent of the record (**403 `SOD_VIOLATION`**), then the rule's own guard. The handlers keep their own checks and their messages.
3. `SELF` rules (`/auth/me`, `/auth/reauth`, `/auth/logout`, change-password, MFA enrolment, `/permissions/me`): the route authenticates itself with its own session options (a user who must change the password, an idle session), so the layer only checks the body keys. `PUBLIC` rules: sign-in and the two health probes.
4. A refusal (permission or independence) is a security event `AUTHZ_DENIED`, outcome `denied`, with actor, role, permission or rule, route and path, written in its own transaction and committed before the 403 goes out.
5. **Boot assertion.** `assertRouteContract(app)` (called at the end of `createApp`) throws, listing each problem with the line to add, when a registered route has no rule, a mutating rule has no `body`, a rule names a route that does not exist, a route is registered twice, or a rule and the route disagree about `requireAuth`. (The last cross-check reads the handler's function name and is skipped in the minified server bundle, where esbuild renames it; found the hard way, see Evidence.)
6. The permissions come from the tables: `users.role` names the role, `roles` / `role_permissions` give its codes, one indexed query per request. A role that is not in the matrix (the column was free text) holds nothing: every protected route is 403.

To add a route: one line in `routeTable.ts` (and a permission code in `src/lib/permissions.ts` with a migration, if a new one). Where the route module has a strict Zod schema, give the same schema as `body`, so the two cannot drift.

### The default matrix and the before / after record

The role migration changes validated behaviour, so this is the change-control diff. `docs/permission-matrix.csv` is the "after" in full (permission, roles, routes). Admin holds all 58 codes, QA 48, Reviewer 34, Analyst 34.

| What | Before | After |
|---|---|---|
| Role checks the handlers made (audit, backup, jobs, security events, admin, training certify, OOS close, batch release, sample registration, audit history) | enforced in each handler | the same roles, now also in the table; the handler checks stay |
| `POST /specifications/:id/approve` | any signed-in role | **Admin, QA** (`spec.approve`), and never someone who created or edited that specification |
| Every other route that had no role check (results, OOS open and edit, specification create and edit, instruments, reagents, environmental, stability, notebook, material dispensing, reports, AI) | any signed-in role | **unchanged**: bound to a code that all four roles hold (Reviewer entering a result is validated behaviour, OQ URS-012). Bound is not restricted: QA decides what to tighten (see decisions) |
| A user whose `role` text is not Admin, QA, Reviewer or Analyst | passed every route that had no check | 403 everywhere except the self-service routes |
| Unknown JSON key in the body of a mutating route | 15 of the 56 routes did not reject the key itself: `POST /auth/logout` carried on and ended the session; `POST /oos`, `POST /instruments/:id/calibrate` and `POST /specifications/:id/approve` answered 500 (a database error, `scrypt` on a missing password); the other eleven answered 400 or 404 about something else (a missing field or version) | 400 `Unrecognized key: "x"` from every one of the 56 |
| `PUT /oos/:id` with `status` | any status written, a closed signed investigation edited | 400; a closed investigation is 423 |
| `PUT /specifications/:id` on an Active or Obsolete specification; `POST .../approve` on one | 500 with the handler's text | 423; approving an Active one is 409, an Obsolete one 423 |
| `PUT /eln/:id` and `POST /eln/:id/sign` on a signed worksheet | 403 and 400 | 423 |
| Second `POST /traceability/batch/:batch/release` | by reading the code, `ON CONFLICT DO UPDATE` overwrote the release (`version: 2`) and signed again (the executed test on the old code answered 500: the sample foreign key of top defect 3) | 423 |
| `POST /instruments/:id/calibrate` on a Retired instrument | reactivated it | 423 (no route produces Retired yet) |
| `PUT /admin/users/:id` with a role change that grants or removes Admin or QA; `POST /admin/users` with role Admin or QA | one Administrator, one password | 409 `ROLE_CHANGE_REQUIRES_APPROVAL`: the two-person flow below. Changes between Reviewer and Analyst, deactivation, and creating an Analyst or Reviewer are unchanged |
| A refused call | 403 or nothing recorded | 403 plus an `AUTHZ_DENIED` security event |

### The role-change flow (two people, two signatures)

`POST /permissions/role-changes` (permission `authz.role.request`, Admin) with `{ userId, role, reason, expectedVersion, password }`: the Administrator signs the request. `POST /permissions/role-changes/:id/approve` (`authz.role.approve`, Admin and QA) with `{ password, reason?, expectedVersion }`: a second person signs. Only then, in one transaction, `users.role` changes (with the version predicate the first signer saw), the target's sessions end, and the audit entries are written. Rules:

* Each signature is the signer re-entering the password (counted toward the signing lock, wrong attempts audited by r1-identity's bookkeeping), with a fixed meaning (`ROLE_CHANGE_MEANINGS`, never client text), the record version seen (`request_record_version`, `decision_record_version`) and a SHA-256 over signer, meaning, version and time. Both signers must have completed the software training.
* The approver is neither the requester nor the person the change is for (rule `role.grant`; refused with 403 `SOD_VIOLATION`, audited as `AUTHZ_DENIED`). The requester withdraws with `/cancel`; anyone with the approval privilege who is not the requester or the target can `/reject` (reason required).
* One pending request per user (partial unique index). The approval is a 409 if the user changed in the meantime (the request's version predicate), if the request itself moved, or if it would remove the last active Administrator.
* Audit, in the transaction of each step: `RoleChangeRequested` / `RoleChangeApproved` / `RoleChangeRejected` / `RoleChangeCancelled` on `UserRole`, and `RoleChange` on `User` (old and new role) at approval.

### State machines (`entityStates.ts`)

| Entity | States | Terminal | Editable |
|---|---|---|---|
| `oos` | Open, Approved, Closed (Approved is today's word for closed; Closed is the roadmap's) | Approved, Closed | Open |
| `specification` | Draft, Active, Obsolete | Obsolete | Draft |
| `batchRelease` | Quarantine Hold (no record yet), Released, Rejected | Released, Rejected | none |
| `eln` | Draft, Signed | Signed | Draft |
| `instrument` | Active, In Calibration, Out of Service, Retired | Retired | all but Retired |

`assertTransition(entity, from, to)` and `assertEditable(entity, state)` are for any code that changes a status, inside its transaction: 423 for a terminal state, 409 for any other illegal move. The layer applies them in front of 8 routes.

## Why (findings)

* M09 and the `synth.topDefects` entries in scope: "only about 10-14 of 33 mutating handlers check a role"; spec PUT and approve and calibrate with no role check and no author separation (defect 16); `PUT /oos/:id` accepts any status and edits closed signed investigations (defect 5); the `roles` column is free text; 23 of 33 body-consuming routes lack a strict schema; AccessDenied was not recorded.
* Not in scope here and left to their owners: sample transition guards and result rules (r1-results-oos), the specification author column and revision (r1-spec), calibration date and reactivation (r1-quality-fixes).

## How to verify

```
# the new tests (142) and the suite; needs the gate patch applied (see "For the gate")
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/authz tests/api/route-contract.test.ts
SQL_... npx vitest run

npx tsx scripts/authz/export-matrix.ts --check          # docs/permission-matrix.csv is current
npx tsx scripts/authz/generate-seed.ts                  # the seed block of 0040, from the catalog
npm run lint                                            # web clean; server: the 25 known baseline errors, none new
```

| Acceptance (M09) | Evidence |
|---|---|
| The route-contract test fails when a route is added without a permission | `route-contract.test.ts`: `findContractViolations` on an app with two extra routes names both (`no-rule`); `assertRouteContract` throws with the route and the line to add; a bare app without the table cannot reach a handler (404); the live application passes both directions (no route without a rule, no rule without a route, rule and `requireAuth` agree, every mutating rule lists its keys, every code is used and exists) |
| An Analyst approving a spec gets 403, and a QA author approving their own gets 403 (both audited) | `authz-sod.test.ts`: 403 `PERMISSION_DENIED` and 403 `SOD_VIOLATION`, each with one `AUTHZ_DENIED` event (actor, permission or rule, entity id), the specification still Draft; an editor is not independent either; an Admin or a different QA passes the layer |
| `PUT /oos/:id` with a status key returns 400, and PUT on a closed OOS returns 423 | `authz-states.test.ts`: 400 and the row unchanged (status Open, version 1); the investigation is closed with a real signature through the real route, then PUT is 423, closing again is 423, the row is identical |
| Posting an unknown key to every mutating route returns 400 (table-driven) | `authz-fuzz.test.ts`: the 56 mutating routes are read from the live application, each gets `{ "__unexpected_key__": "x" }` from a fresh session, each answers 400 naming the key; plus 32 payloads copied from the screens that must still be accepted |

## Evidence

* **Test first.** The seven files were written against the untouched code (the HEAD tree plus nothing of this track). First run: 135 tests, **82 failed**, then, after two mistakes in my own tests were corrected (a header built after its request existed, and a request key that is legitimate), **51 failed, 84 passed** (six files; the migration file was added later). Of the 84 passes, 44 are the role cases that already worked and 31 are payloads of the screens that must keep being accepted: they are controls, not evidence. Old behaviour seen: an Analyst's specification approval reached the handler (500 `Not Found` for a missing specification, not 403), `PUT /oos/:id` with `status: 'Approved'` answered **200** and the investigation became Approved, a closed investigation was edited **200**, `POST /auth/logout` with an unknown key ended the session, a user with role `Root` read `/samples` **200**, an Active specification answered 500, a signed worksheet 403, a retired instrument was calibrated **200**, privileged roles were granted by one Administrator **200/201**.
* **Mutation checks** on the gate simulation (each must turn a test red, and did): no permission check (7 tests); body keys not checked (the table-driven test); state guard off (6); central independence off (2); the person a change is for may approve it (1); the legacy admin routes unguarded (2); the journal guard removed from the seed (2: the empty restore schema gets rows, and a backup no longer restores).
* **Shared checks**, production bundle of the gate simulation (esign + authz), fresh database from the shipped installer, demo seed, port 3107: `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL** (the restore builds an empty database from the migration SQL: this is where a seed that collides with the backup's rows would have failed).
* **Whole suite on the gate simulation** (a copy of the working tree with the gate patches of r1-esign and r1-authz applied and `route-table.json` and `desktop/schema.sql` regenerated): 59 files passed, 2 skipped (opt-in scale tests), **681 passed, 3 skipped, 0 failed**. On the HEAD tree plus this track alone the same run had the same results apart from the two r1-esign routes. `npm run lint`: web clean; server 25 known baseline errors, none new.
* **A defect the bundle found that the tests could not.** The first production start failed: `assertRouteContract` reported every route as "declared protected but does not run requireAuth". It read the handler's function name, and esbuild had renamed it in the bundle. The cross-check is now skipped when no handler shows the name (`canCheckAuthentication`, tested); the layer itself never depended on it.
* **Found while testing:** the fresh-install failure of top defect 3 (a specification approved by a non-author still fails on the `signatures.sample_id` foreign key: HTTP 500). It is not this track's to fix (r1-esign's `signRecord`, r1-spec's route), so `authz-sod.test.ts` asserts that an independent approver passes authorisation (`not 403`), not 200.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: spec approval limited to Admin and QA and everything else left at today's roles; Admin and QA as the roles that need two people; independence read from the audit trail; training required for both signers; the role-change signatures kept in `user_roles` for now; no API to edit the matrix; unknown roles denied; the new terminal states (batch Rejected, instrument Retired); re-release of a batch refused; every refusal recorded.

## Needs from other tracks, and for the gate

| File (owner) | Change |
|---|---|
| `src/server/app.ts` (r1-core) | **Gate patch**: `import { assertRouteContract, authorize } from './authz'`; `app.use('/api', authorize({ db }))` immediately before `createApiRouter`; `assertRouteContract(app)` before `return app` |
| `src/db/schema/index.ts` (r1-migrations) | **Gate patch**: `export * from './authz'` (without it `tests/upgrade/schema-drift.test.ts` sees five tables the schema does not declare) |
| `tests/upgrade/upgrade-v0.1.0.test.ts` (r1-migrations) | **Gate patch**, to be applied after `r1-esign.gate.patch`: the tables 0040 adds hold the catalog rows, not zero. Without it two tests fail (`keeps every record`, `can be rolled back and upgraded again`) |
| `tests/api/audit-security-events.test.ts` (r1-audit) | **Gate patch**: the paging test counts all `denied` events of the Reviewer; it now filters `type: 'LOCKOUT'`, because earlier tests in the file make the Reviewer's 403s `AUTHZ_DENIED` events (13 instead of 12) |
| `tests/route-table.json`, `desktop/schema.sql` | Regenerate after the last route and migration of the wave: `npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (without `--stdout` the tool fails under tsx on `__dirname`), `npx tsx src/server/boot/migrate-cli.ts export-schema`. This track adds 7 routes (`/permissions/*`); r1-esign's 2 new `GET /signatures/*` routes already have rules |
| Every track that adds a route | One line in `src/server/authz/routeTable.ts`, or `createApp` throws and says which. They do not own the file: list it in the report and the gate adds it |
| `src/server/routes/auth.ts` (r1-identity) | `GET /auth/me` should return `permissions: await permissionsOfRole(db, user.role)` (from `src/server/authz`). Until then the client calls `GET /api/permissions/me` |
| `src/components/AdminPanel.tsx` (r1-identity) | The role dropdown posts `PUT /admin/users/:id`; for Admin and QA it now gets a 409 with the instruction (the toast shows it). It needs a "request role change" action and a list of pending requests with approve and reject (`GET /permissions/role-changes`) |
| `src/components/OOSInvestigations.tsx` (r1-results-oos) | `handleUpdateOOS` sends `status`; it is now a 400. Remove the key (the status moves with the closure signature) |
| `src/server/workflow/entityStates.ts` consumers (r1-results-oos, r1-spec, r1-quality-fixes) | Call `assertTransition` inside the transaction that writes a status; when the OOS vocabulary becomes 'Closed', change the rule `to: 'Approved'` for `POST /oos/:id/close` in the table (both words are already legal) |
| `docs/migrations.md` (r1-migrations) | Add the rule this migration follows: seed constants only under `WHERE EXISTS (SELECT 1 FROM schema_migrations)` (see the header of 0040), because a restore builds the schema from the same SQL |
| `AGENTS.md` (r1-build-shell) | Section 2 or 3: every route needs a line in the route table |
| Validation package | URS/FRS/OQ entries for the matrix, deny-by-default, independence and the role-change flow; the before / after table above is the input. Nothing was approved or signed |

## Not done

* **Wiring** (above): not mounted until the gate patch is applied.
* **`/auth/me` with the permission list** and **the client screens** (role change request and approval, hiding actions by permission): the endpoint to build against is `GET /api/permissions/me`.
* **Role-change signatures in the common signature table.** They live in `user_roles` (meaning, version, hash). When r1-esign's `signRecord` takes users as an entity, they should move there (its catalog already has `ADMIN_AUTHORISATION`).
* **No expiry of pending role-change requests**, and no notification of the approver.
* **Independence beyond specifications and role changes.** Sample approval keeps the check it has; OOS closure, batch release and calibration have none (see decisions). The helper and the `sod_rules` table are ready for them.
* **Tightening the default matrix** (see decisions) and **editing the matrix from the application**: a change is a migration.
* **Caching of the permission lookup** (one extra indexed query, and a second session lookup, per request) and **pagination** of `GET /permissions/role-changes` (newest 200).
* The `result.enter` rules (role and state), the specification author and revision columns, calibration validation: r1-results-oos, r1-spec, r1-quality-fixes.
