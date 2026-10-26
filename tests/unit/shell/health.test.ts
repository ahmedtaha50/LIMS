/**
 * M03: /api/health (process is up) and /api/ready (process can serve: database answers).
 * Both are unauthenticated and reveal no connection detail. The failing database is a real, unreachable one.
 */
import express from 'express';
import pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '../../helpers/testDb';

describe('health and readiness', () => {
  beforeAll(async () => {
    await useTestDb();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'j'.repeat(48));
    vi.resetModules();
  });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('GET /api/health answers 200 without credentials', async () => {
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const res = await supertest(createApp({ db, rateLimit: false })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(typeof res.body.version).toBe('string');
  });

  it('GET /api/ready answers 200 when the database answers', async () => {
    const { createApp } = await import('../../../src/server/app');
    const { db } = await import('../../../src/db/index');
    const res = await supertest(createApp({ db, rateLimit: false })).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
  });

  it('GET /api/ready answers 503 and no detail when the database is unreachable', async () => {
    const { healthRouter } = await import('../../../src/server/obs/health');
    const dead = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'x', password: 'secret-password-not-in-output', database: 'x', connectionTimeoutMillis: 500 });
    const app = express();
    app.use('/api', healthRouter({ getPool: () => dead, timeoutMs: 1000 }));
    const res = await supertest(app).get('/api/ready');
    await dead.end();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_ready', checks: { database: 'failed' } });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|secret-password|127\.0\.0\.1/);
    // liveness is independent of the database
    expect((await supertest(app).get('/api/health')).status).toBe(200);
  });
});
