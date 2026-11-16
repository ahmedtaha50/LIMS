# R2 wave 2 gate: r2-materials, r2-interlock, r2-review-release

Built one after the other by the lead. Before and during the wave the plan was corrected twice (step inputs per track and the
engine hooks; browser tests and the step-input type file), each committed on its own.

## Merged
- `r2-interlock.gate.patch` (engine extension in r2-execution's `server/batch/steps.ts` and `service.ts`: effects after the
  signature, batch-completion hooks) and `r2-materials.gate.patch` (batch screen: step-input registry and the
  reconciliation; `roles.ts` for the whole wave, including review.perform and batch.release asked for by
  r2-review-release; e2e seeding and the e2e helper) applied cleanly, in that order, then deleted.
- Derived files regenerated once: `tests/route-table.json` (61 routes), `docs/permission-matrix.csv`.

## Integration fix
- `tests/api/batch.test.ts` (r2-execution) asserted that a material step is refused as "not available yet". That was
  true until this wave, which adds the material handler: a deliberate change of behaviour. The test now uses a type whose
  handler comes later (sample, r3-lims-link); the refusal it checks is unchanged.

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 100 passed, 0 failed (14 files) |
| `npx playwright test` | 34 passed (17 tests x tablet and desktop), built server |
| built server, empty database | 11 migrations; `/api/health` ok |
| planted faults (tracks) | expiry check off: 1 failure; equipment status check off: 3; release without review: 2; restored |

## Counters
- Signature meanings 9 (unchanged). Routes 61. New permissions: materials.read, materials.manage, materials.release,
  review.perform, batch.release.

## Open (in the register)
- Yield limits are a site setting (95 to 102%): per product? (decision)
- Certified copy and logbook PDF print Arabic as "?" until a font is embedded.
- The camera scan uses the browser's barcode detection where it exists (Chrome on Android tablets); elsewhere the lot is typed.
  Not tested on a real tablet camera here.
