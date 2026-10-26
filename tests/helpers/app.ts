/**
 * Boots the real Express application (src/server/app.ts) against this test file's own PostgreSQL database.
 *
 *   const t = await startTestApp();
 *   const res = await t.request.get('/api/samples').set(await t.auth('analyst1@gxp.com'));
 *
 * Build the auth header BEFORE creating a supertest request (const h = await t.auth(...); t.request.get(..).set(h)):
 * a request object that sits idle across an await can have its ephemeral server closed by another request that finishes meanwhile.
 *
 * Product modules are imported dynamically, AFTER useTestDb() has pointed SQL_DB_NAME at the throwaway database,
 * because src/db/index reads the environment once at first import. Import product code in tests only through here
 * (or after awaiting useTestDb()).
 */
import supertest from 'supertest';
import type { Express } from 'express';
import { TEST_PASSWORD } from './db';
import { useTestDb, type TestDb } from './testDb';

/** Stand-in for the Socket.IO server that records every emit. */
export class IoRecorder {
  readonly emitted: Array<{ event: string; payload: any }> = [];
  emit(event: string, payload?: any) { this.emitted.push({ event, payload }); return true; }
}

export interface TestApp {
  app: Express;
  request: ReturnType<typeof supertest>;
  io: IoRecorder;
  /** Direct SQL access to this file's database. */
  db: TestDb;
  /** Logs in through the public login route and returns the bearer token. */
  token(email: string): Promise<string>;
  /** Ready-to-spread authorization header: .set(await t.auth('qa@gxp.com')). */
  auth(email: string): Promise<{ Authorization: string }>;
}

export async function startTestApp(): Promise<TestApp> {
  const testDb = await useTestDb();
  const { createApp } = await import('../../src/server/app');
  const { db } = await import('../../src/db/index');
  const io = new IoRecorder();
  const app = createApp({ db, io: io as any, rateLimit: false });
  const request = supertest(app);
  const tokens = new Map<string, string>();

  const token = async (email: string) => {
    if (!tokens.has(email)) {
      const res = await request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD });
      if (res.status !== 200 || !res.body.token) throw new Error(`Test login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
      tokens.set(email, res.body.token);
    }
    return tokens.get(email)!;
  };

  return { app, request, io, db: testDb, token, auth: async (email) => ({ Authorization: `Bearer ${await token(email)}` }) };
}
