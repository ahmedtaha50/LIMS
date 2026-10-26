/**
 * GET /api/system/info: application version, schema version, and (Admin, QA) the migration journal.
 * The router is mounted on a small Express app with the real requireAuth, because the route is added to
 * src/server/routes/index.ts by the wave gate (r1-core owns that file).
 */
import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootDatabase } from '../../src/server/boot';
import { loadMigrations } from '../../src/server/migrate';
import { scratchDb } from './helpers';

let request: ReturnType<typeof supertest>;
let token: (id: string) => string;

beforeAll(async () => {
  const s = await scratchDb('sysinfo');
  await bootDatabase({ migrate: true, pool: s.pool, backup: null });
  for (const [id, role] of [['usr-admin', 'Admin'], ['usr-qa', 'QA'], ['usr-analyst', 'Analyst']]) {
    await s.pool.query(`insert into users (id, uid, name, role, email) values ($1, $1, $1, $2, $1 || '@example.invalid')`, [id, role]);
  }
  Object.assign(process.env, s.env); // before the first import of src/db/index
  const { db } = await import('../../src/db/index');
  const { createRequireAuth } = await import('../../src/server/core/auth');
  const { createSession } = await import('../../src/server/auth/sessions');
  const { signAccessToken } = await import('../../src/server/auth/tokens');
  const { systemRoutes } = await import('../../src/server/routes/system');
  const app = express();
  app.use('/api', systemRoutes({ db, requireAuth: createRequireAuth(db) }));
  request = supertest(app);
  // r1-identity: a token now proves a session row. Mint one the way sign-in does.
  const tokens: Record<string, string> = {};
  for (const id of ['usr-admin', 'usr-qa', 'usr-analyst']) {
    const session = await createSession(db, { userId: id, authMethod: 'password', absoluteHours: 1 });
    tokens[id] = signAccessToken({ userId: id, sessionId: session.id, expiresAt: session.expiresAt });
  }
  token = id => tokens[id];
});

describe('GET /api/system/info', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await request.get('/api/system/info')).status).toBe(401);
  });

  it('tells any signed-in user the versions and whether the schema is current, but not the journal', async () => {
    const res = await request.get('/api/system/info').set('Authorization', `Bearer ${token('usr-analyst')}`);
    expect(res.status).toBe(200);
    const latest = loadMigrations().at(-1)!.id;
    expect(res.body).toMatchObject({ schemaVersion: latest, latestAvailableSchemaVersion: latest, schemaCurrent: true, databaseTimeZone: 'UTC' });
    expect(typeof res.body.appVersion).toBe('string');
    expect(new Date(res.body.serverTime).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(res.body).not.toHaveProperty('migrations');
  });

  it('gives Admin and QA the journal with the checksums', async () => {
    for (const id of ['usr-admin', 'usr-qa']) {
      const res = await request.get('/api/system/info').set('Authorization', `Bearer ${token(id)}`);
      expect(res.status).toBe(200);
      expect(res.body.migrations.map((m: any) => m.id)).toEqual(loadMigrations().map(f => f.id));
      expect(res.body.migrations[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
