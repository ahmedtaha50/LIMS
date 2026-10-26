/**
 * Roadmap M23 (r2-events): the transactional outbox, persistent notifications and authenticated sockets.
 *
 *   - an event is written in the transaction of the change: a rolled-back change leaves no outbox row and no socket message;
 *   - the dispatcher fans each committed event out once: a notification row for every active user whose role holds the event's
 *     audience permission, pushed to that user's own socket room only;
 *   - a user who was offline sees the notification at the next sign-in (GET /api/notifications), and marks it read;
 *   - a socket without a valid session token is refused; a revoked session is disconnected;
 *   - an OOS result entered through the real route produces exactly one result.oos_detected event without the value.
 */
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq, receiveSample } from '../helpers/fixtures';
import { sql as sqlTag } from 'drizzle-orm';

let t: TestApp;
let http: HttpServer;
let realtime: any;
let url: string;
let ev: typeof import('../../src/server/events');
let dbMod: typeof import('../../src/db/index');
let tx: typeof import('../../src/server/core/tx');
const sockets: Socket[] = [];

const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

beforeAll(async () => {
  t = await startTestApp();
  ev = await import('../../src/server/events');
  dbMod = await import('../../src/db/index');
  tx = await import('../../src/server/core/tx');
  const { createRealtime } = await import('../../src/server/realtime');
  http = createServer();
  realtime = createRealtime(http, { db: dbMod.db, revalidateMs: 200 });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise<void>(r => realtime.close(() => r()));
});

/** Connects a socket; resolves when connected, rejects with the server's refusal. */
function open(auth: Record<string, unknown> | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

const received = (s: Socket) => { const got: any[] = []; s.on('notification', (n) => got.push(n)); return got; };
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));

const alert = (message: string) => ({ type: 'system.alert' as const, payload: { message }, entity: 'SystemAlert', entityId: uniq('alert'), actorId: 'usr-admin' });

describe('sockets are authenticated', () => {
  it('refuses a connection without a token, with a malformed token and with a forged one', async () => {
    await expect(open(undefined)).rejects.toThrow(/UNAUTHORIZED/);
    await expect(open({ token: 'not-a-token' })).rejects.toThrow(/UNAUTHORIZED/);
    await expect(open({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1c3ItYWRtaW4ifQ.c2lnbmF0dXJl' })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('refuses a correctly signed token whose session was revoked, or whose user was deactivated', async () => {
    const login = await t.request.post('/api/auth/login-local').send({ email: 'analyst2@gxp.com', password: 'password' });
    expect(login.status).toBe(200);
    await sql(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [login.body.session.id]);
    await expect(open({ token: login.body.token })).rejects.toThrow(/UNAUTHORIZED: session revoked/);

    const again = await t.request.post('/api/auth/login-local').send({ email: 'analyst2@gxp.com', password: 'password' });
    await sql(`UPDATE users SET active = false WHERE id = 'usr-analyst2'`);
    try {
      await expect(open({ token: again.body.token })).rejects.toThrow(/UNAUTHORIZED: user inactive/);
    } finally {
      await sql(`UPDATE users SET active = true WHERE id = 'usr-analyst2'`);
    }
  });

  it('accepts a session token and disconnects the socket once the session is revoked', async () => {
    const login = await t.request.post('/api/auth/login-local').send({ email: 'reviewer@gxp.com', password: 'password' });
    expect(login.status).toBe(200);
    const s = await open({ token: login.body.token });
    expect(s.connected).toBe(true);
    const gone = new Promise<string>(r => s.once('disconnect', (reason) => r(reason)));
    await sql(`UPDATE sessions SET revoked_at = now() WHERE user_id = 'usr-reviewer' AND revoked_at IS NULL`);
    expect(await gone).toBe('io server disconnect');
  });
});

describe('the outbox is part of the transaction', () => {
  it('a rolled-back change leaves no outbox row and sends no socket message', async () => {
    const s = await open({ token: await t.token('analyst1@gxp.com') });
    const got = received(s);
    const marker = uniq('rollback');
    await expect(tx.withTransaction(dbMod.db, async (trx, afterCommit) => {
      await ev.emitEvent(trx, alert(marker), afterCommit);
      throw new Error('the business write failed after the event was emitted');
    })).rejects.toThrow(/business write failed/);

    expect(await sql(`SELECT id FROM outbox_events WHERE payload->>'message' = $1`, [marker])).toHaveLength(0);
    await ev.dispatchOnce(dbMod.db, { io: realtime });
    await settle();
    expect(got.filter(n => n.message === marker)).toHaveLength(0);
    expect(await sql(`SELECT id FROM notifications WHERE message = $1`, [marker])).toHaveLength(0);
  });

  it('a committed change is fanned out once: one notification per active user, pushed only to that user', async () => {
    const a1 = await open({ token: await t.token('analyst1@gxp.com') });
    const a2 = await open({ token: await t.token('analyst2@gxp.com') });
    const got1 = received(a1);
    const got2 = received(a2);
    const marker = uniq('commit');
    await tx.withTransaction(dbMod.db, async (trx, afterCommit) => { await ev.emitEvent(trx, alert(marker), afterCommit); });
    const [row] = await sql(`SELECT id, type, type_version, fanned_out_at FROM outbox_events WHERE payload->>'message' = $1`, [marker]);
    expect(row).toMatchObject({ type: 'system.alert', type_version: 1, fanned_out_at: null });

    await ev.dispatchOnce(dbMod.db, { io: realtime });
    await ev.dispatchOnce(dbMod.db, { io: realtime }); // a second pass finds nothing new
    await settle();

    const rows = await sql(`SELECT user_id FROM notifications WHERE event_id = $1 ORDER BY user_id`, [row.id]);
    expect(rows.map((r: any) => r.user_id)).toEqual(['usr-admin', 'usr-analyst1', 'usr-analyst2', 'usr-qa', 'usr-reviewer']);
    expect(got1.filter(n => n.message === marker)).toHaveLength(1);
    expect(got2.filter(n => n.message === marker)).toHaveLength(1);
    expect(got1.find(n => n.message === marker)).toMatchObject({ type: 'system.alert', title: 'System alert', userId: 'usr-analyst1' });
    expect(got2.find(n => n.message === marker).userId).toBe('usr-analyst2');
    expect((await sql(`SELECT fanned_out_at FROM outbox_events WHERE id = $1`, [row.id]))[0].fanned_out_at).not.toBeNull();
  });

  it('refuses an event whose payload is not the catalog schema (no result value can be smuggled in)', async () => {
    await expect(tx.withTransaction(dbMod.db, (trx) => ev.emitEvent(trx, {
      type: 'result.oos_detected', payload: { sampleId: 'S', resultId: 'R', parameter: 'Assay', investigationId: 'OOS-1', value: '97.1' } as any,
      entity: 'Result', entityId: 'R', actorId: 'usr-analyst1',
    }))).rejects.toThrow(/does not match the catalog.*value/);
    await expect(tx.withTransaction(dbMod.db, (trx) => ev.emitEvent(trx, { type: 'no.such.event' as any, payload: {}, entity: 'X', entityId: 'x', actorId: 'usr-admin' })))
      .rejects.toThrow(/no\.such\.event/);
  });
});

describe('persistent notifications', () => {
  it('a user who was offline sees the notification at the next sign-in and marks it read', async () => {
    const marker = uniq('offline');
    await tx.withTransaction(dbMod.db, async (trx, afterCommit) => { await ev.emitEvent(trx, alert(marker), afterCommit); });
    await ev.dispatchOnce(dbMod.db, {}); // nobody connected

    const login = await t.request.post('/api/auth/login-local').send({ email: 'qa@gxp.com', password: 'password' });
    const h = { Authorization: `Bearer ${login.body.token}` };
    const list = await t.request.get('/api/notifications').set(h);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const mine = list.body.items.find((n: any) => n.message === marker);
    expect(mine).toMatchObject({ type: 'system.alert', title: 'System alert', readAt: null });
    expect(list.body.unread).toBeGreaterThanOrEqual(1);

    const read = await t.request.post(`/api/notifications/${mine.id}/read`).set(h).send({});
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.readAt).not.toBeNull();
    const again = await t.request.get('/api/notifications').set(h);
    expect(again.body.items.find((n: any) => n.id === mine.id).readAt).not.toBeNull();
    expect(again.body.unread).toBe(list.body.unread - 1);

    // another user's notification is not reachable
    const [other] = await sql(`SELECT id FROM notifications WHERE user_id = 'usr-analyst1' LIMIT 1`);
    const foreign = await t.request.post(`/api/notifications/${other.id}/read`).set(h).send({});
    expect(foreign.status).toBe(404);

    const all = await t.request.post('/api/notifications/read-all').set(h).send({});
    expect(all.status).toBe(200);
    expect((await t.request.get('/api/notifications').set(h)).body.unread).toBe(0);
  });

  it('a rolled-back OOS result produces no outbox row, no investigation and no socket message', async () => {
    const { saveResult } = await import('../../src/server/services/saveResult');
    const material = uniq('Mat');
    await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null }] as any);
    const analyst = await t.auth('analyst1@gxp.com');
    const created = await t.request.post('/api/samples').set(analyst).send({ material, batch: uniq('B') });
    const id = created.body.id;
    await receiveSample(t, id);
    expect((await t.request.post(`/api/samples/${id}/transition`).set(analyst).send({ action: 'submit', expectedVersion: 1 })).status).toBe(200);
    const [result] = await sql(`SELECT id, version FROM results WHERE sample_id = $1`, [id]);
    const qa = await open({ token: await t.token('qa@gxp.com') });
    const got = received(qa);

    await expect(tx.withTransaction(dbMod.db, async (trx, afterCommit) => {
      const saved = await saveResult({ tx: trx, afterCommit, user: { id: 'usr-analyst1', role: 'Analyst' }, sampleId: id, resultId: result.id,
        input: { value: '97.1', reason: 'routine entry', expectedVersion: result.version } });
      expect(saved.isOos).toBe(true);
      expect(await trx.execute(sqlTag`SELECT 1 FROM outbox_events WHERE entity_id = ${result.id}`).then((r: any) => r.rows)).toHaveLength(1); // written in the transaction
      throw new Error('a later step of the same transaction failed');
    })).rejects.toThrow(/later step/);

    expect(await sql(`SELECT id FROM outbox_events WHERE entity_id = $1`, [result.id])).toHaveLength(0);
    expect(await sql(`SELECT id FROM oos_investigations WHERE result_id = $1`, [result.id])).toHaveLength(0);
    await ev.dispatchOnce(dbMod.db, { io: realtime });
    await settle();
    expect(got.filter(n => n.type === 'result.oos_detected' && String(n.message).includes(id))).toHaveLength(0);
  });

  it('an OOS result entered through the route produces one result.oos_detected event without the value, for oos.view holders', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null }] as any);
    const analyst = await t.auth('analyst1@gxp.com');
    const created = await t.request.post('/api/samples').set(analyst).send({ material, batch: uniq('B') });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    await receiveSample(t, id);
    expect((await t.request.post(`/api/samples/${id}/transition`).set(analyst).send({ action: 'submit', expectedVersion: 1 })).status).toBe(200);
    const [result] = await sql(`SELECT id, version FROM results WHERE sample_id = $1`, [id]);
    const put = await t.request.put(`/api/samples/${id}/results/${result.id}`).set(analyst).send({ value: '97.1', reason: 'routine entry', expectedVersion: result.version });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.isOos).toBe(true);

    const events = await sql(`SELECT * FROM outbox_events WHERE type = 'result.oos_detected' AND entity_id = $1`, [result.id]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ sampleId: id, resultId: result.id, parameter: 'Assay', investigationId: put.body.oosInvestigationId });
    expect(JSON.stringify(events[0].payload)).not.toContain('97.1');
    expect(events[0].actor_id).toBe('usr-analyst1');
    expect(events[0].audience).toBe('oos.view');
    expect(t.io.emitted.filter(e => e.event === 'notification')).toHaveLength(0); // nothing is broadcast to every socket any more
  });
});
