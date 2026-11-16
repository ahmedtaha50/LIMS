# R6 gate: complete screens and demo

Built one after the other by the lead (r6-screens, r6-demo).

## Merged
- Route table (70 routes), the e2e seed (an administrator with every role per viewport), `package.json` scripts, the CI
  compose job (demo data inside the container), README.md.
- Validation package: URS-E32 and URS-E33 moved from GAP to their tests; DEV-2026-11-16-09 closed.

## Found during the release
- Seven groups of functions reachable only through the API (now screens, and a test keeps it so).
- Checkboxes and radio buttons were 20 px against the 44 px rule, in four screens: all 44 px now.
- A silent catch was written on the way (new logbook type version) and replaced before the commit.
- The r6-demo commit went in with a type error and the E16#3 guard failing (the demo counted users): the checks had been
  chained before the commit with ';'. Fixed in the next commit, before any push; a row in the failure catalogue.

## Checks
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 175 passed (32 files) |
| Playwright | 40 passed (34 English, 4 Arabic, 2 new screens), tablet and desktop |
| built demo command | written on an empty database, refused on the second run (exit 1) |
| planted faults | the users screen hidden: the coverage test names its four routes |

## Not verified
- The LIMS samples card and the certified copy upload in a browser (their APIs are tested); everything that needs the
  plant (open deviations).
