import { defineConfig } from 'vitest/config';

// Tests run against a real PostgreSQL (never a mock of it). The global setup creates one fresh database per run and drops it
// at the end; a test that needs an empty database of its own calls freshDatabase() from tests/helpers/db.ts.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
