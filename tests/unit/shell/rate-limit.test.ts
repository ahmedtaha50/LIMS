/**
 * M03: rate limits that work on a shared loopback address.
 *  - the auth limiter cannot be reset by rotating X-Forwarded-For
 *  - a refused request is JSON, not text the UI cannot parse
 *  - one user cannot exhaust the budget of another user behind the same address
 * Limits are lowered through the environment so the tests stay fast.
 */
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_PASSWORD } from '../../helpers/db';
import { useTestDb } from '../../helpers/testDb';

describe('rate limits', () => {
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    await useTestDb();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'j'.repeat(48));
    vi.stubEnv('RATE_LIMIT_AUTH_IP_FAILURES', '8');
    vi.stubEnv('RATE_LIMIT_AUTH_EMAIL_FAILURES', '5');
    vi.stubEnv('RATE_LIMIT_USER_PER_MINUTE', '30');
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    request = supertest(createApp({ db, rateLimit: true }));
  });
  afterAll(() => { vi.unstubAllEnvs(); });

  const login = (email: string, password: string, forwardedFor?: string) => {
    const r = request.post('/api/auth/login-local').send({ email, password });
    return forwardedFor ? r.set('X-Forwarded-For', forwardedFor) : r;
  };

  it('keeps counting failed logins from one address while X-Forwarded-For rotates', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(`nobody${i}@example.invalid`, 'wrong', `10.9.${i}.${i + 1}`)).status);
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(codes.slice(8)).toEqual(Array(4).fill(429));
  });

  it('answers 429 with JSON, a stable code, a request id and Retry-After', async () => {
    const res = await login('nobody-again@example.invalid', 'wrong', '10.8.8.8');
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.requestId).toBeTruthy();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not count successful logins against the brute-force budget', async () => {
    // The address is already over its failure budget above, so this uses a fresh app instance.
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const fresh = supertest(createApp({ db, rateLimit: true }));
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await fresh.post('/api/auth/login-local').send({ email: 'qa@gxp.com', password: TEST_PASSWORD })).status);
    expect(codes).toEqual(Array(12).fill(200));
  });

  it('limits one e-mail address across addresses, without locking out other e-mail addresses', async () => {
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const fresh = supertest(createApp({ db, rateLimit: true }));
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await fresh.post('/api/auth/login-local').send({ email: 'victim@example.invalid', password: 'x' }).set('X-Forwarded-For', `10.7.7.${i + 1}`)).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const other = await fresh.post('/api/auth/login-local').send({ email: 'someone-else@example.invalid', password: 'x' });
    expect(other.status).toBe(401);
  });

  it('gives every signed-in user an own budget behind the same address', async () => {
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const fresh = supertest(createApp({ db, rateLimit: true }));
    const tok = async (email: string) => (await fresh.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD })).body.token as string;
    const analyst = await tok('analyst1@gxp.com');
    const qa = await tok('qa@gxp.com');

    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await fresh.get('/api/samples').set('Authorization', `Bearer ${analyst}`)).status);
    expect(codes.filter(c => c === 200).length).toBe(30);
    expect(codes.filter(c => c === 429).length).toBe(10);

    const other = await fresh.get('/api/samples').set('Authorization', `Bearer ${qa}`);
    expect(other.status).toBe(200);
    const refused = await fresh.get('/api/samples').set('Authorization', `Bearer ${analyst}`);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
  });

  it('never throttles the health probes', async () => {
    vi.resetModules();
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const fresh = supertest(createApp({ db, rateLimit: true }));
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await fresh.get('/api/health')).status);
    expect(new Set(codes)).toEqual(new Set([200]));
  });
});
