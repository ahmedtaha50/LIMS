/**
 * M03: the Express app and Socket.IO are two request listeners on one http server (server.ts). Socket.IO answers
 * /socket.io/ itself; the app must stay out of it, or whichever writes second fails with ERR_HTTP_HEADERS_SENT
 * (seen in the browser run as a crashed server). Wired exactly as server.ts wires them.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../../helpers/testDb';

describe('Socket.IO next to the Express app', () => {
  let httpServer: Server;
  let base: string;
  let dist: string;
  const errors: unknown[][] = [];

  beforeAll(async () => {
    await useTestDb();
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    vi.stubEnv('NODE_ENV', 'production'); // Express only logs a final-handler error outside the test environment
    vi.stubEnv('JWT_SECRET', 'j'.repeat(48));
    vi.stubEnv('DIST_DIR', dist);
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
    const { createApp } = await import('../../../src/server/app');
    const { mountFrontend } = await import('../../../src/server/http/static');
    const { createRealtime } = await import('../../../src/server/realtime');
    const { db } = await import('../../../src/db/index');

    httpServer = createServer();
    createRealtime(httpServer);
    const app = createApp({ db, rateLimit: false });
    await mountFrontend(app);
    httpServer.on('request', app);
    await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await new Promise<void>(r => httpServer.close(() => r()));
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('answers the polling handshake once, with Socket.IO\'s own response, and logs no error', async () => {
    const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^0\{"sid":"/);
    await new Promise(r => setTimeout(r, 300));
    expect(errors.map(e => String(e[0]))).toEqual([]);
  });

  it('also stays out of requests Socket.IO refuses immediately (unknown session id)', async () => {
    const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=does-not-exist`);
    expect(res.status).toBe(400);
    await new Promise(r => setTimeout(r, 300));
    expect(errors.map(e => String(e[0]))).toEqual([]);
  });

  it('keeps serving the app after socket traffic', async () => {
    await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    const page = await fetch(`${base}/dashboard`, { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="root"');
  });
});
