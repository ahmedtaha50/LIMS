// Domain: statistical process control and out-of-trend alerts (roadmap M39, r3-spc). Migration 0320_spc.
//
//   spc_baselines   the control limits of one attribute (product + parameter), versioned and e-signed. A baseline is COMPUTED by the
//                   server from the approved results of a window (individuals chart: centre line, MRbar, sigma, UCL, LCL), with every
//                   exclusion named and justified; the ids of the points used and a hash of their values are stored, so the limits can
//                   be reproduced. Approved, then Superseded by the next revision; an Approved row is never edited. Signed with
//                   SPC_BASELINE_APPROVAL.
//   spc_alerts      an out-of-trend finding: a rule of the baseline's rule set violated by an approved result entered after the
//                   baseline's data window. ADVISORY: a row never changes a result, a specification or a disposition. Open, then
//                   Acknowledged by QA with a note. One alert per (baseline, result, rule).
// Numbers are double precision (statistics, not quantities of record); the results themselves stay as entered.
import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { products } from './master';
import { results, samples } from './samples';

export const SPC_RULE_SETS = ['nelson', 'westgard'] as const;
export const SPC_BASELINE_STATUSES = ['Approved', 'Superseded'] as const;
export const SPC_ALERT_STATUSES = ['Open', 'Acknowledged'] as const;

/** A point left out of the baseline, named and justified. */
export interface SpcExclusion { resultId: string; reason: string }

export const spcBaselines = pgTable('spc_baselines', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().references(() => products.id),
  parameter: text('parameter').notNull(),
  revision: integer('revision').notNull(),
  status: text('status').default('Approved').notNull(),
  ruleSet: text('rule_set').notNull(),
  n: integer('n').notNull(),
  cl: doublePrecision('cl').notNull(),
  mrBar: doublePrecision('mr_bar').notNull(),
  sigma: doublePrecision('sigma').notNull(),
  ucl: doublePrecision('ucl').notNull(),
  lcl: doublePrecision('lcl').notNull(),
  // The window the data was taken from (instants of entered_at) and what was used and left out.
  dataFrom: timestamp('data_from', { withTimezone: true }).notNull(),
  dataTo: timestamp('data_to', { withTimezone: true }).notNull(),
  resultIds: jsonb('result_ids').$type<string[]>().notNull(),
  exclusions: jsonb('exclusions').$type<SpcExclusion[]>().notNull(),
  dataHash: text('data_hash').notNull(),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('spc_baselines_revision_uidx').on(t.productId, t.parameter, t.revision),
  uniqueIndex('spc_baselines_one_approved_uidx').on(t.productId, t.parameter).where(sql`${t.status} = 'Approved'`),
  index('spc_baselines_created_by_idx').on(t.createdBy),
  check('spc_baselines_status_check', sql`${t.status} IN ('Approved', 'Superseded')`),
  check('spc_baselines_rule_set_check', sql`${t.ruleSet} IN ('nelson', 'westgard')`),
  check('spc_baselines_n_check', sql`${t.n} >= 2`),
  check('spc_baselines_reason_check', sql`length(btrim(${t.reason})) >= 5`),
]);

export const spcAlerts = pgTable('spc_alerts', {
  id: text('id').primaryKey(),
  baselineId: text('baseline_id').notNull().references(() => spcBaselines.id),
  productId: text('product_id').notNull().references(() => products.id),
  parameter: text('parameter').notNull(),
  resultId: text('result_id').notNull().references(() => results.id),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  batch: text('batch').notNull(),
  rule: text('rule').notNull(),
  severity: text('severity').notNull(),
  value: doublePrecision('value').notNull(),
  z: doublePrecision('z').notNull(),
  detail: text('detail').notNull(),
  status: text('status').default('Open').notNull(),
  detectedBy: text('detected_by').notNull().references(() => users.id),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  acknowledgedBy: text('acknowledged_by').references(() => users.id),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgement: text('acknowledgement'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('spc_alerts_finding_uidx').on(t.baselineId, t.resultId, t.rule),
  index('spc_alerts_status_idx').on(t.status, t.detectedAt),
  index('spc_alerts_product_id_idx').on(t.productId),
  index('spc_alerts_result_id_idx').on(t.resultId),
  index('spc_alerts_sample_id_idx').on(t.sampleId),
  index('spc_alerts_detected_by_idx').on(t.detectedBy),
  index('spc_alerts_acknowledged_by_idx').on(t.acknowledgedBy),
  check('spc_alerts_status_check', sql`${t.status} IN ('Open', 'Acknowledged')`),
  check('spc_alerts_severity_check', sql`${t.severity} IN ('warning', 'violation')`),
]);
