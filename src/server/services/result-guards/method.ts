/**
 * Result guards of methods and calculations (roadmap M18). Owned by r2-methods-calc; registered in ./index.ts (RESULT_GUARDS).
 *
 *   method-effective   a result of a parameter bound to a method is entered only while that method has an Effective revision, and,
 *                      when the method names an instrument type, only with an instrument of that type
 *   calculated-input   a result of a parameter bound to a formula is never typed in: its value is calculated on the server from
 *                      the raw inputs (POST /calc/samples/:id/results/:resultId writes the result_inputs row of the new result
 *                      version first, then saves the value through saveResult, so this guard sees it)
 *
 * The binding of a result is its specification parameter: samples.spec_id (the revision the sample was registered under) and the
 * spec_parameters row of that revision with the result's parameter name. Results of samples registered before 0050, or of a
 * parameter that is not bound, have no binding and pass.
 */
import { and, eq, sql } from 'drizzle-orm';
import { instruments, results } from '../../../db/schema';
import { resultInputs } from '../../../db/schema/calc';
import { methods } from '../../../db/schema/methods';
import type { Executor } from '../../core/tx';
import type { ResultGuard } from './index';

export interface ResultBinding {
  resultId: string;
  sampleId: string;
  parameter: string;
  resultVersion: number;
  value: string | null;
  decimals: number | null;
  specId: string | null;
  methodCode: string | null;
  formulaCode: string | null;
  replicates: number | null;
  stage: string | null;
}

const KEY = (column: string) => sql.raw(`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`);

/** The result with its binding (null fields when the parameter is not bound), or null when the result does not exist. */
export async function bindingOfResult(ex: Executor, resultId: string): Promise<ResultBinding | null> {
  const res = await ex.execute(sql`
    SELECT r.id AS "resultId", r.sample_id AS "sampleId", r.parameter, r.version AS "resultVersion", r.value, r.decimals,
           s.spec_id AS "specId", sp.method_code AS "methodCode", sp.formula_code AS "formulaCode", sp.replicates, sp.stage
      FROM results r
      JOIN samples s ON s.id = r.sample_id
      LEFT JOIN spec_parameters sp ON sp.spec_id = s.spec_id AND ${KEY('sp.name')} = ${KEY('r.parameter')}
     WHERE r.id = ${resultId}
     ORDER BY sp.position
     LIMIT 1`);
  return ((res as any).rows[0] as ResultBinding | undefined) ?? null;
}

/** Every result of a sample with its binding. */
export async function bindingsOfSample(ex: Executor, sampleId: string): Promise<ResultBinding[]> {
  const res = await ex.execute(sql`
    SELECT DISTINCT ON (r.id) r.id AS "resultId", r.sample_id AS "sampleId", r.parameter, r.version AS "resultVersion", r.value, r.decimals,
           s.spec_id AS "specId", sp.method_code AS "methodCode", sp.formula_code AS "formulaCode", sp.replicates, sp.stage
      FROM results r
      JOIN samples s ON s.id = r.sample_id
      LEFT JOIN spec_parameters sp ON sp.spec_id = s.spec_id AND ${KEY('sp.name')} = ${KEY('r.parameter')}
     WHERE r.sample_id = ${sampleId}
     ORDER BY r.id, sp.position`);
  return (res as any).rows as ResultBinding[];
}

/** The Effective revision of a method, or the latest revision of any status when none is Effective (null if the code is unknown). */
export async function methodByCode(ex: Executor, code: string) {
  const rows = await ex.select().from(methods).where(sql`lower(${methods.code}) = ${code.toLowerCase()}`)
    .orderBy(sql`${methods.status} = 'Effective' DESC`, sql`${methods.revision} DESC`).limit(1);
  return rows[0] ?? null;
}

export const methodEffective: ResultGuard = {
  name: 'method-effective',
  async check(ex, { resultId, instrumentId }) {
    const b = await bindingOfResult(ex, resultId);
    if (!b?.methodCode) return null;
    const method = await methodByCode(ex, b.methodCode);
    if (!method) return `${b.parameter}: the method ${b.methodCode} named by the specification does not exist. Results are entered only against an Effective method.`;
    if (method.status !== 'Effective') {
      return `${b.parameter}: method ${method.code} revision ${method.revision} is ${method.status}. Results are entered only against an Effective method: it must be approved first.`;
    }
    if (method.instrumentType) {
      if (!instrumentId) return `${b.parameter}: method ${method.code} is run on a ${method.instrumentType}. Name the instrument the result was measured on.`;
      const [inst] = await ex.select({ id: instruments.id, type: instruments.type }).from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
      if (!inst) return `${b.parameter}: instrument ${instrumentId} does not exist.`;
      if (inst.type.trim().toLowerCase() !== method.instrumentType.trim().toLowerCase()) {
        return `${b.parameter}: method ${method.code} is run on a ${method.instrumentType}; instrument ${inst.id} is a ${inst.type}.`;
      }
    }
    return null;
  },
};

export const calculatedInput: ResultGuard = {
  name: 'calculated-input',
  async check(ex, { resultId }) {
    const b = await bindingOfResult(ex, resultId);
    if (!b?.formulaCode) return null;
    const [current] = await ex.select({ version: results.version }).from(results).where(eq(results.id, resultId)).limit(1);
    const [input] = await ex.select({ id: resultInputs.id }).from(resultInputs)
      .where(and(eq(resultInputs.resultId, resultId), eq(resultInputs.resultVersion, (current?.version ?? 0) + 1))).limit(1);
    if (input) return null;
    return `${b.parameter} is calculated by formula ${b.formulaCode}: enter its raw inputs and the server calculates the value; it is never typed in.`;
  },
};
