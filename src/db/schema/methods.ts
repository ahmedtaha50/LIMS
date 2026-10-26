// Domain: methods, test plans and the normalised specification parameters (roadmap M18, migration 0110_methods_calc).
// r2-methods-calc owns this file.
//
//   methods           an analytical method (HPLC assay, Karl Fischer, dissolution, ...), by code and revision. Draft until an
//                     independent person signs it Effective (METHOD_APPROVAL, bound to the record version); approving a revision
//                     supersedes the Effective one of the same code in the same transaction. An Effective or Superseded method is never
//                     edited. A method may name the instrument type a result must be measured on, the training module of the analyst
//                     (recorded; enforced by the training track), and its system suitability criteria (sst_criteria, JSONB).
//   test_plans        which parameters of a material's specification a kind of sample (release, stability, ...) is tested for.
//                     Draft / Effective / Superseded like a method (TEST_PLAN_APPROVAL).
//   spec_parameters   one row per parameter of a specification: the limit (kind, lower, upper, decimals, text) and its binding (the
//                     method, the formula, the replicates and the stage). It is DERIVED: a trigger rebuilds a specification's rows
//                     from specifications.parameters (the JSONB, which stays the signed record and the rollback copy) in the same
//                     statement that writes it. The rows are never written directly, and the database refuses any other change.
// `version` is the optimistic-concurrency counter; `revision` is the revision of the document (Rev 1, Rev 2, ...), assigned by the
// server and never edited. Codes are unique ignoring case; one Draft and one Effective revision per code at a time.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { specifications } from './specifications';

export const methods = pgTable('methods', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  revision: integer('revision').notNull(),
  status: text('status').default('Draft').notNull(),
  instrumentType: text('instrument_type'),
  requiredTrainingModule: text('required_training_module'),
  sstCriteria: jsonb('sst_criteria').$type<unknown[]>().default(sql`'[]'::jsonb`).notNull(),
  createdBy: text('created_by').references(() => users.id),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('methods_code_revision_uidx').on(t.code, t.revision),
  index('methods_search_trgm_idx').using('gin', sql`(search_norm(${t.code} || ' ' || ${t.title} || ' ' || coalesce(${t.description}, ''))) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
  uniqueIndex('methods_one_draft_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Draft'`),
  uniqueIndex('methods_one_effective_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Effective'`),
  index('methods_created_by_idx').on(t.createdBy),
  index('methods_approved_by_idx').on(t.approvedBy),
  check('methods_status_check', sql`${t.status} IN ('Draft', 'Effective', 'Superseded')`),
]);

export const testPlans = pgTable('test_plans', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  material: text('material').notNull(),
  purpose: text('purpose').notNull(),
  parameters: jsonb('parameters').$type<string[]>().notNull(),
  revision: integer('revision').notNull(),
  status: text('status').default('Draft').notNull(),
  createdBy: text('created_by').references(() => users.id),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('test_plans_code_revision_uidx').on(t.code, t.revision),
  uniqueIndex('test_plans_one_draft_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Draft'`),
  uniqueIndex('test_plans_one_effective_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Effective'`),
  index('test_plans_material_idx').on(t.material),
  index('test_plans_created_by_idx').on(t.createdBy),
  index('test_plans_approved_by_idx').on(t.approvedBy),
  check('test_plans_status_check', sql`${t.status} IN ('Draft', 'Effective', 'Superseded')`),
]);

export const specParameters = pgTable('spec_parameters', {
  id: text('id').primaryKey(), // <spec_id>#<position>
  specId: text('spec_id').notNull().references(() => specifications.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  limitKind: text('limit_kind').notNull(),
  lower: numeric('lower'),
  upper: numeric('upper'),
  decimals: integer('decimals'),
  text: text('text'),
  methodCode: text('method_code'),
  formulaCode: text('formula_code'),
  replicates: integer('replicates'),
  stage: text('stage'),
}, (t) => [
  uniqueIndex('spec_parameters_spec_position_uidx').on(t.specId, t.position),
  index('spec_parameters_method_code_idx').on(t.methodCode),
  index('spec_parameters_formula_code_idx').on(t.formulaCode),
]);
