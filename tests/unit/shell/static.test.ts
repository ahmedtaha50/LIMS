/**
 * M03: the built frontend is served from DIST_DIR and nothing else.
 * Server bundles and source maps must never be reachable over HTTP, and the single-page-app fallback must not answer
 * a request for a missing file with index.html (that would hide a 404 as a 200).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../../helpers/testDb';

const BACKUP_SCRIPT = `document.getElementById('b').onclick = () => 1;`;
const BACKUP_STYLE = `body{margin:0}`;

describe('static frontend in production', () => {
  let dist: string;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    await useTestDb();
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dist, 'backup.html'), `<!doctype html><html><head><style>${BACKUP_STYLE}</style></head><body><script>${BACKUP_SCRIPT}</script></body></html>`);
    // What the old build put into the static root:
    for (const f of ['server.cjs', 'server.cjs.map', 'init-db.cjs', 'backup-cli.cjs']) fs.writeFileSync(path.join(dist, f), 'SERVER SOURCE');

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DIST_DIR', dist);
    vi.stubEnv('JWT_SECRET', 'j'.repeat(48));
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { mountFrontend } = await import('../../../src/server/http/static');
    const { db } = await import('../../../src/db/index');
    const app = createApp({ db, rateLimit: false });
    await mountFrontend(app);
    request = supertest(app);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it.each(['/server.cjs', '/server.cjs.map', '/init-db.cjs', '/backup-cli.cjs'])('does not serve %s', async (file) => {
    const res = await request.get(file);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SERVER SOURCE');
  });

  it('serves hashed assets and index.html', async () => {
    const asset = await request.get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    const root = await request.get('/').set('Accept', 'text/html');
    expect(root.status).toBe(200);
    expect(root.text).toContain('id="root"');
    expect(root.headers['cache-control']).toMatch(/no-cache|no-store/);
  });

  it('falls back to index.html only for client-side routes', async () => {
    const route = await request.get('/samples/SMP-2026-00001').set('Accept', 'text/html');
    expect(route.status).toBe(200);
    expect(route.text).toContain('id="root"');
    expect((await request.get('/missing.png')).status).toBe(404);
    expect((await request.get('/missing.js.map')).status).toBe(404);
  });

  it('keeps unknown API routes as JSON 404', async () => {
    const res = await request.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('lets a static page run only its own inline script and style (hash, not unsafe-inline)', async () => {
    const res = await request.get('/backup.html');
    expect(res.status).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    const h = (s: string) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
    expect(csp).toContain(h(BACKUP_SCRIPT));
    expect(csp).toContain(h(BACKUP_STYLE));
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
