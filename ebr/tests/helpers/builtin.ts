import type { Pool } from '../../server/core/db.js';

/**
 * Test setup for suites that write on the built-in equipment and room logbooks (E28): marks their installed versions as
 * reviewed by QA, as the QA review at installation qualification would. The review itself (signature, refusal before it)
 * is tested through its endpoint in tests/api/logbook-review.test.ts.
 */
export async function builtInTypesReviewed(pool: Pool) {
  await pool.query("UPDATE logbook_type_versions SET needs_qa_review = false, qa_reviewed_by = 'test setup (QA review at IQ)', qa_reviewed_at = now() WHERE needs_qa_review");
}
