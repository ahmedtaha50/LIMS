# r1-identity: accounts, sessions, roles, second factor (E02)

- `migrations/0010_identity.sql`: users (case-insensitive unique user name, scrypt hash, roles, status, TOTP, lock, version),
  sessions (only the SHA-256 of the token is stored), login failures.
- `server/identity/password.ts`: scrypt (N=2^15, r=8, p=1) with the parameters stored in the hash; policy: 12 characters,
  not containing the user name.
- `server/identity/totp.ts`: RFC 6238 without a dependency (checked against the RFC test vectors); a code of the step
  before or after is accepted (phone clock drift).
- `server/identity/roles.ts`: roles operator, supervisor, qa, admin and their permissions; QA and admin are privileged.
- `server/identity/sessions.ts`: the authorizer. Every request reads the session in the database, so a sign-out or a
  disabled account holds on every server instance. Sign-off after 15 minutes without activity and after 12 hours in all
  (EBR_SESSION_IDLE_MINUTES, EBR_SESSION_MAX_HOURS). Cookie HttpOnly, SameSite=Strict, Secure with EBR_COOKIE_SECURE=1.
  Until the first password is changed, or (privileged roles) the authenticator is set up, a session reaches only the
  'session' routes.
- Routes: sign-in, me, sign-out, own password, authenticator enrol and confirm; accounts list, create, change (with the
  version read and a reason), unlock. Five failed sign-ins within 15 minutes lock the account for 30 minutes; every
  failure, the lock and the unlock are audited; an unknown user name gets the same answer as a wrong password.
- `server/identity/index.ts`: `passwordCheck`, the check e-signatures use (E04#1).
- `server/identity/cli.ts`: the first administrator (password from EBR_ADMIN_PASSWORD, never on the command line).

Gate patch `docs/changes/r1-identity.gate.patch`: `server/main.ts` installs the authorizer; `package.json` scripts
`create-admin` and `create-admin:built`.

Evidence: `tests/api/identity.test.ts` 15 passed on PostgreSQL 16.15, with two server instances on one database.
