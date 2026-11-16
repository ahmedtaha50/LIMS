# R2 wave 1 gate: r2-execution

One track, built by the lead.

## Merged
- `r2-execution.gate.patch` applied cleanly (roles.ts batch permissions; e2e seeding), then deleted.
- Derived files regenerated once: `tests/route-table.json` (46 routes), `docs/permission-matrix.csv`.

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean (server, client, browser tests, accessibility) |
| `npm test` | 87 passed, 0 failed (11 files) |
| `npx playwright test` | 28 passed (14 tests x tablet and desktop), built server |
| built server, empty database | 8 migrations applied; `/api/health` ok |
| planted faults (track) | step order off: 4 failures; client-sent calculation accepted: 2 failures; restored |

## Counters
- Signature meanings 9 (unchanged; batch steps use performed, verified, reviewed). Routes 46.
- New permissions: batch.read, batch.create, batch.execute, batch.exception, batch.complete.

## Environment note
- PostgreSQL was down when the session resumed (container restart): started with `pg_ctlcluster 16 main start`; no product
  change.
