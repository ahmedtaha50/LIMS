# R1 wave 4 gate: r1-logbook, r1-mbr

Built one after the other by the lead. Before the gate the ownership audit found a flaw in the plan (r1-shell owned
`client/**`, so every screen folder of later tracks was the shell's) and a wrong folder name (two logbook screens); the plan
was corrected and committed separately (bf28486).

## Merged by hand
- `r1-logbook.gate.patch` applied cleanly (roles.ts, client/api.ts, e2e seeding).
- `r1-mbr.gate.patch` did not apply: both patches change the same three lines of `server/identity/roles.ts`. Merged by hand,
  keeping every addition: operator + logbook.read, logbook.write, mbr.read; supervisor + logbook.read, logbook.write,
  logbook.manage, logbook.type.design, mbr.read, mbr.design; QA + logbook.read, logbook.type.approve, mbr.read, mbr.approve;
  admin + logbook.read, logbook.manage. Both patches deleted.
- Derived files regenerated once: `tests/route-table.json` (38 routes), `docs/permission-matrix.csv` (29 rows).

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean (server, client, browser tests, accessibility) |
| `npm test` | 79 passed, 0 failed (10 files) |
| `npx playwright test` | 26 passed (13 tests x tablet 820x1180 and desktop 1440x900), built server |
| built server, empty database | migrations 0000 to 0040 applied (7); `/api/health` ok |
| planted fault | the two-person rule switched off at MBR approval: `tests/api/mbr.test.ts` failed 1 test, and `precommit-guard` refused the FACTORY-TEMP line; restored |
| planted fault (track) | flags switched off in the logbook limit check: 2 tests failed; restored |

## Counters
- Signature meanings 9 (unchanged). Routes 38. Roles 4. Permissions now include logbook.read, logbook.write, logbook.manage,
  logbook.type.design, logbook.type.approve, mbr.read, mbr.design, mbr.approve.

## Open (in the register)
- Logbook PDF prints characters outside Latin-1 (Arabic) as "?" until a font is embedded.
- A recipe cannot be copied into a new master yet.
- Decision: QA reviews the built-in equipment and room definitions at IQ.
