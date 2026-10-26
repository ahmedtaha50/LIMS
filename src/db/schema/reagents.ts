// Domain: reagents, reference standards and prepared solutions with their usage on results (roadmap M30). Owned by r2-reagents;
// migration drizzle/0230_reagents.sql. The v0.1.0 table `reagents` (src/db/schema/equipment.ts) is left as it was: it is the
// legacy register, shown read only, and nothing new is written to it by the inventory.
//
//   reagent_items                 the item master: what a material is (code, name, category, unit, storage, in-use shelf life after
//                                 opening, whether a potency must be stated at receipt)
//   reagent_lots                  one received lot of an item: supplier lot, quantity, expiry and retest dates, potency with its basis.
//                                 Received into Quarantine (e-signed RECEIPT), released by a second person (REAGENT_LOT_RELEASE),
//                                 opened (in_use_expiry = min(expiry, opening day + shelf life)), then Consumed, Disposed, Expired or
//                                 Rejected. The receipt fields never change once written (trigger)
//   prepared_solutions            a solution made in the laboratory from lots and other solutions; it cannot expire after any of its
//                                 parents (application and trigger)
//   prepared_solution_components  what a solution was made from, and how much (each one is a consumption row of the ledger)
//   reagent_transactions          THE CONSUMPTION LEDGER: append-only; one row per receipt, preparation, consumption, use on a result and
//                                 disposal, with the running balance of the lot or solution (never negative; the database checks the
//                                 arithmetic)
//   result_materials              which lots and solutions a result was measured with (the usage-to-result link). Append-only, except
//                                 that a link can be withdrawn once, with a reason
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { results, samples } from './samples';

export const REAGENT_CATEGORIES = ['Reagent', 'ReferenceStandard', 'WorkingStandard', 'Solvent', 'Medium', 'Other'] as const;
export const LOT_STATUSES = ['Quarantine', 'Approved', 'InUse', 'Consumed', 'Disposed', 'Expired', 'Rejected'] as const;
export const POTENCY_BASES = ['As is', 'Dried basis', 'Anhydrous basis', 'Solvent-free basis'] as const;
export const SOLUTION_STATUSES = ['Active', 'Consumed', 'Discarded', 'Expired'] as const;
export const TRANSACTION_TYPES = ['Receipt', 'Prepared', 'Consumed', 'Used', 'Disposed'] as const;

export const reagentItems = pgTable('reagent_items', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  grade: text('grade'),
  unit: text('unit').notNull(),
  storageCondition: text('storage_condition'),
  inUseShelfLifeDays: integer('in_use_shelf_life_days'),
  requiresPotency: boolean('requires_potency').default(false).notNull(),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('reagent_items_code_lower_uidx').using('btree', sql`lower(${t.code})`),
  index('reagent_items_created_by_idx').on(t.createdBy),
  check('reagent_items_category_check', sql`${t.category} IN ('Reagent', 'ReferenceStandard', 'WorkingStandard', 'Solvent', 'Medium', 'Other')`),
  check('reagent_items_status_check', sql`${t.status} IN ('Active', 'Inactive')`),
  check('reagent_items_shelf_life_check', sql`${t.inUseShelfLifeDays} IS NULL OR ${t.inUseShelfLifeDays} BETWEEN 1 AND 3650`),
]);

export const reagentLots = pgTable('reagent_lots', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => reagentItems.id),
  lotNumber: text('lot_number').notNull(),
  supplier: text('supplier').notNull(),
  coaReference: text('coa_reference'),
  receivedQuantity: numeric('received_quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  expiryDate: text('expiry_date').notNull(),
  retestDate: text('retest_date'),
  potency: numeric('potency', { precision: 10, scale: 4 }),
  potencyBasis: text('potency_basis'),
  storageLocation: text('storage_location'),
  status: text('status').default('Quarantine').notNull(),
  receivedBy: text('received_by').notNull().references(() => users.id),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  releasedBy: text('released_by').references(() => users.id),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  openedBy: text('opened_by').references(() => users.id),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  inUseExpiry: text('in_use_expiry'),
  closedBy: text('closed_by').references(() => users.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('reagent_lots_item_id_idx').on(t.itemId),
  index('reagent_lots_status_idx').on(t.status),
  index('reagent_lots_received_by_idx').on(t.receivedBy),
  index('reagent_lots_released_by_idx').on(t.releasedBy),
  index('reagent_lots_opened_by_idx').on(t.openedBy),
  index('reagent_lots_closed_by_idx').on(t.closedBy),
  check('reagent_lots_status_check', sql`${t.status} IN ('Quarantine', 'Approved', 'InUse', 'Consumed', 'Disposed', 'Expired', 'Rejected')`),
  check('reagent_lots_quantity_check', sql`${t.receivedQuantity} > 0`),
  check('reagent_lots_dates_check', sql`${t.expiryDate} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (${t.retestDate} IS NULL OR (${t.retestDate} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${t.retestDate} <= ${t.expiryDate}))`),
  check('reagent_lots_in_use_expiry_check', sql`${t.inUseExpiry} IS NULL OR (${t.inUseExpiry} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${t.inUseExpiry} <= ${t.expiryDate})`),
  check('reagent_lots_potency_check', sql`(${t.potency} IS NULL) = (${t.potencyBasis} IS NULL) AND (${t.potency} IS NULL OR ${t.potency} > 0)`),
  check('reagent_lots_potency_basis_check', sql`${t.potencyBasis} IS NULL OR ${t.potencyBasis} IN ('As is', 'Dried basis', 'Anhydrous basis', 'Solvent-free basis')`),
]);

export const preparedSolutions = pgTable('prepared_solutions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  concentration: text('concentration'),
  preparation: text('preparation').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  expiryDate: text('expiry_date').notNull(),
  storageCondition: text('storage_condition'),
  status: text('status').default('Active').notNull(),
  preparedBy: text('prepared_by').notNull().references(() => users.id),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow().notNull(),
  closedBy: text('closed_by').references(() => users.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('prepared_solutions_status_idx').on(t.status),
  index('prepared_solutions_prepared_by_idx').on(t.preparedBy),
  index('prepared_solutions_closed_by_idx').on(t.closedBy),
  check('prepared_solutions_status_check', sql`${t.status} IN ('Active', 'Consumed', 'Discarded', 'Expired')`),
  check('prepared_solutions_quantity_check', sql`${t.quantity} > 0`),
  check('prepared_solutions_expiry_check', sql`${t.expiryDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
]);

export const reagentTransactions = pgTable('reagent_transactions', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  lotId: text('lot_id').references(() => reagentLots.id),
  solutionId: text('solution_id').references(() => preparedSolutions.id),
  txType: text('tx_type').notNull(),
  qtyDelta: numeric('qty_delta', { precision: 14, scale: 4 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  resultId: text('result_id').references(() => results.id),
  intoSolutionId: text('into_solution_id'),
  reason: text('reason').notNull(),
  performedBy: text('performed_by').notNull().references(() => users.id),
  performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  foreignKey({ name: 'reagent_transactions_into_solution_id_fk', columns: [t.intoSolutionId], foreignColumns: [preparedSolutions.id] }),
  uniqueIndex('reagent_transactions_seq_uidx').on(t.seq),
  index('reagent_transactions_lot_id_idx').on(t.lotId, t.seq),
  index('reagent_transactions_solution_id_idx').on(t.solutionId, t.seq),
  index('reagent_transactions_result_id_idx').on(t.resultId),
  index('reagent_transactions_into_solution_id_idx').on(t.intoSolutionId),
  index('reagent_transactions_performed_by_idx').on(t.performedBy),
  check('reagent_transactions_holder_check', sql`(${t.lotId} IS NULL) <> (${t.solutionId} IS NULL)`),
  check('reagent_transactions_type_check', sql`${t.txType} IN ('Receipt', 'Prepared', 'Consumed', 'Used', 'Disposed')`),
  check('reagent_transactions_sign_check', sql`(${t.txType} IN ('Receipt', 'Prepared') AND ${t.qtyDelta} > 0) OR (${t.txType} IN ('Consumed', 'Used', 'Disposed') AND ${t.qtyDelta} < 0)`),
  check('reagent_transactions_balance_check', sql`${t.balanceAfter} >= 0`),
]);

export const preparedSolutionComponents = pgTable('prepared_solution_components', {
  id: text('id').primaryKey(),
  solutionId: text('solution_id').notNull(),
  lotId: text('lot_id').references(() => reagentLots.id),
  parentSolutionId: text('parent_solution_id'),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  transactionId: text('transaction_id').notNull(),
}, (t) => [
  foreignKey({ name: 'prepared_solution_components_solution_id_fk', columns: [t.solutionId], foreignColumns: [preparedSolutions.id] }),
  foreignKey({ name: 'prepared_solution_components_parent_solution_id_fk', columns: [t.parentSolutionId], foreignColumns: [preparedSolutions.id] }),
  foreignKey({ name: 'prepared_solution_components_transaction_id_fk', columns: [t.transactionId], foreignColumns: [reagentTransactions.id] }),
  index('prepared_solution_components_solution_id_idx').on(t.solutionId),
  index('prepared_solution_components_lot_id_idx').on(t.lotId),
  index('prepared_solution_components_parent_solution_id_idx').on(t.parentSolutionId),
  index('prepared_solution_components_transaction_id_idx').on(t.transactionId),
  check('prepared_solution_components_parent_check', sql`(${t.lotId} IS NULL) <> (${t.parentSolutionId} IS NULL)`),
  check('prepared_solution_components_quantity_check', sql`${t.quantity} > 0`),
]);

export const resultMaterials = pgTable('result_materials', {
  id: text('id').primaryKey(),
  resultId: text('result_id').notNull().references(() => results.id),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  lotId: text('lot_id').references(() => reagentLots.id),
  solutionId: text('solution_id').references(() => preparedSolutions.id),
  quantity: numeric('quantity', { precision: 14, scale: 4 }),
  transactionId: text('transaction_id').references(() => reagentTransactions.id),
  resultVersion: integer('result_version').notNull(),
  linkedBy: text('linked_by').notNull().references(() => users.id),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
  withdrawnBy: text('withdrawn_by').references(() => users.id),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawReason: text('withdraw_reason'),
}, (t) => [
  index('result_materials_result_id_idx').on(t.resultId),
  index('result_materials_sample_id_idx').on(t.sampleId),
  index('result_materials_lot_id_idx').on(t.lotId),
  index('result_materials_solution_id_idx').on(t.solutionId),
  index('result_materials_transaction_id_idx').on(t.transactionId),
  index('result_materials_linked_by_idx').on(t.linkedBy),
  index('result_materials_withdrawn_by_idx').on(t.withdrawnBy),
  uniqueIndex('result_materials_result_lot_uidx').on(t.resultId, t.lotId).where(sql`${t.lotId} IS NOT NULL AND ${t.withdrawnAt} IS NULL`),
  uniqueIndex('result_materials_result_solution_uidx').on(t.resultId, t.solutionId).where(sql`${t.solutionId} IS NOT NULL AND ${t.withdrawnAt} IS NULL`),
  check('result_materials_material_check', sql`(${t.lotId} IS NULL) <> (${t.solutionId} IS NULL)`),
  check('result_materials_quantity_check', sql`${t.quantity} IS NULL OR ${t.quantity} > 0`),
  check('result_materials_withdrawal_check', sql`(${t.withdrawnAt} IS NULL) = (${t.withdrawnBy} IS NULL) AND (${t.withdrawnAt} IS NULL) = (${t.withdrawReason} IS NULL)`),
]);

export type ReagentItem = typeof reagentItems.$inferSelect;
export type ReagentLot = typeof reagentLots.$inferSelect;
export type PreparedSolution = typeof preparedSolutions.$inferSelect;
export type ReagentTransaction = typeof reagentTransactions.$inferSelect;
export type ResultMaterial = typeof resultMaterials.$inferSelect;
