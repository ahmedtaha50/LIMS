// Domain: identity (users, sessions, credentials, security settings, training). Split out of src/db/schema.ts by r1-migrations; r1-identity owns this file.
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, bigint, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

// integration_settings lives in its own file (roadmap M16) and is re-exported here so schema/index.ts, which this track does not own, picks it up.
export * from './integrations';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  uid: text('uid').unique().notNull(), // Firebase Auth UID
  name: text('name').notNull(),
  role: text('role').notNull(),
  active: boolean('active').default(true).notNull(), // false = deactivated by an administrator; a lockout never touches it
  passwordHash: text('password_hash'), // For E-Signatures (local hash)
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).defaultNow(), // For password expiry
  email: text('email'),
  // Signing lockout (SC-016): wrong e-signature passwords. locked_at is the time until which signing is refused (it expires by itself); sign-in ignores it.
  failedAttempts: integer('failed_attempts').default(0).notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  hasCompletedSoftwareTraining: boolean('has_completed_software_training').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  totpSecret: text('totp_secret'), // v<generation>:... ciphertext (src/server/crypto/keystore.ts); a bare base32 value is a legacy plaintext secret
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  // Added by migration 0010 (roadmap M05)
  mustChangePassword: boolean('must_change_password').default(false).notNull(),
  loginFailedAttempts: integer('login_failed_attempts').default(0).notNull(), // sign-in lockout: wrong passwords or wrong TOTP codes at sign-in
  loginLockedUntil: timestamp('login_locked_until', { withTimezone: true }),
  totpPendingSecret: text('totp_pending_secret'), // enrolment in progress, encrypted like totp_secret
  totpLastStep: bigint('totp_last_step', { mode: 'number' }), // newest accepted 30 s step: a code from this step or earlier is a replay
  totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(), // optimistic concurrency for administrator edits (counters are atomic increments and do not use it)
}, (t) => [
  uniqueIndex('users_email_lower_uidx').on(sql`lower(${t.email})`),
]);

export const trainingRecords = pgTable('training_records', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  moduleName: text('module_name').notNull(),
  status: text('status').notNull(), // e.g. Pending, Completed
  completedAt: timestamp('completed_at', { withTimezone: true }),
  certifiedBy: text('certified_by'),
  version: integer('version').default(1).notNull()
}, (t) => [
  index('training_records_user_id_idx').on(t.userId),
]);

export const systemSettings = pgTable('system_settings', {
  id: text('id').primaryKey(), // usually just 'default'
  sessionTimeoutMinutes: integer('session_timeout_minutes').default(15).notNull(), // idle timeout
  maxFailedLogins: integer('max_failed_logins').default(3).notNull(),
  passwordExpiryDays: integer('password_expiry_days').default(90).notNull(),
  minPasswordLength: integer('min_password_length').default(8).notNull(),
  requireUppercase: boolean('require_uppercase').default(true).notNull(),
  requireNumbers: boolean('require_numbers').default(true).notNull(),
  requireSymbols: boolean('require_symbols').default(true).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Added by migration 0010 (roadmap M05)
  passwordHistoryCount: integer('password_history_count').default(5).notNull(), // a new password may not equal one of the last N
  lockoutMinutes: integer('lockout_minutes').default(15).notNull(), // sign-in lock and signing lock both end by themselves after this
  mfaRequired: boolean('mfa_required').default(false).notNull(),
  sessionAbsoluteHours: integer('session_absolute_hours').default(12).notNull(), // hard cap, never extended by activity or re-authentication
  version: integer('version').default(1).notNull(),
});

/** One row per sign-in. The access token carries only the session id; every request is checked against this row. */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // absolute limit
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
  authMethod: text('auth_method').notNull(), // password | password+totp | password+recovery
}, (t) => [
  index('sessions_user_id_idx').on(t.userId),
]);

/** Previous password hashes (including the current one), newest last, for the "not one of the last N" rule. */
export const passwordHistory = pgTable('password_history', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('password_history_user_id_idx').on(t.userId),
]);

/** Single-use second-step challenges (purpose mfa or enrol). The JWT carries the jti; this row says whether it was spent. */
export const authChallenges = pgTable('auth_challenges', {
  jti: text('jti').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  purpose: text('purpose').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  index('auth_challenges_user_id_idx').on(t.userId),
]);

/** One-time MFA recovery codes, stored as salted scrypt hashes like passwords. */
export const recoveryCodes = pgTable('recovery_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  codeHash: text('code_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
}, (t) => [
  index('recovery_codes_user_id_idx').on(t.userId),
]);
