# r3-scale: capacity for an unlimited number of users (E16)

## The test (`tests/perf/load.ts`, `npm run test:perf` after `npm run build`)
Two instances of the BUILT server on one fresh database behind a round-robin proxy (`tests/perf/proxy.ts`, which behaves as
`deploy/proxy/nginx.conf`: a refused connection goes to the next instance). 300 operators arrive over 60 seconds; each
signs in, finds and opens its own batch and records 4 signed steps (password re-checked at each signature). Halfway, one
instance is stopped for maintenance (SIGTERM).

## Results on THIS machine (4 cores, 16 GiB, shared by both instances, PostgreSQL, the proxy and the 300 simulated users)
| Scenario | sign-in p95 | open batch p95 | record a signed step p95 | failures | steps answered / in the database |
|---|---|---|---|---|---|
| realistic: 15 s between steps (`results.json`) | 136 ms | 8.6 ms | 151 ms | 0 | 1200 / 1200 |
| worst case: steps back to back (`results-worst-case.json`) | 134 ms | 8.7 ms | 136 ms | 0 | 1200 / 1200 |
This is not the reference server: the plant's server must run the same test at installation (OQ), with its own numbers.
The cost per signature is the password check (scrypt, about 100 ms of CPU, deliberately); one core signs about ten steps
per second.

## Found by the test, and fixed
1. **Product (r1-core):** a database connection ended while a request held it (database restart, failover) emitted an
   unhandled `error` and crashed the whole server process. `server/core/db.ts` now listens on every client.
   Regression test `tests/perf/connection-lost.test.ts` (fails without the fix: "Unhandled Errors").
2. **Product (r2-execution):** the batch list returns the latest 200 batches with no search, so operators 201 to 300 could
   not find their batch. `GET /api/batches?number=` finds one batch by its number.
3. **My test, twice:** the first run killed the instance (SIGKILL) instead of stopping it, and the first proxy retried a
   refused request on the global rotation, which could pick the stopped instance again. Both corrected; the fixed test is
   the one reported above.

## Other
- `tests/perf/no-user-limit.test.ts` (E16#3): no licence check, seat count or user maximum in the server code.
- `deploy/proxy/nginx.conf`: TLS, two instances, retry on refused connections only.

## Gate needs
`server/core/db.ts` (r1-core) and `server/batch/service.ts`, `server/routes/batch.ts` (r2-execution) through a gate patch;
`package.json` script `test:perf`; the capacity test as an informative CI step.
