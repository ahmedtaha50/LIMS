// Domain: sample receipt, chain of custody, storage, aliquots, retains and labels (roadmap M29). Owned by r2-custody-labels;
// migration drizzle/0220_custody.sql. The samples table is frozen (its columns feed signed hashes), so custody is a set of sidecar
// tables and a custody status parallel to the sample state: nothing here changes SampleState.
//
//   storage_locations   the location tree (site, building, room, storage unit, shelf, box), each with an optional temperature range
//   sample_custody      1:1 with samples: the receipt (when, by whom, condition, seal, temperature against the required storage,
//                       manufacturing and expiry dates) and the receipt deviation with QA's signed acknowledgement
//   sample_containers   the physical containers of a sample: the primary container made at receipt and its aliquots (child lineage)
//   custody_events      the custody ledger: hash-linked, append-only, one row per movement of quantity, place or holder, with the
//                       running balance of the container (never negative; the database checks the arithmetic)
//   sample_retains      the retain register: a container kept until a date, then disposed of with a signature
//   label_prints        every label printed: hash-linked, append-only; a reprint carries its reason
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, numeric, pgTable, real, text, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { samples } from './samples';

export const storageLocations = pgTable('storage_locations', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  parentId: text('parent_id').references((): AnyPgColumn => storageLocations.id),
  tempMin: real('temp_min'),
  tempMax: real('temp_max'),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('storage_locations_code_lower_uidx').on(sql`lower(${t.code})`),
  index('storage_locations_parent_id_idx').on(t.parentId),
  index('storage_locations_created_by_idx').on(t.createdBy),
  check('storage_locations_kind_check', sql`${t.kind} IN ('Site', 'Building', 'Room', 'Storage unit', 'Shelf', 'Box')`),
  check('storage_locations_status_check', sql`${t.status} IN ('Active', 'Inactive')`),
  check('storage_locations_temp_check', sql`${t.tempMin} IS NULL OR ${t.tempMax} IS NULL OR ${t.tempMin} <= ${t.tempMax}`),
]);

export const sampleCustody = pgTable('sample_custody', {
  sampleId: text('sample_id').primaryKey().references(() => samples.id),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  receivedBy: text('received_by').notNull().references(() => users.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  condition: text('condition').notNull(),
  sealIntact: boolean('seal_intact').notNull(),
  temperatureC: real('temperature_c'),
  requiredStorage: text('required_storage').notNull(),
  requiredTempMin: real('required_temp_min'),
  requiredTempMax: real('required_temp_max'),
  mfgDate: text('mfg_date'),
  expDate: text('exp_date'),
  notes: text('notes'),
  deviation: boolean('deviation').default(false).notNull(),
  deviationReasons: text('deviation_reasons'),
  deviationAckBy: text('deviation_ack_by').references(() => users.id),
  deviationAckAt: timestamp('deviation_ack_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('sample_custody_received_by_idx').on(t.receivedBy),
  index('sample_custody_deviation_ack_by_idx').on(t.deviationAckBy),
  check('sample_custody_condition_check', sql`${t.condition} IN ('Intact', 'Damaged', 'Leaking', 'Contaminated')`),
  check('sample_custody_required_temp_check', sql`${t.requiredTempMin} IS NULL OR ${t.requiredTempMax} IS NULL OR ${t.requiredTempMin} <= ${t.requiredTempMax}`),
  check('sample_custody_deviation_check', sql`${t.deviation} OR (${t.deviationAckBy} IS NULL AND ${t.deviationAckAt} IS NULL)`),
]);

export const sampleContainers = pgTable('sample_containers', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  parentId: text('parent_id').references((): AnyPgColumn => sampleContainers.id),
  kind: text('kind').notNull(),
  quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  locationId: text('location_id').references(() => storageLocations.id),
  holderId: text('holder_id').references(() => users.id),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('sample_containers_sample_id_idx').on(t.sampleId),
  index('sample_containers_parent_id_idx').on(t.parentId),
  index('sample_containers_location_id_idx').on(t.locationId),
  index('sample_containers_holder_id_idx').on(t.holderId),
  index('sample_containers_created_by_idx').on(t.createdBy),
  check('sample_containers_kind_check', sql`${t.kind} IN ('Primary', 'Aliquot')`),
  check('sample_containers_status_check', sql`${t.status} IN ('Active', 'Empty', 'Disposed')`),
  check('sample_containers_quantity_check', sql`${t.quantity} >= 0`),
]);

export const CUSTODY_EVENT_TYPES = ['Receipt', 'Aliquot out', 'Aliquot in', 'Transfer', 'Consume', 'Retain', 'Dispose'] as const;

export const custodyEvents = pgTable('custody_events', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  containerId: text('container_id').notNull().references(() => sampleContainers.id),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  eventType: text('event_type').notNull(),
  qtyDelta: numeric('qty_delta', { precision: 14, scale: 4 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 14, scale: 4 }).notNull(),
  unit: text('unit').notNull(),
  fromLocationId: text('from_location_id').references(() => storageLocations.id),
  toLocationId: text('to_location_id').references(() => storageLocations.id),
  fromHolderId: text('from_holder_id').references(() => users.id),
  toHolderId: text('to_holder_id').references(() => users.id),
  relatedContainerId: text('related_container_id').references(() => sampleContainers.id),
  reason: text('reason').notNull(),
  actorId: text('actor_id').notNull().references(() => users.id),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
}, (t) => [
  uniqueIndex('custody_events_seq_uidx').on(t.seq),
  index('custody_events_container_id_idx').on(t.containerId),
  index('custody_events_sample_id_idx').on(t.sampleId),
  index('custody_events_from_location_id_idx').on(t.fromLocationId),
  index('custody_events_to_location_id_idx').on(t.toLocationId),
  index('custody_events_from_holder_id_idx').on(t.fromHolderId),
  index('custody_events_to_holder_id_idx').on(t.toHolderId),
  index('custody_events_related_container_id_idx').on(t.relatedContainerId),
  index('custody_events_actor_id_idx').on(t.actorId),
  check('custody_events_type_check', sql`${t.eventType} IN ('Receipt', 'Aliquot out', 'Aliquot in', 'Transfer', 'Consume', 'Retain', 'Dispose')`),
  check('custody_events_balance_check', sql`${t.balanceAfter} >= 0`),
]);

export const sampleRetains = pgTable('sample_retains', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  containerId: text('container_id').notNull().references(() => sampleContainers.id),
  retainUntil: text('retain_until').notNull(),
  status: text('status').default('Retained').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  disposedBy: text('disposed_by').references(() => users.id),
  disposedAt: timestamp('disposed_at', { withTimezone: true }),
  disposalMethod: text('disposal_method'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('sample_retains_container_id_uidx').on(t.containerId),
  index('sample_retains_sample_id_idx').on(t.sampleId),
  index('sample_retains_created_by_idx').on(t.createdBy),
  index('sample_retains_disposed_by_idx').on(t.disposedBy),
  check('sample_retains_status_check', sql`${t.status} IN ('Retained', 'Disposed')`),
  check('sample_retains_disposed_check', sql`(${t.status} = 'Disposed') = (${t.disposedAt} IS NOT NULL AND ${t.disposedBy} IS NOT NULL AND ${t.disposalMethod} IS NOT NULL)`),
]);

export const labelPrints = pgTable('label_prints', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  code: text('code').notNull(),
  symbology: text('symbology').notNull(),
  copies: integer('copies').notNull(),
  isReprint: boolean('is_reprint').notNull(),
  reason: text('reason'),
  printedBy: text('printed_by').notNull().references(() => users.id),
  printedAt: timestamp('printed_at', { withTimezone: true }).defaultNow().notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
}, (t) => [
  uniqueIndex('label_prints_seq_uidx').on(t.seq),
  index('label_prints_entity_idx').on(t.entityType, t.entityId),
  index('label_prints_printed_by_idx').on(t.printedBy),
  check('label_prints_entity_type_check', sql`${t.entityType} IN ('Sample', 'Container', 'Location')`),
  check('label_prints_symbology_check', sql`${t.symbology} IN ('code128', 'qr')`),
  check('label_prints_copies_check', sql`${t.copies} BETWEEN 1 AND 50`),
  check('label_prints_reprint_reason_check', sql`NOT ${t.isReprint} OR length(btrim(coalesce(${t.reason}, ''))) >= 5`),
]);
