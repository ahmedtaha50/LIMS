# r4-harness: the test harness refuses to run without its database (E25)

- `tests/unit/harness.test.ts` runs Vitest in a child process with `TEST_ADMIN_URL` pointing at a port where nothing
  listens: the run exits non-zero, says "PostgreSQL is not reachable ... The tests do not skip", runs no test and skips none.
- The validation package: URS-E01-1 now has this executed test; DEV-2026-11-16-01 (that part was supported by reading
  only) is CLOSED with it.

Evidence: 1 test passed. Planted fault: the global setup exiting 0 when the database is missing: caught.
