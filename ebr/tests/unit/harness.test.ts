import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// E25 (and E01#1): the suite never passes by skipping. With PostgreSQL out of reach it must stop before any test, with the
// reason, and exit non-zero. Run in a child process against a port where nothing listens.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('the test harness without its database (E25)', () => {
  it('E25#1: with PostgreSQL unreachable the suite fails with the reason and runs no test; nothing is skipped', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/api/audit.test.ts', '--reporter=json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, TEST_ADMIN_URL: 'postgres://nobody:nothing@127.0.0.1:1/postgres', FORCE_COLOR: '0' },
    });
    const out = r.stdout + r.stderr;
    expect(r.status, out).not.toBe(0);
    expect(out).toMatch(/PostgreSQL is not reachable/);
    expect(out).toMatch(/do not skip/);
    const json = r.stdout.slice(r.stdout.indexOf('{'));
    if (json.startsWith('{')) {
      const report = JSON.parse(json) as { numPassedTests: number; numPendingTests: number; numTodoTests: number };
      expect(report.numPassedTests).toBe(0);
      expect(report.numPendingTests + report.numTodoTests).toBe(0);
    }
    expect(out).not.toMatch(/\d+ passed/);
    expect(out).not.toMatch(/\d+ skipped/);
  });
});
