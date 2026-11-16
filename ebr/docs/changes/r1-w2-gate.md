# R1 wave 2 gate: r1-audit-esign, r1-shell

Built one after the other by the lead (no parallel agents: the user did not ask for them). Before the wave the plan was
corrected: r1-identity moved to wave 3 because it writes audit entries (E02#1 needs E03).

## Merged
- `r1-shell.gate.patch` applied cleanly with `git apply` (package.json, lockfile, vite.config.ts, server/app.ts,
  server/main.ts), then `npm install` to confirm the lockfile, then the patch was deleted.
- Derived file regenerated once: `tests/route-table.json` (5 routes: health public; audit read and verify; signatures and
  meanings), reviewed: every route has a permission, all except health need a session.
- `.gitignore`: Playwright output. `.github/workflows/ebr.yml`: the browser tests on the built application.

## Integration fix
- The server's TypeScript project now included the browser tests, which use browser types (`document`, `caches`): the
  type check failed only after merging. `tests/e2e/` has its own TypeScript project, and `npm run lint` checks all four
  (server, client, browser tests, accessibility lint).

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 32 passed, 0 failed (5 files) |
| `npm run build` | server and client built |
| `npx playwright test` | 10 passed: 5 tests at tablet 820x1180 and desktop 1440x900, built server, fresh database |
| built server on an empty database | `migrations applied: 0000_jobs, 0020_audit, 0021_signatures`; `/` 200; `/api/health` ok; `/api/audit/verify` 401 (fails closed) |
| planted faults | buttons of 32 px failed the 44 px test at both sizes; a `div` with a click handler failed the accessibility lint |
| ownership audit | passed after the plan named `tests/e2e/support/**` (committed separately) |

## What could differ in CI
- CI installs Chromium with `playwright install --with-deps`; here the preinstalled Chromium of the same Playwright
  version (1.63.0) ran.
- Not repeated here: the tests as an unprivileged user (they reach PostgreSQL over TCP; no file modes are tested).

## Counters
- Signature meanings: 9 (asserted in tests/api/esign.test.ts). Permissions named by routes: audit.read, audit.verify,
  signatures.read, session.
