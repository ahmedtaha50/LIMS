# r3-directory: directory (LDAP / Active Directory) sign-on with QA-signed group-to-role mapping (roadmap M41)

Release R3. Branch `claude/project-implementation-tirr4j`. Changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r3-directory.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied**. The three M41 acceptance criteria pass against a fake directory behind the connector seam
(`tests/api/directory-signon.test.ts`), and the TLS behaviour of the real `ldapts` client is proven against a real TLS socket
(`tests/unit/directory-protocol.test.ts`). **No real Active Directory was available**: the first IQ run against the customer's domain controllers
is the evidence the roadmap asks for (certificate trust, the attribute names, the group attribute); see "Not done".

## What changed

| Area | Files |
|---|---|
| Migration 0310 (forward-only) | `drizzle/0310_directory.sql`, schema `src/db/schema/directory.ts` |
| Directory sign-on | `src/server/auth/ldap.ts`: transport (ldapts, LDAPS or StartTLS, certificate always verified), RFC 4515 escaping, search/bind, account-state checks, role mapping, provisioning/sync, break-glass, the password check used by e-signature and re-authentication |
| Administration | `src/server/routes/directory.ts`: 9 routes (settings, connection test, mappings, approve/retire with e-signature, accounts, break-glass flag) |
| Screen | `src/components/DirectorySettings.tsx` (+ `shell/ext/directory.tsx`, in the gate patch) |
| Dependency | `ldapts@9.2.0` (`package.json`, `package-lock.json`: 4 packages added, nothing else changed; `npm ci` verified in a scratch copy) |
| Tests | `tests/unit/directory-protocol.test.ts` (19), `tests/api/directory-signon.test.ts` (39), `tests/api/directory-ui.test.ts` (5), helper `tests/helpers/fakeDirectory.ts` |

`users` is **not** changed. A person who is not a plain local account has a row in the sidecar `directory_accounts` (`kind` `ldap` or `break-glass`); that is
the whole of "auth_provider". The immutable identifier (`objectGUID`, hex) is `external_id`, unique.

## How it works

The directory is one more principal resolver (`src/server/auth/directory/index.ts`, built by r1-identity for this purpose). It only proves who the person is.
Everything after is the existing identity module working on a local `users` row: the sign-in lock (wrong directory passwords count, `maxFailedLogins`), the TOTP
second factor (`requiresTotp`, `mfaRequired` enrolment), sessions (idle/absolute timeout, revocation), and the security events. Every sign-in therefore writes the
usual `AUTH_LOGIN` event, plus `DIRECTORY_AUTH`; every refusal writes its reason to the security chain (the client only ever sees `INVALID_CREDENTIALS`).

1. **Switched off** (no settings row, or `enabled = false`): the resolver answers "unknown" after one settings read. Nothing else changes; the test proves the
   connector is never called and a local account signs in as before.
2. **Which names go to the directory.** A name that matches a plain local account (not break-glass) is a local account: its password is never sent to the directory,
   and a directory person cannot take it over by having the same e-mail address (they are refused and it is logged). Everything else is looked up.
3. **Search.** The service account (bind password = keystore ciphertext, `directory_settings.bind_password_enc`, context-bound) finds the person by
   `userPrincipalName`, `sAMAccountName` or `mail`. The typed name enters the filter only through `escapeFilterValue` (RFC 4515: `* ( ) \ NUL` and every non-ASCII byte).
   More than one match is refused.
4. **Account state before the password.** `userAccountControl` disabled (0x2), locked out (0x10) or `accountExpires` in the past: refused **before** the person's
   password is tried; the person's open sessions end. A local lock (too many wrong passwords here) also stops the bind, so a locked account is not tried in the directory
   either (each try would count there too). An empty password is never sent (it would be an anonymous bind, which many servers accept).
5. **Verification** by binding as the DN the search returned.
6. **Roles.** `memberOf` (configurable attribute) is matched with the **Approved** rows of `directory_group_roles` at **every** sign-in. The role of the account is
   set from the mapping: a changed role is an audited update (`DirectorySync`, old and new value, in the same transaction) and ends the person's other sessions; a person in
   no approved group is refused and their sessions end. A new account is created only when a mapping gives it a role (never a role without the mapping), as the
   person themself in the audit trail (no "system" actor), without a password hash, without software training (the e-signature guardrail still applies).
7. **The mapping.** Proposed as a Draft by the Administrator (`directory.manage`); approved or retired by **QA with an e-signature** (meaning `DIRECTORY_MAPPING`, QA only,
   reason required) bound to the record version; the proposer cannot approve; a group can have only one live (Draft or Approved) mapping; the Administrator role cannot be
   mapped (API and `CHECK`). Several matching roles resolve to the least privileged.
8. **Break-glass.** A local Administrator with an authenticator, flagged by an Administrator (password, reason, version, audited). While the directory answers, that
   account is **refused** (event `BREAK_GLASS_REFUSED`); while the directory cannot be used (network, TLS, service account refused) it signs in with its local password
   **and its authenticator**, and each attempt is a `BREAK_GLASS_USED` security event (success or failure). Switching the directory on needs a working break-glass account, and
   the last one cannot be removed while it is on.
9. **E-signature and re-authentication.** `authorizeSigner`, `assertActorPassword` and `/auth/reauth` check a directory account's password in the directory **again at each
   signature**: a person disabled since sign-in cannot sign, a wrong password is counted against the local signing lock exactly as before, a directory that does not answer is
   `503 DIRECTORY_UNAVAILABLE` and counts nothing. The authenticator code rule (step 7 of the e-sign rules) is untouched and still required.
10. **Local password.** Not managed for directory accounts: change-password and the administrator reset answer `409 DIRECTORY_MANAGED`.
11. **Switching on** (`PUT /directory/settings`): Administrator password, reason, version; needs an Approved mapping, a break-glass account, and a **successful connection
    test** (TLS verified, service account accepted); otherwise `409`/`422` and nothing is stored. `localAccountsAllowed = false` closes local sign-in for everyone but break-glass.

## Transport

Only `ldaps://` (security `ldaps`) or `ldap://` with StartTLS (security `starttls`); the URL scheme must match (settings `CHECK`, the zod schema and the connector). The
connector always passes `rejectUnauthorized: true`, `minVersion: TLSv1.2` and the stored CA (`ca_pem`) as the only trust anchor when there is one. StartTLS runs before the first
bind; if it fails the connection is closed and nothing was sent. Proven: recorded-call test (order, options), and the real `ldapts` client against a TLS server whose certificate
the stored CA vouches for (handshake completes), a different CA (no handshake), no CA (self-signed refused), and a closed port (unavailable).

## How to verify

```
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/unit/directory-protocol.test.ts tests/api/directory-signon.test.ts tests/api/directory-ui.test.ts
```
(with the gate patch applied: the routes need their route-table rules and the tables come from `desktop/schema.sql`.) Mutation check done: with `escapeFilterValue` returning its input
the injection tests fail (7 unit + 1 API); with `esign/authorize.ts` at HEAD the 5 directory e-signature tests fail.

## Decisions needing confirmation (conservative defaults)

* The **Administrator role is never given by the directory** (CHECK). Admin stays a two-person local grant (`ROLE_CHANGE_REQUIRES_APPROVAL`). QA is mappable (QA signs the mapping).
* **Several mapped groups give the least privileged role** (Analyst < Reviewer < QA). The alternative (most privileged) was rejected as the less safe default.
* A directory person **cannot adopt an existing local account** with the same address (no auto-link); linking existing local users to the directory is a manual migration not built here.
* **Local accounts keep working** while the directory is on (`localAccountsAllowed` default true), so switching on cannot lock out the installed base. Set it to false once everyone is in the directory.
* While the directory answers, **break-glass is refused** (design says "only when LDAP is unreachable"). An administrator who wants break-glass available at all times must not flag the account.
* The mapping approval uses a **new signature meaning `DIRECTORY_MAPPING`** with QA-only; wording of its text is mine and should be reviewed by QA.
* Account state also treats **LOCKOUT (0x10) and expired `accountExpires` as refusals**, not only disabled.
* The login name field accepts UPN, sAMAccountName or mail, and `objectGUID` is the identity key (falls back to `entryUUID`). Nested group membership (`1.2.840.113556.1.4.1941`) is **not** evaluated: map the groups the people are direct members of.
* The directory is now in the validation scope: IQ must record the CA fingerprint, the server name, the search base and a sign-in of one person per mapped role.

## Not done

* **No run against a real Active Directory.** The protocol layer is exercised with the real `ldapts` only up to TLS; bind/search/result decoding is `ldapts` and not tested here. The attribute names (`objectGUID`, `userAccountControl`, `accountExpires`, `memberOf`) are AD's.
* SAML/OIDC single sign-on (not in M41), Kerberos/SSO without a password prompt, nested groups, paged group reads (a person with very many groups; `sizeLimit` applies to entries, not values).
* Automatic deactivation of `users.active` when the directory disables a person: the sign-in is refused and sessions end, but the local row stays active (the Administrator decides). A scheduled directory sync (leavers who never try to sign in again keep a valid session until its timeout; their sessions end at the next idle timeout/absolute limit).
* Linking an existing local user to the directory, and a "directory" badge in the user list of `AdminPanel` (not owned).

## For the gate

`docs/changes/r3-directory.gate.patch` (apply with `git apply`): `src/db/schema/index.ts` (export), `src/server/auth/directory/index.ts` (the `refused` result, a context argument, the directory first in the registry),
`src/server/routes/auth.ts` (pass the context, answer `refused`, directory-aware reauth, change-password refusal), `src/server/auth/credentials.ts` and `src/server/esign/authorize.ts` (directory-aware password check),
`src/server/auth/users.ts` (reset refused for directory accounts), `src/server/crypto/rotate.ts` (key rotation also moves the service-account password; report field `bindPasswords`), `tests/api/qualified-modules.test.ts` (`directory` added to the CORE list: sign-on is not switchable by the module register), `src/server/routes/index.ts`, `src/server/authz/routeTable.ts`, `src/lib/permissions.ts`, regenerated `docs/permission-matrix.csv`,
`tests/route-table.json`, `desktop/schema.sql` (`export-schema`), `tests/upgrade/upgrade-v0.1.0.test.ts` (signature meanings 48 to 49; **other R3 tracks that add meanings must add theirs to the same number**),
and the new file `src/components/shell/ext/directory.tsx`. Positions of the new permissions: 310 to 312. `desktop/schema.sql` must be regenerated at the gate after all R3 migrations are in
(`npx tsx src/server/boot/migrate-cli.ts export-schema`): the patch carries only the 0310 block.

## Evidence

* `tests/unit/directory-protocol.test.ts` 19, `tests/api/directory-signon.test.ts` 39, `tests/api/directory-ui.test.ts` 5: pass with the gate patch applied (scratch copy of the tree).
* Whole suite in the scratch copy with the patch: 1958 passed, 1 failed (`qualified-modules` CORE list, fixed by the patch line above and re-run green), 3 "unhandled error" lines from a Postgres connection terminated by another engineer's session (not a test failure).
* `tests/security-controls.sh` 34 PASS; `tests/backup-restore.sh` 18 PASS (server built from the patched tree, installed with the shipped installer, seeded); `tests/desktop-upgrade.cjs` 8 passed; `tests/desktop-shell.cjs` 17 passed (`xvfb-run -a`, after `npm run build`).
* Server type check: no new error; web type check and eslint on the new component: clean. `npm ci` from the new `package.json` + `package-lock.json` in an empty directory works.
* Test-first, honestly: the tests were written together with the implementation, and then proven to bite by mutation: `escapeFilterValue` returning its input fails 7 unit tests and the API injection test; `esign/authorize.ts` at HEAD fails the 5 directory e-signature tests.

## Follow-up 2026-10-26: concurrent first sign-ins of the same person

`directory-signon.test.ts` ("two first sign-ins ... at the same moment") failed once on a loaded machine with `[200, 401]`.

* **Cause** (reproduced: 4 simultaneous sign-ins of a new person gave a 401 in about 1 of 3 pairs; instrumented: 79 `23505 users_email_lower_uidx`, 8 "a different account already uses this e-mail address"). `syncAccount` read `directory_accounts` by `externalId`; for a person not yet provisioned `SELECT ... FOR UPDATE` locks nothing, so both transactions went on to create. The loser then either (a) hit the unique e-mail index and was repeated (worked), or (b) if the winner committed between the loser's first read and its e-mail check, saw the winner's row, took it for another person's address and answered the generic 401 (the bug). The retry on 23505 could not help (b): no error was raised.
* **Fix** (`src/server/auth/ldap.ts`): `syncAccount` first takes `pg_advisory_xact_lock(hashtextextended('directory-account:' || objectGUID))` inside its transaction (released at commit/rollback, same transaction as the audit entry). The second sign-in waits, then finds the committed account and syncs it. The 23505 retry stays only for a different person taking the address first, which then answers through the normal e-mail conflict check. Group mapping, lockouts, TOTP, audit and the rule that an existing local account is never adopted are unchanged.
* **Test**: a new case in `directory-signon.test.ts` signs in 12 new people, 3 at once each, and checks one user, one `directory_accounts` row and one `Create` audit entry per person (about 1 s). The existing twin test is unchanged. Against the old code the new case fails in most runs; with the fix 100 people x 3 passed, and the file passed 5/5 repeated runs.
