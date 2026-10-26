import { defineConfig } from 'vitest/config';

/**
 * Unit and API tests run against a real PostgreSQL (never a mock). tests/helpers/globalSetup.ts builds a template
 * database once; every test file that needs data gets its own throwaway copy (tests/helpers/db.ts), so files can
 * run in parallel and never see each other's rows. Connection settings come from the same SQL_* variables as the app.
 * This file takes precedence over vite.config.ts, so the React/Tailwind plugins are not loaded for tests.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/upgrade/**/*.test.ts', 'tests/perf/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.ts'],
    env: { NODE_ENV: 'test', JWT_SECRET: 'vitest-only-jwt-secret', LOG_LEVEL: 'silent' },
    // The upgrade tests (tests/upgrade, roadmap M04) build their own databases and spawn the installer, which is slower than a copy of the template.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
