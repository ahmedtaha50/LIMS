/**
 * Security events (roadmap M08, SEC-09): a hash-chained, append-only log of who tried to get in, who was locked out,
 * what was refused and what left the system. Each event is written in its own transaction so that a request that
 * fails (and rolls back) still leaves its trace.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst', { Authorization: string }>;
let db: any;
let mod: typeof import('../../src/server/audit/securityEvents');

const base = { type: 'AUTH_LOGIN_FAILED', outcome: 'failure' as const, actorLabel: 'someone@example.com', ip: '10.0.0.5' };

async function asOwner(sqlText: string, params: unknown[] = []) {
  const c = await t.db.pool.connect();
  try {
    await c.query('ALTER TABLE security_events DISABLE TRIGGER USER');
    try { await c.query(sqlText, params); } finally { await c.query('ALTER TABLE security_events ENABLE TRIGGER USER'); }
  } finally { c.release(); }
}

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst: await t.auth('analyst1@gxp.com') };
  ({ db } = await import('../../src/db/index'));
  mod = await import('../../src/server/audit/securityEvents');
});

describe('recordSecurityEvent', () => {
  it('stores the event and chains it to the one before', async () => {
    // Other code (the sign-in routes the test app logs in through) may have written events already: continue from the tail.
    const tail = (await t.db.pool.query('SELECT sequence, hash FROM security_events ORDER BY sequence DESC LIMIT 1')).rows[0] ?? { sequence: 0, hash: '0'.repeat(64) };
    const a = await mod.recordSecurityEvent(db, { ...base, actorId: null, userAgent: 'curl/8', requestId: 'req-1', detail: { attempt: 1 } });
    const b = await mod.recordSecurityEvent(db, { type: 'AUTH_LOGOUT', outcome: 'success', actorId: 'usr-qa', actorRole: 'QA', sessionId: 'sess-1' });
    expect(a).toMatchObject({ sequence: tail.sequence + 1, eventType: 'AUTH_LOGIN_FAILED', outcome: 'failure', actorLabel: 'someone@example.com', ip: '10.0.0.5', userAgent: 'curl/8', requestId: 'req-1', hashVersion: 1, hashAlg: 'sha256' });
    expect(JSON.parse(a.detail)).toEqual({ attempt: 1 });
    expect(a.prevHash).toBe(tail.hash);
    expect(b).toMatchObject({ sequence: tail.sequence + 2, prevHash: a.hash, actorId: 'usr-qa', actorRole: 'QA', sessionId: 'sess-1' });
    expect(typeof b.appVersion).toBe('string');
    expect(await mod.verifySecurityChain(db)).toMatchObject({ isValid: true, compromisedSequence: null });
  });

  it('is written in its own transaction: it survives the rollback of the request that raised it', async () => {
    const before = (await t.db.pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n;
    await expect(db.transaction(async () => {
      await mod.recordSecurityEvent(db, { type: 'AUTHZ_DENIED', outcome: 'denied', actorId: 'usr-analyst1', detail: { route: 'POST /specifications/x/approve' } });
      throw new Error('the business transaction fails');
    })).rejects.toThrow('the business transaction fails');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n).toBe(before + 1);
  });

  it('writeSecurityEvent joins a transaction the caller has: it commits with it and disappears if it rolls back', async () => {
    const count = async () => (await t.db.pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n;
    const before = await count();
    await db.transaction((tx: any) => mod.writeSecurityEvent(tx, { type: 'CONFIG', outcome: 'info', actorId: 'usr-admin', detail: { setting: 'x' } }));
    expect(await count()).toBe(before + 1);
    await expect(db.transaction(async (tx: any) => { await mod.writeSecurityEvent(tx, { type: 'CONFIG', outcome: 'info', actorId: 'usr-admin' }); throw new Error('rolled back'); })).rejects.toThrow('rolled back');
    expect(await count()).toBe(before + 1);
    expect((await mod.verifySecurityChain(db)).isValid).toBe(true);
  });

  it('keeps contiguous sequence numbers and one valid chain under concurrent writers', async () => {
    const before = (await t.db.pool.query('SELECT max(sequence)::int AS s FROM security_events')).rows[0].s;
    await Promise.all(Array.from({ length: 15 }, (_, i) => mod.recordSecurityEvent(db, { ...base, detail: { i } })));
    const seqs = (await t.db.pool.query('SELECT sequence FROM security_events WHERE sequence > $1 ORDER BY sequence', [before])).rows.map(r => r.sequence);
    expect(seqs).toEqual(Array.from({ length: 15 }, (_, i) => before + 1 + i));
    expect((await mod.verifySecurityChain(db)).isValid).toBe(true);
  });

  it('never stores credentials: secret-looking keys are dropped from the detail, at any depth', async () => {
    const e = await mod.recordSecurityEvent(db, { ...base, detail: { password: 'hunter2', note: 'ok', nested: { totpCode: '123456', token: 'abc', keep: 1 }, list: [{ secret: 'x', fine: true }] } });
    expect(JSON.parse(e.detail)).toEqual({ note: 'ok', nested: { keep: 1 }, list: [{ fine: true }] });
  });

  it('bounds the size of the detail instead of failing or filling the log', async () => {
    const one = await mod.recordSecurityEvent(db, { ...base, detail: { blob: 'x'.repeat(50_000) } });
    expect(JSON.parse(one.detail).blob.length).toBeLessThanOrEqual(501); // a single long text is clipped
    const many = await mod.recordSecurityEvent(db, { ...base, detail: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'y'.repeat(400)])) });
    expect(many.detail.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(many.detail)).toMatchObject({ truncated: true });
    expect((await mod.verifySecurityChain(db)).isValid).toBe(true);
  });

  it('refuses a malformed event type or outcome rather than storing an unsearchable row', async () => {
    await expect(mod.recordSecurityEvent(db, { ...base, type: 'login failed' })).rejects.toThrow(/event type/i);
    await expect(mod.recordSecurityEvent(db, { ...base, type: '' })).rejects.toThrow(/event type/i);
    await expect(mod.recordSecurityEvent(db, { ...base, outcome: 'maybe' as any })).rejects.toThrow(/outcome/i);
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused by the database', async () => {
    const first = '(SELECT min(sequence) FROM security_events)';
    await expect(t.db.pool.query(`UPDATE security_events SET outcome = 'success' WHERE sequence = ${first}`)).rejects.toThrow(/not permitted/);
    await expect(t.db.pool.query(`DELETE FROM security_events WHERE sequence = ${first}`)).rejects.toThrow(/not permitted/);
    await expect(t.db.pool.query('TRUNCATE security_events')).rejects.toThrow(/not permitted/);
  });

  it('securityEventContext takes address, agent, request id and session from the request', () => {
    const req: any = { ip: '192.168.1.9', id: 'req-77', get: (h: string) => (h.toLowerCase() === 'user-agent' ? 'Mozilla/5.0' : undefined), sessionId: 'sess-9' };
    expect(mod.securityEventContext(req)).toEqual({ ip: '192.168.1.9', userAgent: 'Mozilla/5.0', requestId: 'req-77', sessionId: 'sess-9' });
    expect(mod.securityEventContext({ get: () => undefined } as any)).toEqual({ ip: null, userAgent: null, requestId: null, sessionId: null });
  });
});

describe('security event routes', () => {
  it('GET /api/security-events is for Admin and QA', async () => {
    expect((await t.request.get('/api/security-events')).status).toBe(401);
    expect((await t.request.get('/api/security-events').set(H.analyst)).status).toBe(403);
    expect((await t.request.get('/api/security-events').set(H.reviewer)).status).toBe(403);
    expect((await t.request.get('/api/security-events').set(H.qa)).status).toBe(200);
    expect((await t.request.get('/api/security-events').set(H.admin)).status).toBe(200);
  });

  it('pages by cursor, newest first, and filters by type, outcome, actor and time', async () => {
    for (let i = 0; i < 12; i++) await mod.recordSecurityEvent(db, { type: 'LOCKOUT', outcome: 'denied', actorId: 'usr-reviewer', detail: { i } });
    const h = H.qa;
    const p1 = await t.request.get('/api/security-events').query({ type: 'LOCKOUT', limit: 5 }).set(h);
    expect(p1.body.events).toHaveLength(5);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await t.request.get('/api/security-events').query({ type: 'LOCKOUT', limit: 5, cursor: p1.body.nextCursor }).set(h);
    const p3 = await t.request.get('/api/security-events').query({ type: 'LOCKOUT', limit: 5, cursor: p2.body.nextCursor }).set(h);
    expect(p3.body.events).toHaveLength(2);
    expect(p3.body).toMatchObject({ hasMore: false, nextCursor: null });
    const all = [...p1.body.events, ...p2.body.events, ...p3.body.events].map((e: any) => e.sequence);
    expect(new Set(all).size).toBe(12);
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(p1.body.events[0]).toMatchObject({ eventType: 'LOCKOUT', outcome: 'denied', actorId: 'usr-reviewer', hashAlg: 'sha256' });

    const get = (q: Record<string, unknown>) => t.request.get('/api/security-events').query({ limit: 100, ...q }).set(h);
    expect((await get({ type: 'LOCKOUT', outcome: 'denied', actorId: 'usr-reviewer' })).body.events).toHaveLength(12); // (the AUTHZ_DENIED events of earlier tests are the authorisation layer's, r1-authz)
    expect((await get({ actorId: 'usr-nobody' })).body.events).toHaveLength(0);
    const hourAhead = new Date(Date.now() + 3600_000).toISOString();
    expect((await get({ type: 'LOCKOUT', from: hourAhead })).body.events).toHaveLength(0);
    expect((await get({ type: 'LOCKOUT', to: hourAhead })).body.events).toHaveLength(12);
  });

  it('lists the event types that exist, for the filter of the viewer', async () => {
    const res = await t.request.get('/api/security-events/types').set(H.qa);
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual(expect.arrayContaining(['AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'AUTH_LOGOUT', 'LOCKOUT', 'AUTHZ_DENIED', 'EXTERNAL_CALL']));
  });

  it('rejects unknown and malformed query parameters', async () => {
    const h = H.qa;
    for (const q of [{ bogus: 1 }, { limit: 1000 }, { cursor: 'x' }, { outcome: 'maybe' }, { type: 'not valid' }, { from: 'soon' }]) {
      expect((await t.request.get('/api/security-events').query(q as any).set(h)).status, JSON.stringify(q)).toBe(400);
    }
  });

  it('POST /api/security-events/verify checks the chain, for Admin and QA, and names a tampered event', async () => {
    expect((await t.request.post('/api/security-events/verify')).status).toBe(401);
    expect((await t.request.post('/api/security-events/verify').set(H.analyst)).status).toBe(403);
    const ok = await t.request.post('/api/security-events/verify').set(H.qa);
    expect(ok.body).toMatchObject({ isValid: true, compromisedSequence: null });
    expect(ok.body.totalRecords).toBeGreaterThan(20);

    const target = (await t.db.pool.query(`SELECT sequence FROM security_events WHERE event_type = 'LOCKOUT' ORDER BY sequence LIMIT 1`)).rows[0].sequence;
    await asOwner(`UPDATE security_events SET outcome = 'success' WHERE sequence = $1`, [target]);
    const bad = await t.request.post('/api/security-events/verify').set(H.admin);
    expect(bad.body).toMatchObject({ isValid: false, compromisedSequence: target });
  });
});

// The sign-in code belongs to r1-identity. Its single choke point for security events (src/server/auth/events.ts) writes them into
// the audit trail today. Once the sign-in code records them with recordSecurityEvent / writeSecurityEvent from
// src/server/audit/securityEvents.ts, this end-to-end check runs by itself; until then it is skipped, and says so, instead of
// failing. Event types are the contract: AUTH_LOGIN_FAILED, LOCKOUT and AUTH_LOGOUT, one event each.
function routesRecordSecurityEvents(): boolean {
  const root = path.resolve(__dirname, '..', '..', 'src', 'server');
  const files: string[] = [path.join(root, 'routes', 'auth.ts')];
  const walk = (dir: string) => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(root, 'auth'));
  return files.some(f => fs.existsSync(f) && /audit\/securityEvents/.test(fs.readFileSync(f, 'utf8')));
}

describe.skipIf(!routesRecordSecurityEvents())('sign-in events (needs r1-identity to call recordSecurityEvent)', () => {
  const count = async (type: string) => (await t.db.pool.query('SELECT count(*)::int AS n FROM security_events WHERE event_type = $1', [type])).rows[0].n;

  it('a failed login, a lockout and a logout each create one security event', async () => {
    const failed0 = await count('AUTH_LOGIN_FAILED'), lock0 = await count('LOCKOUT'), out0 = await count('AUTH_LOGOUT');
    const login = (password: string) => t.request.post('/api/auth/login-local').send({ email: 'reviewer@gxp.com', password });
    expect((await login('wrong-1')).status).toBe(401);
    expect(await count('AUTH_LOGIN_FAILED')).toBe(failed0 + 1);
    expect(await count('LOCKOUT')).toBe(lock0);
    await login('wrong-2');
    await login('wrong-3'); // the third failure locks the account
    expect(await count('LOCKOUT')).toBe(lock0 + 1);
    const token = await t.token('analyst2@gxp.com');
    expect((await t.request.post('/api/auth/logout').set({ Authorization: `Bearer ${token}` })).status).toBeLessThan(300);
    expect(await count('AUTH_LOGOUT')).toBe(out0 + 1);
    const e = (await t.db.pool.query(`SELECT * FROM security_events WHERE event_type = 'AUTH_LOGIN_FAILED' ORDER BY sequence DESC LIMIT 1`)).rows[0];
    expect(JSON.stringify(e)).not.toContain('wrong-');
  });
});
