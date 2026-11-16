# R1 wave 3 gate: r1-identity

## Merged
- `r1-identity.gate.patch` applied cleanly (server/main.ts installs the authorizer; package.json `create-admin` scripts),
  then deleted.
- Derived files regenerated once: `tests/route-table.json` (15 routes) and `docs/permission-matrix.csv` (new; 4 roles,
  14 role-permission rows). New check `tests/api/permission-matrix.test.ts`: the file matches `server/identity/roles.ts`,
  and every permission a route asks for is granted by some role.

## Integration (files of r1-shell, done at the gate)
- `client/shell/Account.tsx`: the first-password change and the authenticator set-up; the shell shows them before
  anything else while the session is restricted.
- `tests/e2e/shell-signin.spec.ts` and the seeding in `tests/e2e/support/server.mjs`: a real sign-in, a refused password,
  and the first-password change, at both viewports. This closes r1-shell's open item (the stand-in for /api/auth/me).
- My own mistake, caught before commit: the first version of the password-change test used `test.skip` for the desktop
  run. Replaced by one account per viewport, so the test runs at both and nothing is skipped.

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean (server, client, browser tests, accessibility) |
| `npm test` | 49 passed, 0 failed (7 files) |
| `npx playwright test` | 16 passed (8 tests x tablet and desktop), built server |
| built server, empty database, `node dist/server/identity/cli.js admin` | administrator created; sign-in returns a session restricted to `session` with `mustChangePassword: true`; `/api/users` answers 403 until then |

## Counters
- Signature meanings 9. Roles 4. Routes 15. Permissions: session, signatures.read, audit.read, audit.verify, users.manage.

## Decision for the user (in the register)
- Sign-off after 15 minutes idle, 12 hours at most; lock for 30 minutes after 5 failures in 15 minutes.
