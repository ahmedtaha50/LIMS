import { defineConfig } from '@playwright/test';

// Browser tests of the BUILT application (npm run build first) at the two sizes the plant uses (E05#1).
const port = Number(process.env.E2E_PORT ?? 4103);
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  projects: [
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: 'node tests/e2e/support/server.mjs', url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 60_000 },
});
