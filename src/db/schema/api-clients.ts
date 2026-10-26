// Domain: machine integration API (roadmap M22, migration 0140_api_v1). r2-api-v1 owns this file.
//
//   api_clients            one row per API client: an instrument, a chromatography data system, a middleware. The client acts as its own
//                          service account (user_id, role 'Instrument'), so every record it writes is attributed to it in the audit trail.
//                          Only the SHA-256 of the token is stored; the token is shown once, when the client is created. Created and
//                          revoked by an Administrator with an e-signature (ADMIN_AUTHORISATION on record type ApiClient); `version` is
//                          the optimistic-concurrency counter those signatures are bound to. A revoked client is never reactivated.
//   api_idempotency_keys   the answer of each successful write call made with an Idempotency-Key, per client: a retry with the same key
//                          and the same body gets the same answer and writes nothing; the same key with another body is refused. The row
//                          is written in the transaction of the write, so a refused or failed call leaves no key behind.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';

export const API_CLIENT_STATUSES = ['Active', 'Revoked'] as const;

export const apiClients = pgTable('api_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').default('').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenPrefix: text('token_prefix').notNull(),
  tokenHash: text('token_hash').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(), // a JSON array of scope names (src/server/v1/scopes.ts)
  instrumentId: text('instrument_id').references(() => instruments.id),
  status: text('status').default('Active').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by').references(() => users.id),
  revokedReason: text('revoked_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('api_clients_token_hash_uidx').on(t.tokenHash),
  uniqueIndex('api_clients_token_prefix_uidx').on(t.tokenPrefix),
  uniqueIndex('api_clients_name_lower_uidx').on(sql`lower(${t.name})`),
  uniqueIndex('api_clients_user_id_uidx').on(t.userId),
  index('api_clients_instrument_id_idx').on(t.instrumentId),
  index('api_clients_created_by_idx').on(t.createdBy),
  index('api_clients_revoked_by_idx').on(t.revokedBy),
  check('api_clients_status_check', sql`${t.status} IN ('Active', 'Revoked')`),
  check('api_clients_revoked_check', sql`(${t.status} = 'Revoked') = (${t.revokedAt} IS NOT NULL)`),
  check('api_clients_scopes_check', sql`jsonb_typeof(${t.scopes}) = 'array'`),
]);

export const apiIdempotencyKeys = pgTable('api_idempotency_keys', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => apiClients.id),
  key: text('key').notNull(),
  operation: text('operation').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code').notNull(),
  responseBody: text('response_body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('api_idempotency_keys_client_id_key_uidx').on(t.clientId, t.key),
  index('api_idempotency_keys_created_at_idx').on(t.createdAt),
]);
