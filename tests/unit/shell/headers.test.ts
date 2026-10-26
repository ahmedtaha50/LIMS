/**
 * M03: Content-Security-Policy and related headers are on in production and describe a self-hosted, offline app.
 */
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../../helpers/testDb';

async function appFor(nodeEnv: string) {
  await useTestDb();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('JWT_SECRET', 'j'.repeat(48));
  vi.resetModules();
  const { createApp } = await import('../../../src/server/app');
  const { db } = await import('../../../src/db/index');
  return supertest(createApp({ db, rateLimit: false }));
}

describe('security headers', () => {
  afterAll(() => { vi.unstubAllEnvs(); });

  describe('production', () => {
    let request: ReturnType<typeof supertest>;
    beforeAll(async () => { request = await appFor('production'); });

    it('sends a strict CSP with no external hosts and no inline script', async () => {
      const res = await request.get('/api/nope');
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp).not.toBe('');
      const directive = (name: string) => csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) ?? '';
      expect(directive('default-src')).toBe("default-src 'self'");
      expect(directive('script-src')).toBe("script-src 'self'");
      expect(directive('object-src')).toBe("object-src 'none'");
      expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
      expect(directive('font-src')).toMatch(/^font-src 'self'/);
      expect(csp).not.toMatch(/https?:\/\/|\*/);
      expect(csp).not.toContain('unsafe-eval');
      // plain http on loopback: upgrading sub-resources to https would break the page
      expect(csp).not.toContain('upgrade-insecure-requests');
    });

    it('does not trust X-Forwarded-For unless a proxy is configured', async () => {
      const { createApp } = await import('../../../src/server/app');
      const { db } = await import('../../../src/db/index');
      const app = createApp({ db, rateLimit: false });
      expect(app.get('trust proxy')).toBeFalsy();
    });
  });

  describe('development', () => {
    it('leaves CSP off so the Vite dev server can inject its client', async () => {
      const request = await appFor('development');
      const res = await request.get('/api/nope');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  });
});

describe('requireTlsFromRemote (LAN mode safety net)', () => {
  const run = async (remoteAddress: string, encrypted?: boolean) => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    const { requireTlsFromRemote } = await import('../../../src/server/http/security');
    let status = 0; let nextCalled = false;
    const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
    requireTlsFromRemote({ socket: { remoteAddress, encrypted } } as any, res, () => { nextCalled = true; });
    return { status, nextCalled };
  };
  afterAll(() => { vi.unstubAllEnvs(); });

  it('lets loopback and TLS connections through and refuses plain http from another computer', async () => {
    expect(await run('127.0.0.1')).toEqual({ status: 0, nextCalled: true });
    expect(await run('::1')).toEqual({ status: 0, nextCalled: true });
    expect(await run('::ffff:127.0.0.1')).toEqual({ status: 0, nextCalled: true });
    expect(await run('192.168.1.20', true)).toEqual({ status: 0, nextCalled: true });
    expect(await run('192.168.1.20')).toEqual({ status: 403, nextCalled: false });
    expect(await run('::ffff:10.0.0.7')).toEqual({ status: 403, nextCalled: false });
  });
});
