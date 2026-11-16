# r5-builtin-review: QA review of the built-in logbook types (E28)

Decision implemented: the built-in equipment and room logbook types are NOT usable from installation; QA reviews them
first (the safer of the two options of OI-0007).

- `migrations/0310_builtin_type_review.sql`: `needs_qa_review`, `qa_reviewed_by`, `qa_reviewed_at`; the versions installed by
  0031 (author `installation`) are marked; a trigger refuses any entry with a version that waits for its review.
- `server/logbook/review.ts`: the check with its reason (409 `type_not_reviewed`), and the review: QA (permission
  `logbook.type.approve`), password, a remark, signature meaning `reviewed`, audit `logbook_type.qa_reviewed`.
- `POST /api/logbook-types/:typeId/versions/:versionId/qa-review`.

Gate needs: `server/logbook/service.ts` (the check in `writeEntry`; review fields in the version view), `server/interlock/
index.ts` (the check first in `assertReady`, so the real reason is shown, and before writing a use), the e2e seed and the
setup of the logbook and interlock suites (`tests/helpers/builtin.ts`: marks the built-ins reviewed, as at IQ); route table.

Found by a suspicious pass: the first migration marked nothing (`approved_by` of 0031 is "installation (reviewed at IQ)",
not "installation"), and the old tests still passed; it marks by author now, and the new tests prove the refusal.

Evidence: `tests/api/logbook-review.test.ts` 4 passed. Planted fault: the service check removed (only the trigger left):
caught, the reason is part of the requirement.
