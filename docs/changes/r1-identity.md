# r1-identity: identity and authentication, keystore, controlled AI egress (roadmap M05, M16)

Release R1, third wave. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.
Companion file: `docs/changes/r1-identity.gate.patch` (edits to other tracks' tests that this change forces; see "For the gate").

Status: **all acceptance criteria of M05 and M16 are met and tested**, with the limits listed under "Not done" (the client screens belong to r1-client-shell, the signature record for administrator actions to r1-esign).

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0010_identity.sql`, schema `src/db/schema/identity.ts` (+ `integrations.ts`, re-exported from identity.ts because `schema/index.ts` is not this track's) |
| Keystore | `src/server/crypto/keystore.ts` (master key per generation, HKDF purpose keys, `v<generation>:` ciphertext), `crypto/rotate.ts` (re-encrypt every stored secret, one audit entry) |
| Authentication core | `src/server/auth/`: `tokens.ts` (purpose-typed JWTs), `sessions.ts`, `requireAuth.ts`, `lockout.ts`, `totp.ts`, `recovery.ts`, `passwordPolicy.ts` + `commonPasswords.ts`, `credentials.ts` (password re-entry), `publicUser.ts` (projections), `users.ts` (create, reset, unlock, reset MFA), `bootstrap.ts` (first Administrator), `events.ts` (security events), `settings.ts`, `integrationSettings.ts`, `directory/` (principal resolver registry, one resolver: local) |
| Routes | `routes/auth.ts` (rewritten), `routes/admin.ts`, `routes/training.ts`, `routes/ai.ts` |
| Validation (all `.strict()`) | `src/lib/validations/{auth,admin,training,ai}.ts` |
| Break-glass CLI | `src/server/admin-cli.ts` |
| Client | `src/components/AdminPanel.tsx` (users, policies, integrations, alerts), `VoiceRecorder.tsx` |
| Tests | `tests/api/auth-session.test.ts` (21), `auth-lifecycle.test.ts` (34), `auth-keystore.test.ts` (11), `ai-egress.test.ts` (11): 77 tests against the real application and PostgreSQL |

Files outside the ownership list that this change touched, and why (each is small; none changes an assertion):

* `src/server/core/auth.ts` (r1-core): now `export { createRequireAuth } from '../auth/requireAuth'`. This is the file that r1-core's own header calls "interim: r1-identity replaces tokens with purpose-typed, session-backed ones" and that r1-build-shell's report hands to this track (its item 3). Nothing works without it: `app.ts` and `api.ts` build `requireAuth` from it. The `JWT_SECRET` export and its public fallback literal are gone.
* `tests/route-table.json` (r1-core): the 14 new routes, all `auth: true`, generated with the dump tool (additions only).
* `tests/security-controls.sh` (shared check): one line, URS-006 unlock now also clears `login_failed_attempts` and `login_locked_until` (the sign-in lock is a separate counter now). Assertions unchanged.
* `desktop/schema.sql` was **not** touched by this track; r1-audit regenerated it and it already carries 0010 (checksum matches).

## API contract (for r1-client-shell and every caller)

Sign-in answers one of three bodies. Fields in bold are new.

| Call | Success | Failure |
|---|---|---|
| `POST /api/auth/login-local {email, password}` | `{ token, user, mustChangePassword, session }`, or `{ requiresTotp: true, tempToken }`, or (policy `mfaRequired` and no authenticator yet) `{ requireTotpSetup: true, tempToken, qrCode, secret, otpauthUri }` | 401 `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (+ `retryAfterSeconds`), `ACCOUNT_DISABLED` |
| `POST /api/auth/totp-verify {tempToken, code}` or `{tempToken, recoveryCode}` | sign-in body | 401 `INVALID_CODE`, `INVALID_TOKEN` (spent, expired or wrong purpose), `ACCOUNT_LOCKED`, `MFA_SECRET_UNREADABLE` |
| `POST /api/auth/totp-setup {tempToken, code}` | sign-in body + `recoveryCodes` (shown once) | as above |
| `GET /api/auth/me` | `{ user, mustChangePassword, session }`; `user` has `mfaEnabled`, `passwordExpiresAt` | |
| `POST /api/auth/logout` | `{ success: true }`; ends the session on the server | |
| `POST /api/auth/reauth {password, code?}` | `{ token, user, mustChangePassword, session }` with the **same session id**; the absolute limit is not extended | 401 `MFA_CODE_REQUIRED` when the user has MFA and sent no code |
| `POST /api/auth/change-password {currentPassword, newPassword}` | `{ success: true }`; the user's other sessions end | 400 `PASSWORD_POLICY` with `details: [{path, message}]` |
| `POST /api/auth/totp-enroll {password}`, `POST /api/auth/totp-confirm {code}`, `POST /api/auth/recovery-codes {password}` | `{secret, otpauthUri, qrCode}`, `{success, recoveryCodes}`, `{recoveryCodes}` | 409 `MFA_ALREADY_ENROLLED`, `NO_ENROLMENT`, `MFA_NOT_ENROLLED` |

`session` is `{ id, idleTimeoutMinutes, idleExpiresAt, expiresAt }`. What every protected route can answer:

* 401 `SESSION_IDLE`: the server's idle timeout passed. **Not** a logout: send `POST /auth/reauth` with the same token (the page stays mounted, nothing is lost) and use the new token.
* 401 `SESSION_EXPIRED` (absolute limit, 12 h by default and at most), `SESSION_REVOKED` (logout, password change, role change, deactivation, MFA reset), `INVALID_TOKEN`, `USER_INACTIVE`, `UNAUTHORIZED`: sign in again.
* 403 `PASSWORD_CHANGE_REQUIRED`: temporary or expired password. Only `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout` and `POST /auth/reauth` are allowed until it is changed.
* The access token now carries `typ`, `sub`, `sid`, `exp` and, **for display only**, `id`, `name`, `email`, `role`. The current `App.tsx` reads the user from the token payload and crashes without those fields (seen in the browser run). The server never reads them. Remove them when the client uses `GET /auth/me` (`signAccessToken` takes the `display` argument for this).

Administrator routes (all need the Administrator's password, a `reason` of 3 to 500 characters and, where a record is changed, the `expectedVersion` the screen showed): `GET/PUT /admin/settings`, `GET /admin/users` (Admin, QA), `POST /admin/users`, `PUT /admin/users/:id` (role, active), `POST /admin/users/:id/{reset-password,unlock,reset-mfa}`, `POST /admin/broadcast`, `GET /admin/integrations`, `PUT /admin/integrations/ai`. `GET /training` returns `{ id, name, role, hasCompletedSoftwareTraining }` per user and nothing else.

## Behaviour of the controls

* **Tokens.** Three kinds (`access`, `mfa`, `enrol`), each signed with its own HKDF-derived key and checked by a `typ` claim, so a pre-MFA token is not a session and a session token is not an MFA challenge. The key generation is in the header (`kid`): tokens signed before a key rotation stay valid until they expire. A token signed with the shared `JWT_SECRET` in the old `{id}` form is refused.
* **Sessions.** One row per sign-in. Every request checks the row: revoked, past the absolute limit, idle longer than `session_timeout_minutes`, user still active. `last_seen_at` is written at most every 10 s. Revoked on logout, password change (other sessions), role change, deactivation, password reset, MFA reset and enrolment.
* **MFA.** TOTP with a 30 s step, one step of tolerance either way. Each step is accepted once per user (one conditional `UPDATE`, so two simultaneous sign-ins with the same code open one session). A challenge is redeemable once. Wrong codes count toward the sign-in lock. The secret is keystore ciphertext bound to the user id; a bare base32 secret from an older installation is accepted and rewritten as ciphertext at its first use. 10 recovery codes (salted scrypt hashes, shown once). Policy `mfaRequired` (default off) sends a user without an authenticator through enrolment before any session exists.
* **Two lockouts.** Sign-in: `login_failed_attempts` / `login_locked_until`, `maxFailedLogins` (3), `lockoutMinutes` (15), ends by itself, never touches `active`. Signing: `failed_attempts` / `locked_at`, 3 wrong passwords, same duration, sign-in ignores it. Both are counted in their own transaction, with their audit or security entry, committed before the error is answered. Parallel failures are serialised on the user row, so the count is exact. A lock that has ended starts a new count.
* **Password policy.** Floor of 8, the configured minimum, classes from the settings, built-in common-password list and fragments, no e-mail local part or name inside, no reuse of the last N (default 5, the current one always), 128 at most. A temporary or expired password forces a change. Expiry (`passwordExpiryDays`) is now enforced.
* **Administrator actions.** Create (server-generated 18-character temporary password, shown once, `must_change_password`), reset password, unlock, reset MFA, role change, deactivate and reactivate. A user cannot change or deactivate themselves; two Administrators cannot deactivate each other at the same moment (the active Administrator rows are locked and the actor is re-checked under the lock); the e-mail address is unique ignoring case (a race ends in 409, not 500).
* **Security events.** Sign-in, failure, MFA failure, recovery-code use, re-authentication, logout, password change, lockout and external AI call are written with `recordSecurityEvent` / `writeSecurityEvent` of the audit track (`src/server/auth/events.ts` is the one import point). A failed sign-in for an address that matches no account is recorded with the typed address as the actor label and writes nothing to the audit trail. Account changes (create, reset, unlock, role, active, settings, integration, key rotation, failed signature) are audit entries in the transaction of the change.
* **Training certification.** Strict body, existing target (404), Admin or QA, never for oneself (`SELF_CERTIFICATION_FORBIDDEN`), password re-entry that counts toward the signing lock, once per module (409), record + flag + audit in one transaction. It used to crash on a missing module name or a non-string password and kept no counter.
* **AI.** Off by default. `integration_settings` (version, encrypted key, model, redaction flag). Enabling or changing needs an Administrator, password, reason and the current version, and is audited. Every request writes an `EXTERNAL_CALL` security event **before** anything is sent (if it cannot be written, nothing is sent), then calls the provider with the stored key (`GEMINI_API_KEY` in the environment is no longer read). Disabled or no key: 503 `AI_DISABLED`; provider failure, timeout (60 s) or an unusable answer: 503 `AI_UNAVAILABLE`. No fallback content exists any more: the canned transcription, the template CAPA analysis and the template protocol are deleted. Answers carry `generatedBy: { provider, model, label: 'AI draft - not a GxP record', generatedAt }`; a protocol also begins with `AI DRAFT - NOT A GXP RECORD ...` inside its text, so the label stays on an ELN entry until a person removes it. With redaction on (default) sample and result identifiers are removed from the prompt.
* **Heatmap.** `GET /admin/activity-heatmap` no longer adds random numbers; it uses r1-audit's bounded aggregator.
* **Broadcast.** `POST /admin/broadcast` exists (the panel posted to a missing route), is audited and emits to the sockets after COMMIT.

## Why (findings from `synth.topDefects` and M05 / M16)

* MFA bypass by the pre-MFA token (r1-core already stopped it as a Bearer; this track removes the design that allowed it). TOTP enrolment did not exist; secrets were plaintext and returned by `/training` and `/admin/users`; no replay guard. The e-signature lock became an indefinite sign-in lock, and three bad sign-ins deactivated the only Administrator. No logout, a fixed 8 h token, no idle or absolute timeout, no password change route, no user creation, no password policy or history.
* Canned transcription text returned whenever no key was set and preferred over the spoken text; AI keys read from the environment and audio and OOS detail sent to a third party with no control or record; heatmap padded with `Math.random`; `AdminPanel` posting to a missing route; `certify` crashing on bad input.

## How to verify

```
# new tests (77) and the suite
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/auth-session.test.ts tests/api/auth-lifecycle.test.ts tests/api/auth-keystore.test.ts tests/api/ai-egress.test.ts
SQL_... npx vitest run                         # see "For the gate": 12 failures before the two gate patches, 0 after

# shared validation evidence on a database made with the shipped installer and seeded (port 3103 used here)
node scripts/build-server.cjs
BASE=http://127.0.0.1:3103/api tests/security-controls.sh      # 34 PASS
BASE=http://127.0.0.1:3103/api tests/backup-restore.sh         # 13 PASS
```

| Acceptance | Evidence |
|---|---|
| M05: a tempToken as Bearer on `/samples` is 401; the same TOTP code twice is 401 the second time | `auth-session.test.ts`: tempToken; replay across two sign-ins; the same challenge twice; one code in two simultaneous sign-ins gives `[200, 401]` |
| M05: `/training` as an Analyst has no `totpSecret`, `failedAttempts`, `lockedAt` | `auth-lifecycle.test.ts` serialization: exact key set `[hasCompletedSoftwareTraining, id, name, role]`; `/admin/users` for Admin and QA; a sweep of every parameterless GET route in the route table as Administrator |
| M05: an Administrator-created analyst must change the password; other calls 403 `PASSWORD_CHANGE_REQUIRED` | `administrator creates a user` (create, forced change, policy, history, other sessions end), also for an expired password |
| M05: three bad signing passwords lock signing for 15 minutes, not sign-in; the lock ends by itself | through the real `POST /samples/:id/transition` and through certify; expiry by moving `locked_at` into the past |
| M16: no key: `/transcribe` is 503 `AI_DISABLED`, no canned text, no SDK call | `ai-egress.test.ts`; the SDK constructor is never called; an environment `GEMINI_API_KEY` does not switch AI on |
| M16: enabling needs password re-entry, audit row, `EXTERNAL_CALL` per request | wrong password 401 (no change, failure audited), stale version 409, one security event per request including failed ones |
| M16: rotation writes v2, v1 stays readable, denied network completes the OQ suite | `auth-keystore.test.ts` (unit and database level, MFA and sessions keep working across the rotation). Denied network: a spy over `net.Socket.connect` while the AI routes run, and both shared check scripts run against a server started with a preload that fails every non-loopback connection (see "Evidence") |

## Evidence

* **Test first.** The four files were written against the untouched code. First run: 68 tests, **58 failed, 4 passed, 6 skipped** (the 4 are behaviours r1-core had already fixed: the pre-MFA token as a Bearer, a deactivated user, a non-string password). Failures that show the old behaviour rather than a missing route or column: a token signed with `JWT_SECRET` in the old format was accepted; a replayed TOTP code gave a session; `/training` and `/admin/users` returned `totpSecret`, `failedAttempts` and `lockedAt`; a signing lock blocked sign-in; `POST /transcribe` returned the canned observation, and an unusable provider answer to the CAPA request was silently replaced by the template analysis; the heatmap total differed from the audit row count. Green: 77 tests, passing in repeated runs of the four files and in every whole-suite run.
* **Mutation checks** in a private copy (each must turn a test red, and did): replay guard always accepts (2 tests); the signing lock also blocks sign-in (3); the MFA challenge is never consumed (1); revoked sessions still accepted (4); `/training` projection returns the whole row (2).
* **Shared checks**, final bundle, server started with `--require` of a script that fails any connection to a non-loopback address and logs it: `security-controls.sh` 34 PASS, 0 FAIL; `backup-restore.sh` 13 PASS, 0 FAIL; blocked connection attempts: 0. (This denies egress inside the Node process. It is not a network-namespace test.)
* **Browser run** of the production bundle in Electron under Xvfb: sign in as Administrator, open System Administration, create a user (temporary password shown once, "Password change pending" in the row), a wrong password shows the red toast "Invalid password. 2 attempt(s) remaining.", the Integrations and Security Policies tabs render, no page error. The same run showed that the current `App.tsx` crashes on a token without the display claims; that is why they are in the token.
* **Whole suite.** In the shared tree 331 pass and 12 fail: 1 route table (r1-audit's five routes), 3 forced by this track (two tests mint old-format tokens), 8 forced by new append-only tables, migrations and columns. With `r1-audit.gate.patch`, then `r1-identity.gate.patch`, and a regenerated route table, in a private copy: **343 pass, 2 skipped, 0 fail**.
* `npm run lint:web` clean; `node scripts/typecheck-server.cjs` reports only `tests/upgrade/system-info.test.ts` (fixed by the patch).

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: lockout numbers and the account-lock message, session timeouts, password policy and enforced expiry, MFA optional by default, password re-entry instead of a signature record for administrator actions, no self-certification and no self-change, Web Speech removed from the dictation button, AI error codes and redaction scope, keystore fallback to `JWT_SECRET`, failed sign-ins for unknown addresses recorded, display claims in the token, the break-glass authority model.

## Operating notes

**Keys.** The keystore reads `LIMS_KEYRING` (JSON `{"current":2,"keys":{"1":"...","2":"..."}}`), else `LIMS_MASTER_KEY` (32+ characters, generation 1), else `JWT_SECRET` (generation 1; the fallback that keeps today's installations working). Development and test runs with none of them get a random per-process key; anything else refuses to start. Rotating `JWT_SECRET` while it is the master makes every stored secret unreadable, so production should set `LIMS_MASTER_KEY` from the OS credential store and never change it.
Rotation: add generation 2 to `LIMS_KEYRING` (keep generation 1), restart, run `admin-cli rotate-keys --reason "..."` (re-encrypts authenticator secrets, pending enrolments and the AI key in one transaction with one audit entry). Keep generation 1 in the ring for as long as a backup made before the rotation may have to be restored: backups hold keystore ciphertext, and a restore on a computer without the key ring leaves every user's MFA unreadable (an Administrator then resets MFA per user) and the AI key unusable.

**Break-glass** (`npx tsx src/server/admin-cli.ts <command> --email <address> --reason <text>`; needs the machine and the database credentials, not a sign-in; actor `cli:<os user>`): `reset-password` (prints a temporary password once), `unlock`, `reset-mfa`, `bootstrap-admin` (ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD from the environment; refused while an active Administrator exists), `rotate-keys`.

## Not done

* **Signature record for administrator actions.** Create, reset, role change, deactivation, settings and AI enablement re-enter the password, state a reason and name the version, and the audit entry carries them, but no `signatures` row is written: that table still requires a sample id. r1-esign's `signRecord` should replace `assertActorPassword`.
* **Client screens.** `Login.tsx` still tests `requireTotp` (the server sends `requiresTotp`) and has no enrolment, recovery-code, forced-change or re-authentication screen; `Layout.tsx` posts to `/auth/logout` without the Authorization header, so the session is not ended on the server; `App.tsx` decodes the token. All r1-client-shell. The contract above is what they build against.
* **First administrator at install.** `init-db.ts` (r1-migrations) still inserts the first Administrator directly: no audit entry, no forced password change. `bootstrapFirstAdmin()` does both; calling it there needs the installer's password check (12 characters) to meet the policy, and the test harness and CI use `bootstrap-password-123`, which the policy rejects (it contains "password").
* AI labels in `OOSInvestigations.tsx` and `ELN.tsx` for the CAPA analysis (the protocol text carries its own label); sockets are still unauthenticated; the 100 kb JSON limit blocks dictation longer than about 12 s (`app.ts`); `rabbitmq.ts` still logs the AMQP URL with credentials; `admin-cli` is not in the production bundle yet.
* Only the local principal resolver exists. Idle and expired sessions are not logged as events and old session rows are not purged. `GET /admin/users` is not paged.
* The validation package (URS-005 overstates the control: raise a deviation and re-run OQ-01 and OQ-08; the canned transcription is a data-integrity finding in its own right: raise a deviation) was not edited and nothing was approved or signed.

## For the gate

1. `git apply docs/changes/r1-identity.gate.patch` **after** `r1-audit.gate.patch`, then delete both: `tests/upgrade/system-info.test.ts` and `server-start.test.ts` (r1-migrations; they minted `{id}` tokens with `JWT_SECRET`, which is exactly what this change refuses, so they sign in or create a session now), `upgrade-v0.1.0.test.ts` (new columns of `users` and `system_settings` hold their defaults; `password_history` starts with one row per user).
2. Regenerate `tests/route-table.json` once the last route of the wave has landed (this track's 14 are in).
3. `desktop/schema.sql`: regenerate after the last migration of the wave (`npx tsx src/server/boot/migrate-cli.ts export-schema`); it already carries 0010.
4. See the structured report's `needsFromOtherTracks` for the rest (`app.ts` audit context and JSON limit, `build-server.cjs`, `desktop/main.cjs`, `config.ts`, `init-db.ts`, client files).
