# R3 wave 2 gate: r3-validation

One track, built by the lead. No file outside its ownership except the gate's own: `.github/workflows/ebr.yml`,
`package.json`/lockfile (`docx` as a development dependency), the open-items register, these records.

## CI
- The tests step writes Vitest JUnit, the browser tests write Playwright JUnit, the capacity test copies its result, then
  `node validation/build/check.cjs` runs against the results of THAT run (`VALIDATION_EVIDENCE`). A renamed or failing
  referenced test now fails CI.
- The capacity step is blocking: it was informative until seen green on the runner, which it was (runs 9 and 10: PASS,
  1200 of 1200 steps, step p95 132 ms).

## Before this wave: R3 wave 1 CI red, fixed (2ed8556)
`restore.sh` met pg_restore 18 against PostgreSQL 16 (`transaction_timeout`); the backup test needed the build that CI makes
after the tests; a rejection handled late in the connection-lost test. Run 43834352149: both jobs green, logs read.

## Open items
Resolved: OI-0009 (every step type has a handler), OI-0012 (compose verified on CI). The 6 deviations of the package are in
the register.

## Checks
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 128 passed (20 files) |
| evidence collection | Vitest 128 passed, Playwright 34 passed, capacity PASS, IQ record |
| `node validation/build/check.cjs` | traceability OK: 63 requirements, 46 High |
| planted faults | failed test, renamed test, missing capacity result: each caught |
| documents | VSR and RTM converted to PDF and looked at: draft banner, blank approvals, CONDITIONAL |
