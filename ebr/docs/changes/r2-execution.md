# r2-execution: batches from effective recipes, steps in order, exceptions (E10, E11)

- `migrations/0100_batches.sql`: batches (with the exact MBR version), their steps copied from that version at creation, and
  exceptions. A recorded step cannot change in the database (trigger): only its verification can be added once.
- `server/batch/steps.ts`: the step registry is a directory: `server/steps/<group>/index.ts` exports `handlers`. This track
  provides `server/steps/core` (instruction, signature, verified, recorded value, calculation); r2-materials and
  r2-interlock add folders. A step type without a handler is refused with the reason, never skipped.
- `server/batch/service.ts`, the engine:
  - E10#1 a batch only from an effective recipe version, which it keeps;
  - E10#2 one step at a time in the recipe's order, and a step waiting for its second person (type "verified" or marked
    critical) blocks the ones after it; the verifier must be another person (server-side);
  - E10#3 every value is signed with performer and server time, and states the version it read: a second tablet writing
    the same step with a stale version gets 409 (tested with two concurrent writes);
  - E11#1 a value outside its limits is recorded, an exception is raised at once and a comment is required; the batch
    cannot be closed while a step is missing or unverified or an exception is open;
  - E11#2 an exception is handed to a deviation by number (kept on the batch) or closed with a signed justification;
  - E11#3 calculated values are computed on the server from the recorded values with the formula engine of r1-mbr; a value
    sent by the client is refused.
- Screen `client/screens/batch/`: batch list, new batch from an effective recipe, the current step with its signature,
  verification by the second person, exceptions, closing the batch.

Gate patch `docs/changes/r2-execution.gate.patch`: `server/identity/roles.ts` (batch permissions: operator read/execute;
supervisor create/execute/exception/complete; QA read) and `tests/e2e/support/server.mjs` (a second operator and one
effective recipe per viewport).

Evidence: `tests/api/batch.test.ts` 8 passed; planted faults: step order switched off → 4 tests failed; client-sent
calculated value accepted → 2 tests failed; both restored. `tests/e2e/batch.spec.ts` 2 passed (tablet and desktop) with the
gate patch applied: three people in three browsers, the performer refused as verifier.

Not done: steps of type material, equipment and sample have no handler yet (r2-materials, r2-interlock; sample in r3-lims-link).
