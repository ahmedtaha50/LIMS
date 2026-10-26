// A sample goes to review, and is approved, only with system suitability shown for every method that requires it (roadmap M18):
// each method bound to the sample's parameters whose Effective revision has SST criteria needs a recorded run, the latest run must
// have passed, and no result may still be one a failed run invalidated (it is entered again under a passing run). A failed run opens
// no OOS investigation: it invalidates the measurement, it does not judge the sample. Owned by r2-methods-calc.
import { sql } from 'drizzle-orm';
import { methods } from '../../../db/schema/methods';
import { bindingsOfSample } from '../../services/result-guards/method';
import { invalidResults, latestRuns } from '../../services/result-guards/sst';
import type { TransitionGuard } from './types';

export const sstPassed: TransitionGuard = {
  name: 'system-suitability',
  async check(ex, sample) {
    const bindings = await bindingsOfSample(ex, sample.id);
    const codes = [...new Set(bindings.map(b => b.methodCode).filter((c): c is string => !!c).map(c => c.toLowerCase()))];
    if (codes.length === 0) return null;
    const problems: string[] = [];
    const latest = await latestRuns(ex, sample.id);
    for (const code of codes.sort()) {
      const [method] = await ex.select().from(methods).where(sql`lower(${methods.code}) = ${code} AND ${methods.status} = 'Effective'`).limit(1);
      if (!method || !Array.isArray(method.sstCriteria) || method.sstCriteria.length === 0) continue;
      const run = latest.get(code);
      if (!run) problems.push(`No system suitability run is recorded for method ${method.code}.`);
      else if (!run.passed) problems.push(`The latest system suitability run of method ${method.code} (${run.id}) failed.`);
    }
    const invalid = await invalidResults(ex, sample.id);
    if (invalid.size > 0) {
      const names = bindings.filter(b => invalid.has(b.resultId)).map(b => b.parameter).sort();
      problems.push(`Results invalidated by a failed system suitability run must be entered again: ${names.join(', ')}.`);
    }
    return problems.length ? `System suitability: ${problems.join(' ')}` : null;
  },
};
