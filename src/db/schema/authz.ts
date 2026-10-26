// Domain: authorisation (roadmap M09, migration 0040). r1-authz owns this file.
// The permission matrix (roles, permissions, role_permissions), the independence rules (sod_rules) and the ledger of role changes
// that two people signed (user_roles). The matrix rows are installed by drizzle/0040_authz.sql from the catalog in
// src/lib/permissions.ts; changing the matrix is a new migration, never an API call (docs/changes/r1-authz.md).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // what users.role holds
  description: text('description').notNull(),
  isSystem: boolean('is_system').default(true).notNull(), // installed by a migration; only these rows are in the catalog
  requiresApproval: boolean('requires_approval').default(false).notNull(), // granting or removing this role needs the second signature
  active: boolean('active').default(true).notNull(),
});

export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(), // domain.action, e.g. spec.approve
  category: text('category').notNull(),
  description: text('description').notNull(),
  position: integer('position').notNull(), // catalog order, so every export lists the codes the same way
});

// (A surrogate key and a unique index, not a composite primary key: drizzle-kit's introspection, which tests/upgrade/schema-drift.test.ts
// uses, cannot read a composite primary key through a drizzle connection.)
export const rolePermissions = pgTable('role_permissions', {
  id: text('id').primaryKey(), // role id + ':' + permission code
  roleId: text('role_id').notNull().references(() => roles.id),
  permissionCode: text('permission_code').notNull().references(() => permissions.code),
}, (t) => [
  uniqueIndex('role_permissions_role_id_permission_code_idx').on(t.roleId, t.permissionCode),
  index('role_permissions_permission_code_idx').on(t.permissionCode),
]);

/**
 * One row per request to give a user a role, with the two e-signatures. `Pending` until a second, independent person signs;
 * then `Approved` (the role changed in the same transaction), `Rejected` or `Cancelled`. users.role stays the role in force; this
 * is the record of who asked, who approved, what they saw (record versions) and what each signature meant.
 */
export const userRoles = pgTable('user_roles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  roleId: text('role_id').notNull().references(() => roles.id), // the role requested
  previousRole: text('previous_role').notNull(), // users.role when the request was made
  status: text('status').notNull(), // Pending | Approved | Rejected | Cancelled
  requestedBy: text('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  requestReason: text('request_reason').notNull(),
  requestMeaning: text('request_meaning').notNull(),
  requestRecordVersion: integer('request_record_version').notNull(), // users.version the first signer saw
  requestSignatureHash: text('request_signature_hash').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  decisionMeaning: text('decision_meaning'),
  decisionRecordVersion: integer('decision_record_version'), // users.version after the change (the version the approval produced)
  decisionSignatureHash: text('decision_signature_hash'),
  version: integer('version').default(1).notNull(), // optimistic concurrency of this row
}, (t) => [
  index('user_roles_user_id_idx').on(t.userId),
  index('user_roles_role_id_idx').on(t.roleId),
  index('user_roles_requested_at_idx').on(t.requestedAt),
  uniqueIndex('user_roles_one_pending_per_user_idx').on(t.userId).where(sql`${t.status} = 'Pending'`),
  check('user_roles_status_check', sql`${t.status} IN ('Pending', 'Approved', 'Rejected', 'Cancelled')`),
]);

/**
 * Independence rules: the person who does `action` on a record of `entity` must not have taken one of `authorActions` on it.
 * Participants are read from the audit trail, which cannot be edited (src/server/authz/sod.ts).
 */
export const sodRules = pgTable('sod_rules', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
  entity: text('entity').notNull(), // the audit_trail.entity of the record
  authorActions: text('author_actions').array().notNull(), // the audit_trail.action values that make someone an author
});
