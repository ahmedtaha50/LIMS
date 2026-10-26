// Domain: directory (LDAP / Active Directory) sign-on (roadmap M41, migration 0310_directory). r3-directory owns this file.
//
//   directory_settings     the connection and the service account (bind password = keystore ciphertext); no row = directory sign-on is off
//   directory_accounts     sidecar to users: kind 'ldap' (password verified by the directory) or 'break-glass' (flagged local Administrator)
//   directory_group_roles  the QA-approved group to role mapping (Draft, Approved, Retired); the Administrator role cannot be mapped
// users is deliberately not changed: a user without a row in directory_accounts is a plain local account.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const directorySettings = pgTable('directory_settings', {
  id: text('id').primaryKey(), // 'default'
  enabled: boolean('enabled').default(false).notNull(),
  url: text('url'), // ldaps://host[:port], or ldap://host[:port] when security is starttls
  security: text('security').default('ldaps').notNull(), // ldaps | starttls; there is no plain-text option
  caPem: text('ca_pem'), // the CA certificate(s) that must vouch for the server (PEM); empty = the operating system's store
  bindDn: text('bind_dn'),
  bindPasswordEnc: text('bind_password_enc'), // v<generation>:... keystore ciphertext, bound to this row
  baseDn: text('base_dn'),
  groupAttribute: text('group_attribute').default('memberOf').notNull(),
  timeoutMs: integer('timeout_ms').default(5000).notNull(),
  localAccountsAllowed: boolean('local_accounts_allowed').default(true).notNull(), // false: only break-glass accounts may still sign in locally
  version: integer('version').default(1).notNull(),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('directory_settings_updated_by_idx').on(t.updatedBy),
  check('directory_settings_security_check', sql`${t.security} IN ('ldaps', 'starttls')`),
  check('directory_settings_url_check', sql`${t.url} IS NULL OR (${t.security} = 'ldaps' AND ${t.url} ~ '^ldaps://[^/ ]+$') OR (${t.security} = 'starttls' AND ${t.url} ~ '^ldap://[^/ ]+$')`),
  check('directory_settings_timeout_check', sql`${t.timeoutMs} BETWEEN 1000 AND 60000`),
  check('directory_settings_enabled_check', sql`NOT ${t.enabled} OR (${t.url} IS NOT NULL AND ${t.bindDn} IS NOT NULL AND ${t.bindPasswordEnc} IS NOT NULL AND ${t.baseDn} IS NOT NULL)`),
]);

export const directoryAccounts = pgTable('directory_accounts', {
  userId: text('user_id').primaryKey().references(() => users.id),
  kind: text('kind').notNull(), // ldap | break-glass
  externalId: text('external_id'), // objectGUID (hex), the immutable identifier; set exactly for kind ldap
  dn: text('dn'),
  groups: jsonb('groups').$type<string[]>().default([]).notNull(), // group DNs seen at the last sign-in
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('directory_accounts_created_by_idx').on(t.createdBy),
  uniqueIndex('directory_accounts_external_id_uidx').on(t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  check('directory_accounts_kind_check', sql`${t.kind} IN ('ldap', 'break-glass')`),
  check('directory_accounts_external_check', sql`(${t.kind} = 'ldap') = (${t.externalId} IS NOT NULL)`),
]);

export const directoryGroupRoles = pgTable('directory_group_roles', {
  id: text('id').primaryKey(),
  groupDn: text('group_dn').notNull(),
  groupDnNorm: text('group_dn_norm').notNull(), // lower-case, spaces around separators removed: what a sign-in compares
  role: text('role').notNull(),
  status: text('status').default('Draft').notNull(), // Draft | Approved | Retired; only Approved rows are used at sign-in
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  retiredBy: text('retired_by').references(() => users.id),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('directory_group_roles_created_by_idx').on(t.createdBy),
  index('directory_group_roles_approved_by_idx').on(t.approvedBy),
  index('directory_group_roles_retired_by_idx').on(t.retiredBy),
  uniqueIndex('directory_group_roles_live_group_uidx').on(t.groupDnNorm).where(sql`${t.status} IN ('Draft', 'Approved')`),
  check('directory_group_roles_status_check', sql`${t.status} IN ('Draft', 'Approved', 'Retired')`),
  check('directory_group_roles_role_check', sql`${t.role} <> 'Admin'`),
  check('directory_group_roles_reason_check', sql`length(btrim(${t.reason})) >= 5`),
]);
