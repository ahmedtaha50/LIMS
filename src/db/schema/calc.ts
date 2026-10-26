// Domain: calculation formulas, calculated results and system suitability runs (roadmap M18, migration 0110_methods_calc).
// r2-methods-calc owns this file.
//
//   calc_formulas   a version-controlled formula (GAMP 5 category 5 configuration): the expression in the language of
//                   src/server/lib/calc.ts, its declared inputs and its test cases (hand-calculated values). Draft until an independent
//                   person signs it Effective (FORMULA_APPROVAL), which is refused unless every test case reproduces its value on the
//                   server. Approving a revision supersedes the Effective one of the same code; nothing Effective is ever edited.
//   result_inputs   one row per calculation of a result: the raw inputs, the formula id, revision and expression used, the raw and
//                   the reported value, and result_version, the results.version the calculation produced. Append-only. Approving a
//                   later formula revision therefore changes no existing result: the row says how it was calculated.
//   sst_runs        one row per system suitability run of a method for a sample: the outcome of every criterion, passed or not,
//                   and the results of the method the run invalidated (result id and the version that was invalidated). Append-only.
//                   A result is Invalid while its current version is one a failed run invalidated (src/server/services/result-guards/sst.ts).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';
import { methods } from './methods';
import { results, samples } from './samples';

export const calcFormulas = pgTable('calc_formulas', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  expression: text('expression').notNull(),
  inputs: jsonb('inputs').$type<unknown[]>().notNull(),
  unit: text('unit'),
  testCases: jsonb('test_cases').$type<unknown[]>().default(sql`'[]'::jsonb`).notNull(),
  revision: integer('revision').notNull(),
  status: text('status').default('Draft').notNull(),
  createdBy: text('created_by').references(() => users.id),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('calc_formulas_code_revision_uidx').on(t.code, t.revision),
  uniqueIndex('calc_formulas_one_draft_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Draft'`),
  uniqueIndex('calc_formulas_one_effective_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Effective'`),
  index('calc_formulas_created_by_idx').on(t.createdBy),
  index('calc_formulas_approved_by_idx').on(t.approvedBy),
  check('calc_formulas_status_check', sql`${t.status} IN ('Draft', 'Effective', 'Superseded')`),
]);

export const resultInputs = pgTable('result_inputs', {
  id: text('id').primaryKey(),
  resultId: text('result_id').notNull().references(() => results.id),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  resultVersion: integer('result_version').notNull(),
  formulaId: text('formula_id').notNull().references(() => calcFormulas.id),
  formulaRevision: integer('formula_revision').notNull(),
  expression: text('expression').notNull(),
  inputs: jsonb('inputs').$type<Record<string, number | number[]>>().notNull(),
  rawValue: text('raw_value').notNull(),
  reportedValue: text('reported_value').notNull(),
  decimals: integer('decimals'),
  instrumentId: text('instrument_id').references(() => instruments.id),
  enteredBy: text('entered_by').notNull().references(() => users.id),
  enteredAt: timestamp('entered_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('result_inputs_result_version_uidx').on(t.resultId, t.resultVersion),
  index('result_inputs_sample_id_idx').on(t.sampleId),
  index('result_inputs_formula_id_idx').on(t.formulaId),
  index('result_inputs_instrument_id_idx').on(t.instrumentId),
  index('result_inputs_entered_by_idx').on(t.enteredBy),
]);

export const sstRuns = pgTable('sst_runs', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  methodId: text('method_id').notNull().references(() => methods.id),
  methodCode: text('method_code').notNull(),
  methodRevision: integer('method_revision').notNull(),
  outcomes: jsonb('outcomes').$type<unknown[]>().notNull(),
  passed: boolean('passed').notNull(),
  invalidated: jsonb('invalidated').$type<Array<{ resultId: string; version: number }>>().default(sql`'[]'::jsonb`).notNull(),
  reason: text('reason'),
  instrumentId: text('instrument_id').references(() => instruments.id),
  performedBy: text('performed_by').notNull().references(() => users.id),
  performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('sst_runs_sample_id_idx').on(t.sampleId),
  index('sst_runs_method_id_idx').on(t.methodId),
  index('sst_runs_instrument_id_idx').on(t.instrumentId),
  index('sst_runs_performed_by_idx').on(t.performedBy),
]);
