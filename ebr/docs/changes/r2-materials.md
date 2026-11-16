# r2-materials: dispensing, lot verification, yield and reconciliation (E12)

- `migrations/0110_materials.sql`: materials, lots (quarantine → released or rejected by QA, with an expiry date),
  reconciliations. `0111`: an exception raised by the reconciliation belongs to no single step.
- `server/steps/material/`: the material step. The lot is read by typing or by the tablet camera; it must be of the
  material the recipe names, released and not expired, or the step is REFUSED (a wrong lot is never used). The weight is
  checked against target ± tolerance: outside it, an exception with a comment.
- `server/materials/service.ts`: lots received in quarantine, released or rejected by QA with a signature; the
  reconciliation, once per batch and signed: yield against the theoretical batch size (site limits 95 to 102%,
  EBR_YIELD_MIN_PCT / EBR_YIELD_MAX_PCT until they are set per product: a decision) and dispensed against target per
  material; every difference beyond its limit becomes a batch exception. A batch with material steps closes only after its
  reconciliation (batch-completion hook).
- Screens: `client/screens/materials/` (materials, lots, QA release and rejection); `client/step-inputs/material.tsx` (lot,
  camera scan where the browser supports barcode detection, weight).

Gate patch: batch screen (r2-execution) uses the step-input registry and shows the reconciliation before closing;
`roles.ts` (materials.read for every role, materials.manage for the supervisor, materials.release for QA); e2e seeding.

Evidence: `tests/api/materials.test.ts` 4 passed (wrong material, quarantine, expired and unknown lots refused; tolerance;
yield 92% and a 2.5% difference raised; closing refused until reconciled). Planted fault: expiry check off → 1 failure.
