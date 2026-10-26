// Domain: master data (roadmap M17, migration 0100_master_data). r2-master-data owns this file.
//
//   products          one row per product (the material the specifications are written for). `name` is the text that
//                     samples.material and specifications.material hold; it is unique by the material key (case and spaces do not
//                     make another product) and never changes, nor does `code`. Status Active / Inactive, changed by e-signature.
//   product_batches   a batch (lot) of a product: unique per product, so the same batch number under two products is two batches.
//                     `batch_no` is the text samples.batch holds. Quarantine -> Released (only after the formal batch release) |
//                     Rejected; Released -> Recalled. Every status change is e-signed. Dates are calendar days, YYYY-MM-DD.
//   customers         who a sample is tested for (contract testing, complaint samples). Active / Inactive.
//   sample_context    1:1 sidecar of samples (the samples core is frozen: its columns feed signed hashes). The product, batch and
//                     customer ids a sample was registered against. Written once in the registration's transaction; append-only.
//
// `origin` says how a row came to exist: 'entry' (a person, through the API) or 'migration' (the backfill of 0100 from the
// specifications and samples that existed; created_by is then NULL and the SCHEMA_MIGRATED audit entry is the record).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { samples } from './samples';

export const PRODUCT_STATUSES = ['Active', 'Inactive'] as const;
export const BATCH_STATUSES = ['Quarantine', 'Released', 'Rejected', 'Recalled'] as const;
export const CUSTOMER_STATUSES = ['Active', 'Inactive'] as const;

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').default('Active').notNull(),
  origin: text('origin').default('entry').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('products_name_lower_uidx').on(sql`lower(${t.name})`),
  index('products_created_by_idx').on(t.createdBy),
  index('products_search_trgm_idx').using('gin', sql`(search_norm(${t.code} || ' ' || ${t.name} || ' ' || coalesce(${t.description}, ''))) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
  check('products_status_check', sql`${t.status} IN ('Active', 'Inactive')`),
]);

export const productBatches = pgTable('product_batches', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().references(() => products.id),
  batchNo: text('batch_no').notNull(),
  status: text('status').default('Quarantine').notNull(),
  manufacturedOn: text('manufactured_on'),
  expiresOn: text('expires_on'),
  batchSize: text('batch_size'),
  origin: text('origin').default('entry').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('product_batches_product_batch_uidx').on(t.productId, t.batchNo),
  index('product_batches_batch_no_idx').on(t.batchNo),
  index('product_batches_created_by_idx').on(t.createdBy),
  index('product_batches_search_trgm_idx').using('gin', sql`(search_norm(${t.id} || ' ' || ${t.batchNo})) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
  check('product_batches_status_check', sql`${t.status} IN ('Quarantine', 'Released', 'Rejected', 'Recalled')`),
]);

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  contact: text('contact'),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('customers_code_lower_uidx').on(sql`lower(${t.code})`),
  index('customers_created_by_idx').on(t.createdBy),
  check('customers_status_check', sql`${t.status} IN ('Active', 'Inactive')`),
]);

export const sampleContext = pgTable('sample_context', {
  sampleId: text('sample_id').primaryKey().references(() => samples.id),
  productId: text('product_id').notNull().references(() => products.id),
  batchId: text('batch_id').notNull().references(() => productBatches.id),
  customerId: text('customer_id').references(() => customers.id),
  origin: text('origin').default('registration').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('sample_context_product_id_idx').on(t.productId),
  index('sample_context_batch_id_idx').on(t.batchId),
  index('sample_context_customer_id_idx').on(t.customerId),
  index('sample_context_created_by_idx').on(t.createdBy),
]);
