# r2-interlock: equipment interlock and automatic logbook entries (E13)

- Engine extension (gate patch to r2-execution's `server/batch/steps.ts` and `service.ts`, needed by this track and
  r2-materials): a step handler may return `effects`, run after the step is signed in the same transaction with that
  signature; a handler group may export `onBatchComplete`, run in the closing transaction (it may refuse the closing).
- `server/interlock/`: the logbook row is locked, so two batches cannot take the same equipment at once; the derived status
  must be clean (a dirty, in-use, on-hold or out-of-calibration item is refused with the reason); the use is written into
  its logbook by the system, signed with the operator's step signature.
- `server/steps/equipment/`: the equipment step (fixed code from the recipe, or typed / scanned). On signing, "start of use"
  with product and batch in the item's logbook; when the batch closes, "end of use" in every logbook it used, which makes
  the equipment dirty (E13#3).
- `client/step-inputs/equipment.tsx`: the code field.

Evidence: `tests/api/interlock.test.ts` 3 passed (dirty and out-of-calibration refused; in use for one batch refused for a
second one; start and end of use written; dirty after closing). Planted fault: status check off → 3 failures.
