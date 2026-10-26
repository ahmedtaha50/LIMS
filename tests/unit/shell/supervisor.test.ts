/**
 * M03: the server child is supervised. Real child processes, real signals, real files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { superviseServer, type Supervisor } from '../../../src/server/obs/supervisor';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

describe('server supervisor', () => {
  let dir: string;
  let sup: Supervisor | null = null;
  const logText = () => { try { return fs.readFileSync(path.join(dir, 'server.log'), 'utf8'); } catch { return ''; } };
  const events = () => logText().split('\n').filter(l => l.includes('"event"')).map(l => JSON.parse(l));

  afterEach(async () => {
    await sup?.stop();
    sup = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = (entry: string, extra: Partial<Parameters<typeof superviseServer>[0]> = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-sup-'));
    sup = superviseServer({ entry: fixture(entry), logDir: dir, backoffMs: [100, 200, 400], ...extra });
    return sup;
  };

  it('restarts a killed child within 10 seconds and records SERVER_RESTART', async () => {
    const s = start('child-ok.cjs');
    const first = await until(() => s.child?.pid);
    const killedAt = Date.now();
    process.kill(first, 'SIGKILL');
    const second = await until(() => (s.child?.pid && s.child.pid !== first ? s.child.pid : undefined));
    expect(Date.now() - killedAt).toBeLessThan(10_000);
    expect(second).not.toBe(first);
    expect(s.restarts).toBe(1);
    await until(() => logText().includes('"restartCount":"1"')); // the new child is told it is a restart
    const e = events().find(x => x.event === 'SERVER_RESTART');
    expect(e).toMatchObject({ event: 'SERVER_RESTART', attempt: 1, signal: 'SIGKILL', source: 'supervisor' });
    expect(typeof e.time).toBe('string');
  });

  it('keeps the stack trace of a crashing child in the log, backs off, and gives up', async () => {
    let gaveUp: unknown = null;
    const s = start('child-crash.cjs', { maxRestarts: 3, onGiveUp: e => { gaveUp = e; } });
    await until(() => gaveUp, 15_000);
    const text = logText();
    expect(text).toContain('boom from fixture');
    expect(text).toMatch(/at .*child-crash\.cjs/);
    const restarts = events().filter(x => x.event === 'SERVER_RESTART');
    expect(restarts.map(r => r.attempt)).toEqual([1, 2, 3]);
    expect(restarts.map(r => r.backoffMs)).toEqual([100, 200, 400]);
    expect(events().some(x => x.event === 'SERVER_GAVE_UP')).toBe(true);
    expect(restarts[0].exitCode).toBe(1);
    expect(s.child).toBeNull();
  });

  it('forgets earlier failures once the child has run stably', async () => {
    const s = start('child-ok.cjs', { stableAfterMs: 150 });
    for (let i = 1; i <= 2; i++) {
      const pid = await until(() => s.child?.pid);
      await sleep(300);
      process.kill(pid, 'SIGKILL');
      await until(() => (s.child?.pid && s.child.pid !== pid ? true : undefined));
    }
    expect(events().filter(x => x.event === 'SERVER_RESTART').map(x => x.attempt)).toEqual([1, 1]);
  });

  it('stops for good when asked', async () => {
    const s = start('child-ok.cjs');
    const pid = await until(() => s.child?.pid);
    await s.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    await sleep(400);
    expect(s.child).toBeNull();
    expect(events().filter(x => x.event === 'SERVER_RESTART')).toHaveLength(0);
  });

  it('never writes credentials from the child output to the log', async () => {
    start('child-secret.cjs');
    await until(() => logText().includes('login ok'));
    await until(() => logText().includes('"msg":"bad"'));
    const text = logText();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc123.def456.ghi789');
    expect(text).not.toContain('correct horse');
    expect(text).toContain('[REDACTED]');
  });
});
