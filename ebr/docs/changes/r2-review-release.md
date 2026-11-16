# r2-review-release: review by exception, disposition, certified copy (E14, E15)

- `migrations/0120_review.sql`: reviews, review items, dispositions and certified copies; dispositions and copies are
  never changed (triggers).
- `server/review/service.ts`:
  - E14#1 the review of a completed batch lists the exceptions (with their deviation or closure), the comments on steps
    and late verifications (more than EBR_LATE_VERIFICATION_MINUTES, default 60), and nothing else;
  - E14#3 each item is signed "reviewed" and audited; E14#2 the review completes only when every item is reviewed and no
    exception is open;
  - E15#1 release or rejection with a QA signature, only after a complete review; final;
  - E15#2 the certified copy (PDF) is generated from the stored record: steps with values and every signature,
    exceptions, reconciliation, review items, disposition and the audit trail;
  - E15#3 the SHA-256 of each copy is registered; `POST /api/certified-copies/verify` says whether a file is a copy the
    system issued, unchanged.
- Screen `client/screens/review/`: batches to review, the items, the signatures, release or rejection, the copy.

Gate needs: `roles.ts` (review.perform and batch.release for QA); e2e seeding.

Evidence: `tests/api/review.test.ts` 6 passed (a changed copy is not genuine). Planted fault: release without a complete
review → 2 failures.

Limit: the PDF uses Helvetica: characters outside Latin-1 (Arabic) print as "?" (open item, with the Arabic decision).
