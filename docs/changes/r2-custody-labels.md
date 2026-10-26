# r2-custody-labels: receipt, chain of custody, storage, aliquots, retains, labels and scan lookup (roadmap M29)

Release R2, wave W4. Uncommitted; the wave gate commits. Companion: `docs/changes/r2-custody-labels.gate.patch` (wiring in files this track does not own).
Status: **complete once the gate patch is applied.** Without it the routes are not mounted and `tests/api/custody.test.ts` gets 404.
Resumed after a usage limit: the earlier migration, schema and protections were reviewed and kept; the test had one bug (a 4-character reason below the 5-character rule), fixed.

## What changed
| Area | Files |
|---|---|
| Migration 0220 | `drizzle/0220_custody.sql`: `storage_locations`, `sample_custody`, `sample_containers`, `custody_events` (hash-linked, append-only, balance trigger), `sample_retains`, `label_prints` (hash-linked, append-only, reprint reason CHECK); meanings CUSTODY_DEVIATION_ACK, RETAIN_DISPOSAL; permissions custody.view/handle/locations/approve, label.print (positions 220-224) |
| Schema, protections | `src/db/schema/custody.ts`, `src/db/protections/custody.ts` |
| Engine | `src/server/custody/`: `schemas.ts` (strict), `ledger.ts` (exact integer quantities, hash chain, verifier), `status.ts`, `service.ts`, `resolve.ts`, `entities.ts` (signable SampleReceipt, SampleRetain) |
| Routes, guard | `src/server/routes/custody.ts` (15 routes), `routes/resolve.ts` (`GET /resolve?code=`), `workflow/guards/custody.ts` (`custody-received` under Testing) |
| Client | `Custody.tsx` (sample panel, screen, scan sink), `LabelPrint.tsx`, `SampleLabel.tsx`, `lib/barcode.ts` (Code 128 + QR as SVG), `lib/useScanSink.ts` (wedge burst < 35 ms ending in Enter, ignored in inputs), `BarcodeScanner.tsx` (camera fallback, resolves via /resolve, camera now released) |
| Tests | `tests/api/custody.test.ts` (18), `tests/unit/custody/barcode.test.ts` (11) |

Behaviour: Logged to Testing returns 400 `TRANSITION_BLOCKED` until the sample is received; a deviation (temperature outside range or missing where a range is required, broken seal, condition other than Intact, expired) needs QA's signed acknowledgement, never the receiver. Aliquoting is two ledger rows; balance never negative (app check, 409 `INSUFFICIENT_QUANTITY`, DB trigger and CHECK). Transfers refuse a location that cannot keep the required temperature. Retains: disposal signed, only after the date, not by the registrant. Reprint without reason: 400 `REPRINT_REASON_REQUIRED`. `GET /custody/verify` recomputes both chains and finds rows changed behind the triggers. Every write is audited in its transaction; updates carry the version predicate.

## Deviation from the design
bwip-js was not added: Code 128 is drawn in `lib/barcode.ts` and QR uses the already shipped `qrcode`. Code 128 output is identical to bwip-js 4.7.0 (BWIPP) on 98 texts (all code set B values, all code set C values, check and stop symbols); run from the scratchpad, fixtures recorded in the unit test.

## Gate (see patch)
`git apply docs/changes/r2-custody-labels.gate.patch` (applies to HEAD): route registration, 16 route rules, 5 permissions (matrix defaults: view/handle/print for every role; locations/approve QA and Admin), `custodyProtections`, schema export, guard registration, shell entry, scan sink in `App.tsx`, panel in `SampleDetail.tsx`, camera scan via /resolve in `Samples.tsx`, regenerated `route-table.json`, `permission-matrix.csv`, `desktop/schema.sql`. Existing tests that start testing now call new fixture `receiveSample` (10 files); upgrade test counts 41 meanings. No assertion weakened.

## Evidence
Red: custody test on HEAD, 18 of 18 failed (routes absent). Simulation (HEAD + patch + track files, DB `lims_r2_custody_labels`): `npx vitest run` 134 files passed, 2 skipped; 1603 tests passed, 3 skipped, 0 failed. `npm run lint`: web clean, server 18 known baseline errors, none new. Not run: browser session, `npm run build` with desktop scripts, security-controls.sh and backup-restore.sh (no start-up or build file changed by this track beyond the migration; to be confirmed at the gate).

## Decisions for the user
Deviation criteria (incl. expired on receipt); temperature fit rule for storage (location range must lie inside the required range, unknown range is refused); retain disposal signed by QA/Admin who did not register it; label stock fixed at 50x25 mm; permission defaults; retention cannot be shortened or edited by any route.

## Not done
Instrument and reagent lot labels (only Sample, Container, Location); no retain-due notification (r2-events); no browser test; no URS/OQ/RTM entries (r2-validation); room/box occupancy view; the reagents track's lot-selection blockers are shown by /resolve only for expired/status text.
