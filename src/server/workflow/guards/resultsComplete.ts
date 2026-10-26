// A sample goes to review only with every result entered (21 CFR 211.194(a): the record holds the results of all tests).
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { results } from '../../../db/schema';
import type { TransitionGuard } from './types';

export const resultsComplete: TransitionGuard = {
  name: 'results-complete',
  async check(ex, sample) {
    const missing = await ex.select({ parameter: results.parameter }).from(results)
      .where(and(eq(results.sampleId, sample.id), or(isNull(results.value), eq(results.value, ''))))
      .orderBy(results.parameter);
    const [{ n }] = await ex.select({ n: sql<number>`count(*)::int` }).from(results).where(eq(results.sampleId, sample.id));
    if (n === 0) return 'The sample has no results to review.';
    if (missing.length > 0) return `Results not entered: ${missing.map(m => m.parameter).join(', ')}. Every result must be entered before review.`;
    return null;
  },
};
