# R1 wave 1 gate: r1-core

One track, built by the lead (no parallel agents in this wave: one track). Nothing to merge by hand, no gate patch.

## Checks (fresh databases, this machine)
| Check | Command | Result |
|---|---|---|
| Type check | `npm run lint` | clean |
| Tests | `npm test` | 19 passed, 0 failed (3 files), PostgreSQL 16.15, a fresh database per test file |
| No skipping | `npm test` with PostgreSQL stopped | exit 1, "PostgreSQL is not reachable ... The tests do not skip" |
| Build and start | `npm run build`; `node dist/server/main.js` on an empty database | `migrations applied: 0000_jobs`; `/api/health` status ok |
| Ownership | `factory.cjs exit wave --tracks r1-core` | passed after the plan was corrected (four skeleton files were not in ownsFiles; the plan now names them, committed separately) |
| Commit hygiene | `precommit-guard.cjs` | no temporary edit, focused or skipped test, secret or junk |

## What could differ in CI
- The PostgreSQL service in CI is the `postgres:16` image (here: Ubuntu's 16.15) with user `ebr` as superuser.
- The run as an unprivileged user and on a non-C collation was not repeated here: nothing in r1-core sorts text or reads
  file permissions.

## Open
- OI: E01#4 is met only when the first run of `.github/workflows/ebr.yml` has been read.
