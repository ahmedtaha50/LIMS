import { defineConfig } from 'vitest/config';

/**
 * Migration and upgrade tests (roadmap M04). They need a real PostgreSQL and a role that may CREATE DATABASE, like
 * the main suite, but they build their own databases (empty, v0.1.0 fixture, fresh install) instead of copying the
 * shared template, so this config has no globalSetup:
 *
 *   SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_migrations \
 *     npx vitest run -c tests/upgrade/vitest.config.ts
 *
 * SQL_DB_NAME is only a name prefix: scratch databases are called <SQL_DB_NAME>_up<pid>_<label> and dropped afterwards;
 * SQL_DB_NAME itself is never touched. The root vitest.config.ts (r1-core) can include the same files with
 * 'tests/upgrade/**\/*.test.ts' once the wave gate adds that pattern.
 */
export default defineConfig({
  test: {
    include: ['tests/upgrade/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test', JWT_SECRET: 'vitest-only-jwt-secret', LOG_LEVEL: 'silent' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
