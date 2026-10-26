/**
 * Domain: calculations (roadmap M18). Owned by r2-methods-calc. The engine is src/server/lib/calc.ts: deterministic, offline, no AI.
 *
 *   GET  /calc/formulas                   every revision of every formula
 *   POST /calc/formulas                   revision 1, a Draft. The expression is compiled here: a forbidden name or call, an input
 *                                         the expression uses but does not declare, or one it declares but does not use, is a 400
 *   PUT  /calc/formulas/:id               a Draft only (423), version predicate (409)
 *   POST /calc/formulas/:id/revise        the next revision, cloned from the Effective one
 *   POST /calc/formulas/:id/approve       FORMULA_APPROVAL, never by the author or an editor. Refused (400, before any signature) when
 *                                         there is no test case or a test case does not reproduce its hand-calculated value
 *   POST /calc/evaluate                   tries an expression on inputs; nothing is written
 *   GET  /calc/samples/:id                every result of the sample with its binding, its latest calculation and its validity, and
 *                                         the system suitability runs
 *   POST /calc/samples/:id/results/:rid   a calculated result: the raw inputs only. In ONE transaction: the Effective revision of the
 *                                         parameter's formula calculates the value (rounded once, to the limit's decimals), the inputs
 *                                         are kept in result_inputs with the formula revision and expression, and the value is saved
 *                                         through saveResult (roles, state, version, guards, OOS) like a typed one
 *   POST /calc/samples/:id/sst            a system suitability run of a method: every criterion calculated and judged; a failed run
 *                                         invalidates the method's results on the sample (audited) and opens no OOS investigation.
 *                                         The run's instrument is Active, calibrated, and of the method's instrument type
 */
import { randomBytes } from 'crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { instruments, samples } from '../../db/schema';
import { calcFormulas, resultInputs, sstRuns } from '../../db/schema/calc';
import { methods } from '../../db/schema/methods';
import { writeAudit } from '../../db/utils';
import { RESULT_ENTRY_ROLES, RESULT_ENTRY_STATE } from '../../lib/constants/results';
import type { ResultChangeCode } from '../services/result-hooks/codes';
import { compareDecimal, limitText } from '../../lib/numeric';
import { calibrationState } from '../../lib/validations/instruments';
import {
  calcEntrySchema, calcEvaluateSchema, configApproveSchema, formulaCreateSchema, formulaUpdateSchema, reviseSchema, sstRunSchema,
  type FormulaInput, type FormulaTestCase, type SstCriterion,
} from '../../lib/validations/methods';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, withTransaction, type Executor } from '../core/tx';
import { asSigned, registerSignable } from '../esign';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { calculate, compileFormula, FormulaError, type CompiledFormula, type Inputs } from '../lib/calc';
import { evaluateResult } from '../lib/evaluate';
import { bindingOfResult, bindingsOfSample, methodByCode } from '../services/result-guards/method';
import { invalidResults } from '../services/result-guards/sst';
import { saveResult } from '../services/saveResult';
import { approveConfig, createConfig, effectiveByCode, listConfig, reviseConfig, updateConfig } from './methods';

type FormulaRow = typeof calcFormulas.$inferSelect;
type MethodRow = typeof methods.$inferSelect;

registerSignable({
  type: 'CalcFormula',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(calcFormulas).where(eq(calcFormulas.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, code: row.code, name: row.name, expression: row.expression, inputs: row.inputs, unit: row.unit, testCases: row.testCases,
      revision: row.revision, status: asSigned(change, ['status'], row.status),
    };
  },
});

/** A FormulaError as a 400 that says what is wrong; anything else is thrown as it is. */
function asBadRequest<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof FormulaError) throw new BadRequestError(`${what}: ${e.message}`);
    throw e;
  }
}

/** Compiles the expression and checks it uses exactly the declared inputs. */
function compileDeclared(expression: string, inputs: readonly FormulaInput[]): CompiledFormula {
  const compiled = asBadRequest('The expression', () => compileFormula(expression));
  const declared = new Set(inputs.map(i => i.name));
  const undeclared = compiled.variables.filter(v => !declared.has(v));
  if (undeclared.length) throw new BadRequestError(`The expression uses ${undeclared.join(', ')}, which ${undeclared.length > 1 ? 'are' : 'is'} not a declared input.`);
  const unused = inputs.filter(i => !compiled.variables.includes(i.name)).map(i => i.name);
  if (unused.length) throw new BadRequestError(`The input${unused.length > 1 ? 's' : ''} ${unused.join(', ')} ${unused.length > 1 ? 'are' : 'is'} declared but not used by the expression.`);
  return compiled;
}

/**
 * The values match the declared inputs: every input and nothing else; a replicate input holds a list (of exactly `replicates`
 * values when that is given), any other input one number.
 */
function assertInputsMatch(where: string, declared: readonly FormulaInput[], values: Inputs, replicates: number | null = null) {
  const names = new Set(declared.map(d => d.name));
  const extra = Object.keys(values).filter(k => !names.has(k));
  if (extra.length) throw new BadRequestError(`${where}: ${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} not an input of the formula.`);
  for (const d of declared) {
    if (!Object.prototype.hasOwnProperty.call(values, d.name)) throw new BadRequestError(`${where}: the input ${d.name} has no value.`);
    const v = values[d.name];
    if (d.replicates && !Array.isArray(v)) throw new BadRequestError(`${where}: ${d.name} takes replicates; send a list of values.`);
    if (!d.replicates && Array.isArray(v)) throw new BadRequestError(`${where}: ${d.name} takes one value, not a list.`);
    if (d.replicates && replicates !== null && (v as readonly number[]).length !== replicates) {
      throw new BadRequestError(`${where}: ${d.name} needs ${replicates} replicate value${replicates > 1 ? 's' : ''}; ${(v as readonly number[]).length} were given.`);
    }
  }
}

/** Every test case of a formula reproduces its hand-calculated value, or the approval is refused (400, before any signature). */
function assertTestCasesPass(f: FormulaRow) {
  const cases = (f.testCases ?? []) as FormulaTestCase[];
  if (cases.length === 0) {
    throw new AppError(400, 'FORMULA_UNTESTED', `Formula ${f.code} revision ${f.revision} has no test case. Add at least one case with a hand-calculated value before approval.`);
  }
  const compiled = compileDeclared(f.expression, f.inputs as FormulaInput[]);
  const failures: string[] = [];
  for (const c of cases) {
    try {
      assertInputsMatch(`Test case "${c.name}"`, f.inputs as FormulaInput[], c.inputs);
      const out = calculate(compiled, c.inputs, c.decimals);
      if (compareDecimal(out.reported, c.expected) !== 0) failures.push(`Test case "${c.name}": the server calculates ${out.reported} (raw ${out.raw}); the expected value is ${c.expected}.`);
    } catch (e) {
      if (e instanceof FormulaError || e instanceof BadRequestError) failures.push(`Test case "${c.name}": ${e.message}`);
      else throw e;
    }
  }
  if (failures.length) throw new AppError(400, 'FORMULA_TEST_FAILED', failures.join(' '), failures);
}

/** The limit of an SST criterion, in the evaluator's terms (decimal text to the declared decimals). */
const criterionLimit = (c: SstCriterion) => ({
  limitKind: c.limit_kind, lower: limitText(c.lower, c.decimals), upper: limitText(c.upper, c.decimals), decimals: c.decimals, text: null,
});
const limitWords = (c: SstCriterion) => (c.limit_kind === 'NMT' ? `NMT ${limitText(c.upper, c.decimals)}` : c.limit_kind === 'NLT'
  ? `NLT ${limitText(c.lower, c.decimals)}` : `${limitText(c.lower, c.decimals)} - ${limitText(c.upper, c.decimals)}`);

async function effectiveFormula(ex: Executor, code: string, where: string): Promise<FormulaRow> {
  const f = await effectiveByCode<FormulaRow>(ex, 'CalcFormula', code);
  if (!f) throw new BadRequestError(`${where}: formula ${code} has no Effective revision. A calculation uses only an approved formula.`);
  return f;
}

/**
 * The instrument of a system suitability run: when the method names an instrument type, the run names an instrument of that type;
 * a named instrument exists, is Active and is within its calibration (the rule of the calibrated-instrument result guard).
 */
async function assertRunInstrument(ex: Executor, method: MethodRow, instrumentId: string | undefined) {
  if (!instrumentId) {
    if (method.instrumentType) throw new BadRequestError(`Method ${method.code} is run on a ${method.instrumentType}. Name the instrument of the system suitability run.`);
    return;
  }
  const [inst] = await ex.select().from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  if (!inst) throw new BadRequestError(`Instrument ${instrumentId} does not exist.`);
  if (method.instrumentType && inst.type.trim().toLowerCase() !== method.instrumentType.trim().toLowerCase()) {
    throw new BadRequestError(`Method ${method.code} is run on a ${method.instrumentType}; instrument ${inst.id} is a ${inst.type}.`);
  }
  if (inst.status !== 'Active') throw new BadRequestError(`Instrument ${inst.id} is ${inst.status}. Only Active instruments can be used.`);
  if (calibrationState(inst.calibrationDueDate).expired) {
    throw new BadRequestError(`Instrument ${inst.id} (${inst.name}) is past its calibration due date (${inst.calibrationDueDate}). Testing is blocked.`);
  }
}

const newId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`;

export const calcRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // ---- formulas ----------------------------------------------------------------------------------------------------------------

  router.get('/calc/formulas', requireAuth, async (_req, res) => {
    res.json(await listConfig(db, 'CalcFormula'));
  });

  router.post('/calc/formulas', requireAuth, validate(formulaCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as { code: string; name: string; expression: string; inputs: FormulaInput[]; unit: string | null; testCases: FormulaTestCase[] };
    compileDeclared(body.expression, body.inputs);
    res.json(await createConfig<FormulaRow>(db, user, 'CalcFormula', body));
  });

  router.put('/calc/formulas/:id', requireAuth, validate(formulaUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const { expectedVersion, ...changes } = req.body as Record<string, unknown> & { expectedVersion: number };
    res.json(await updateConfig<FormulaRow>(db, user, 'CalcFormula', String(req.params.id), expectedVersion, changes, async (_tx, row, c) => {
      compileDeclared((c.expression as string | undefined) ?? row.expression, (c.inputs as FormulaInput[] | undefined) ?? (row.inputs as FormulaInput[]));
    }));
  });

  router.post('/calc/formulas/:id/revise', requireAuth, validate(reviseSchema), async (req, res) => {
    const user = (req as any).user;
    res.json(await reviseConfig<FormulaRow>(db, user, 'CalcFormula', String(req.params.id), r => ({
      name: r.name, expression: r.expression, inputs: r.inputs, unit: r.unit, testCases: r.testCases,
    })));
  });

  router.post('/calc/formulas/:id/approve', requireAuth, validate(configApproveSchema), async (req, res) => {
    const user = (req as any).user;
    const { password, totpCode, reason, expectedVersion } = req.body as { password: string; totpCode?: string; reason?: string; expectedVersion: number };
    const { result, signature } = await approveConfig<FormulaRow>({
      db, req, user, kind: 'CalcFormula', id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason,
      precheck: async (_ex, row) => assertTestCasesPass(row),
    });
    res.json({ formula: result, signature });
  });

  router.post('/calc/evaluate', requireAuth, validate(calcEvaluateSchema), async (req, res) => {
    const { expression, inputs, decimals } = req.body as { expression: string; inputs: Inputs; decimals: number | null };
    const compiled = asBadRequest('The expression', () => compileFormula(expression));
    const out = asBadRequest('The calculation', () => calculate(compiled, inputs, decimals));
    res.json({ ...out, variables: compiled.variables, functions: compiled.functions });
  });

  // ---- a sample's calculations -------------------------------------------------------------------------------------------------

  router.get('/calc/samples/:id', requireAuth, async (req, res) => {
    const sampleId = String(req.params.id);
    const [sample] = await db.select({ id: samples.id }).from(samples).where(eq(samples.id, sampleId)).limit(1);
    if (!sample) throw new NotFoundError(`Sample ${sampleId} was not found.`);
    const bindings = await bindingsOfSample(db, sampleId);
    const inputs = await db.select().from(resultInputs).where(eq(resultInputs.sampleId, sampleId)).orderBy(desc(resultInputs.enteredAt));
    const invalid = await invalidResults(db, sampleId);
    const runs = await db.select().from(sstRuns).where(eq(sstRuns.sampleId, sampleId)).orderBy(asc(sstRuns.performedAt));
    res.json({
      sampleId,
      results: bindings.sort((a, b) => a.parameter.localeCompare(b.parameter)).map(b => {
        const latest = inputs.find(i => i.resultId === b.resultId && i.resultVersion === b.resultVersion) ?? null;
        const run = invalid.get(b.resultId);
        return {
          resultId: b.resultId, parameter: b.parameter, version: b.resultVersion, methodCode: b.methodCode, formulaCode: b.formulaCode,
          replicates: b.replicates, stage: b.stage, calculation: latest,
          validity: run ? { status: 'Invalid', runId: run.id, reason: `System suitability run ${run.id} of ${run.methodCode} failed` } : { status: 'Valid' },
        };
      }),
      sstRuns: runs,
    });
  });

  router.post('/calc/samples/:id/results/:resultId', requireAuth, validate(calcEntrySchema), async (req, res) => {
    const user = (req as any).user;
    const sampleId = String(req.params.id);
    const resultId = String(req.params.resultId);
    const { inputs, reason, expectedVersion, instrumentId, oosId, reasonCode } = req.body as {
      inputs: Inputs; reason: string; expectedVersion: number; instrumentId?: string; oosId?: string; reasonCode?: ResultChangeCode;
    };
    if (!RESULT_ENTRY_ROLES.includes(user.role)) {
      throw new ForbiddenError(`Forbidden: results are entered by ${RESULT_ENTRY_ROLES.join(' or ')}; a ${user.role} reviews them.`);
    }

    const out = await withTransaction(db, async (tx, afterCommit) => {
      await lockRow(tx, samples, sampleId);
      const b = await bindingOfResult(tx, resultId);
      if (!b || b.sampleId !== sampleId) throw new NotFoundError('Result not found.');
      if (!b.formulaCode) throw new BadRequestError(`${b.parameter} is not a calculated parameter: its specification names no formula. Enter its value.`);
      if (b.resultVersion !== expectedVersion) throw new ConflictError();

      const formula = await effectiveFormula(tx, b.formulaCode, b.parameter);
      const declared = formula.inputs as FormulaInput[];
      assertInputsMatch(b.parameter, declared, inputs, b.replicates);
      const calc = asBadRequest(`${b.parameter}`, () => calculate(formula.expression, inputs, b.decimals));

      // Written first, for the result version the save below produces: the calculated-input guard looks for it.
      const input = {
        id: newId('RIN'), resultId, sampleId, resultVersion: b.resultVersion + 1, formulaId: formula.id, formulaRevision: formula.revision,
        expression: formula.expression, inputs: inputs as Record<string, number | number[]>, rawValue: calc.raw, reportedValue: calc.reported,
        decimals: b.decimals, instrumentId: instrumentId ?? null, enteredBy: user.id,
      };
      const [stored] = await tx.insert(resultInputs).values(input).returning();
      const saved = await saveResult({
        tx, afterCommit, io: (req as any).io, user, sampleId, resultId,
        input: { value: calc.reported, reason, expectedVersion, instrumentId, oosId, reasonCode },
      });
      await writeAudit(tx, user.id, 'Create', 'ResultInput', stored.id, 'all', '', JSON.stringify({
        resultId, resultVersion: stored.resultVersion, formula: `${formula.code} revision ${formula.revision} (${formula.id})`, expression: formula.expression,
        inputs, raw: calc.raw, reported: calc.reported, decimals: b.decimals,
      }), `${b.parameter} calculated by ${formula.code} revision ${formula.revision}: ${reason}`);
      const { oosInvestigationId, ...result } = saved;
      return { result, input: stored, oosInvestigationId };
    });
    res.json(out);
  });

  router.post('/calc/samples/:id/sst', requireAuth, validate(sstRunSchema), async (req, res) => {
    const user = (req as any).user;
    const sampleId = String(req.params.id);
    const body = req.body as { methodCode: string; criteria: Array<{ name: string; inputs: Inputs }>; reason: string | null; instrumentId?: string };
    if (!RESULT_ENTRY_ROLES.includes(user.role)) {
      throw new ForbiddenError(`Forbidden: system suitability runs are recorded by ${RESULT_ENTRY_ROLES.join(' or ')}.`);
    }

    const out = await withTransaction(db, async (tx) => {
      const sample = await lockRow(tx, samples, sampleId);
      if (sample.state !== RESULT_ENTRY_STATE) {
        throw new AppError(409, 'SAMPLE_NOT_IN_TESTING', `System suitability is recorded while the sample is in ${RESULT_ENTRY_STATE}; sample ${sampleId} is ${sample.state}.`);
      }
      const method = await methodByCode(tx, body.methodCode) as MethodRow | null;
      if (!method || method.status !== 'Effective') {
        throw new BadRequestError(method ? `Method ${method.code} revision ${method.revision} is ${method.status}: system suitability is recorded only for an Effective method.` : `Method ${body.methodCode} does not exist.`);
      }
      await assertRunInstrument(tx, method, body.instrumentId);
      const bindings = (await bindingsOfSample(tx, sampleId)).filter(b => b.methodCode?.toLowerCase() === method.code.toLowerCase());
      if (bindings.length === 0) throw new BadRequestError(`No parameter of sample ${sampleId} is tested by method ${method.code}.`);
      const criteria = (method.sstCriteria ?? []) as SstCriterion[];
      if (criteria.length === 0) throw new BadRequestError(`Method ${method.code} revision ${method.revision} has no system suitability criteria.`);

      const given = new Map(body.criteria.map(c => [c.name.trim().toLowerCase(), c]));
      if (given.size !== body.criteria.length) throw new BadRequestError('Each criterion is recorded once per run.');
      const unknown = body.criteria.filter(c => !criteria.some(k => k.name.trim().toLowerCase() === c.name.trim().toLowerCase())).map(c => c.name);
      if (unknown.length) throw new BadRequestError(`Not a criterion of method ${method.code}: ${unknown.join(', ')}.`);
      const missing = criteria.filter(k => !given.has(k.name.trim().toLowerCase())).map(k => k.name);
      if (missing.length) throw new BadRequestError(`The run must record every criterion of method ${method.code}; missing: ${missing.join(', ')}.`);

      const outcomes: Array<{
        name: string; formulaId: string; formulaCode: string; formulaRevision: number; expression: string; inputs: Inputs;
        raw: string; reported: string; limit: string; passed: boolean;
      }> = [];
      for (const c of criteria) {
        const entry = given.get(c.name.trim().toLowerCase())!;
        const formula = await effectiveFormula(tx, c.formulaCode, c.name);
        assertInputsMatch(c.name, formula.inputs as FormulaInput[], entry.inputs, c.replicates);
        const calc = asBadRequest(c.name, () => calculate(formula.expression, entry.inputs, c.decimals));
        const judged = evaluateResult(calc.reported, criterionLimit(c));
        if (!judged.ok) throw new BadRequestError(`${c.name}: ${judged.error}`);
        outcomes.push({
          name: c.name, formulaId: formula.id, formulaCode: formula.code, formulaRevision: formula.revision, expression: formula.expression,
          inputs: entry.inputs, raw: calc.raw, reported: calc.reported, limit: limitWords(c), passed: !judged.isOos,
        });
      }
      const passed = outcomes.every(o => o.passed);
      const invalidated = passed ? [] : bindings.filter(b => b.value !== null && b.value !== '').map(b => ({ resultId: b.resultId, version: b.resultVersion }));
      const run = {
        id: newId('SST'), sampleId, methodId: method.id, methodCode: method.code, methodRevision: method.revision, outcomes, passed, invalidated,
        reason: body.reason, instrumentId: body.instrumentId ?? null, performedBy: user.id,
      };
      const [stored] = await tx.insert(sstRuns).values(run).returning();
      const summary = outcomes.map(o => `${o.name} ${o.reported} (${o.limit}) ${o.passed ? 'passes' : 'fails'}`).join('; ');
      await writeAudit(tx, user.id, 'Create', 'SstRun', stored.id, 'all', '', JSON.stringify(run),
        `System suitability of ${method.code} revision ${method.revision} on sample ${sampleId}: ${passed ? 'passed' : 'FAILED'}. ${summary}${body.reason ? ` | ${body.reason}` : ''}`);
      for (const inv of invalidated) {
        const name = bindings.find(b => b.resultId === inv.resultId)!.parameter;
        await writeAudit(tx, user.id, 'Invalidate', 'Result', inv.resultId, 'validity', 'Valid', 'Invalid',
          `${name} (version ${inv.version}) invalidated: system suitability run ${stored.id} of ${method.code} failed (${summary}). No OOS investigation: the run was not suitable. Enter the result again after a passing run.`);
      }
      return { run: stored, invalidatedResults: invalidated.map(i => i.resultId) };
    });
    res.json(out);
  });

  return router;
};
