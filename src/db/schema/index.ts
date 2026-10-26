/**
 * The database schema, one file per domain. Every table exported here must be created by a migration in drizzle/
 * (tests/upgrade/schema-drift.test.ts fails otherwise), and every timestamp column is `withTimezone: true`.
 * Domain files belong to the track named in their first line; this index and the migrations belong to r1-migrations.
 */
export * from './identity';
export * from './signatures';
export * from './audit';
export * from './samples';
export * from './oos';
export * from './specifications';
export * from './eln';
export * from './equipment';
export * from './ops';
export * from './authz';
export * from './master';
export * from './qms';
export * from './audit-review';
export * from './methods';
export * from './calc';
export * from './rawdata';
export * from './api-clients';
export * from './events';
export * from './reports';
export * from './documents';
export * from './training';
export * from './em';
export * from './stability';
export * from './reagents';
export * from './custody';
export * from './tat';
export * from './worklists';
export * from './instrument-data';
export * from './directory';
export * from './spc';
export * from './periodic';
export * from './qualified';
export * from '../../i18n/server/schema';
