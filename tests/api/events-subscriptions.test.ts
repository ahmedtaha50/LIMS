/**
 * Roadmap M23 (r2-events): outbound subscriptions.
 *
 *   - creating, disabling and re-enabling a subscription is an Administrator's e-signature (ADMIN_AUTHORISATION, record type
 *     EventSubscription, bound to the version) with its audit entry; the webhook secret is shown once and stored encrypted;
 *   - a webhook that answers 500 three times and then 200 receives the event once with a valid HMAC, after 4 attempts;
 *   - a webhook that never succeeds ends as a dead letter after the first try and 5 retries; an Administrator can requeue it;
 *   - the SSRF guard: 169.254.169.254 is refused even when the allow-list would admit it, a destination outside the LAN allow-list
 *     is refused, at creation and again at delivery time (DNS rebinding), and a redirect is not followed;
 *   - the e-mail sink speaks SMTP to the configured relay; the file sink drops one complete file per event (atomic rename).
 */
import fs from 'fs';
import { createServer, type IncomingMessage, type Server } from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

const DROP = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-events-drop-'));
process.env.EVENTS_WEBHOOK_ALLOWLIST = '127.0.0.1/32';
process.env.EVENTS_DROP_DIR = DROP;

let t: TestApp;
let ev: typeof import('../../src/server/events');
let dbMod: typeof import('../../src/db/index');
let tx: typeof import('../../src/server/core/tx');
let H: Record<string, { Authorization: string }> = {};
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

/** A webhook receiver: answers with the next status of `script` (the last one repeats) and records every request. */
interface Receiver { url: string; hits: Array<{ headers: IncomingMessage['headers']; body: string }>; script: number[]; server: Server }
async function receiver(script: number[], extraHeaders: Record<string, string> = {}): Promise<Receiver> {
  const r: Receiver = { url: '', hits: [], script, server: undefined as any };
  r.server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      r.hits.push({ headers: req.headers, body });
      const status = r.script[Math.min(r.hits.length - 1, r.script.length - 1)];
      res.writeHead(status, extraHeaders); res.end('ok');
    });
  });
  await new Promise<void>(ok => r.server.listen(0, '127.0.0.1', () => ok()));
  r.url = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/hooks/lims`;
  return r;
}
const servers: Server[] = [];

beforeAll(async () => {
  t = await startTestApp();
  ev = await import('../../src/server/events');
  dbMod = await import('../../src/db/index');
  tx = await import('../../src/server/core/tx');
  for (const u of ['admin', 'qa', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
afterAll(() => { for (const s of servers) s.close(); fs.rmSync(DROP, { recursive: true, force: true }); });

const signed = { password: 'password', reason: 'Connect the ERP to quality events' };
const create = (body: Record<string, unknown>, who = 'admin') => t.request.post('/api/event-subscriptions').set(H[who]).send({ ...signed, ...body });
const fast = { backoffSeconds: () => 0 };
const emitAlert = (message: string) => tx.withTransaction(dbMod.db, (trx, afterCommit) =>
  ev.emitEvent(trx, { type: 'system.alert', payload: { message }, entity: 'SystemAlert', entityId: uniq('alert'), actorId: 'usr-admin' }, afterCommit));
async function drain(times: number, opts: Record<string, unknown> = {}) { for (let i = 0; i < times; i++) await ev.dispatchOnce(dbMod.db, { ...fast, ...opts }); }

describe('subscriptions are e-signed and audited', () => {
  it('an Administrator creates a webhook: signature bound to version 1, audit entry, secret shown once and stored encrypted', async () => {
    const r = await receiver([200]); servers.push(r.server);
    const res = await create({ name: uniq('ERP hook'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    const sub = res.body.subscription;
    expect(sub).toMatchObject({ sink: 'webhook', target: r.url, eventTypes: ['system.alert'], status: 'Active', version: 1, createdBy: 'usr-admin' });
    expect(sub.secret).toBeUndefined();
    expect(sub.secretEnc).toBeUndefined();

    const [row] = await sql(`SELECT secret_enc FROM event_subscriptions WHERE id = $1`, [sub.id]);
    expect(row.secret_enc).toMatch(/^v\d+:/);
    expect(row.secret_enc).not.toContain(res.body.secret);
    const sigs = await sql(`SELECT meaning_code, record_version, signer_id FROM signatures WHERE entity_type = 'EventSubscription' AND entity_id = $1`, [sub.id]);
    expect(sigs).toEqual([{ meaning_code: 'ADMIN_AUTHORISATION', record_version: 1, signer_id: 'usr-admin' }]);
    expect(await sql(`SELECT action FROM audit_trail WHERE entity = 'EventSubscription' AND entity_id = $1`, [sub.id])).toEqual([{ action: 'Create' }]);

    const list = await t.request.get('/api/event-subscriptions').set(H.admin);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    expect(list.body.catalog.map((c: any) => c.type)).toEqual(expect.arrayContaining(['result.oos_detected', 'batch.released', 'instrument.calibration_due', 'system.alert']));
  });

  it('refuses a non-Administrator, a wrong password, an unknown event type and server-controlled fields', async () => {
    const r = await receiver([200]); servers.push(r.server);
    const base = { name: uniq('hook'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] };
    expect((await create(base, 'qa')).status).toBe(403);
    const before = (await sql(`SELECT count(*)::int AS n FROM event_subscriptions`))[0].n;
    expect((await create({ ...base, password: 'wrong-password' })).status).toBe(401);
    expect((await create({ ...base, eventTypes: ['sample.deleted'] })).status).toBe(400);
    expect((await create({ ...base, status: 'Active' })).status).toBe(400);
    expect((await create({ ...base, version: 7 })).status).toBe(400);
    expect((await sql(`SELECT count(*)::int AS n FROM event_subscriptions`))[0].n).toBe(before);
  });

  it('disabling is signed with the version; a stale version is 409; a disabled subscription receives nothing', async () => {
    const r = await receiver([200]); servers.push(r.server);
    const sub = (await create({ name: uniq('to disable'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] })).body.subscription;
    const off = await t.request.post(`/api/event-subscriptions/${sub.id}/status`).set(H.admin).send({ ...signed, status: 'Disabled', expectedVersion: 1 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ status: 'Disabled', version: 2 });
    const stale = await t.request.post(`/api/event-subscriptions/${sub.id}/status`).set(H.admin).send({ ...signed, status: 'Active', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await sql(`SELECT record_version FROM signatures WHERE entity_type = 'EventSubscription' AND entity_id = $1 ORDER BY timestamp`, [sub.id])).map((s: any) => s.record_version)).toEqual([1, 2]);

    await emitAlert(uniq('while disabled'));
    await drain(2);
    expect(r.hits).toHaveLength(0);
    expect(await sql(`SELECT id FROM event_deliveries WHERE subscription_id = $1`, [sub.id])).toHaveLength(0);
  });
});

describe('webhook delivery', () => {
  it('500, 500, 500, then 200: the event arrives once with a valid HMAC after 4 attempts', async () => {
    const r = await receiver([500, 500, 500, 200]); servers.push(r.server);
    const created = await create({ name: uniq('flaky'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] });
    const sub = created.body.subscription;
    const marker = uniq('flaky alert');
    const eventId = await emitAlert(marker);
    await drain(8);

    expect(r.hits).toHaveLength(4);
    const ok = r.hits[3];
    const body = JSON.parse(ok.body);
    expect(body).toMatchObject({ id: eventId, type: 'system.alert', version: 1, data: { message: marker } });
    expect(ok.headers['x-lims-event-id']).toBe(eventId);
    expect(ev.verifyWebhookSignature(created.body.secret, String(ok.headers['x-lims-signature']), ok.body)).toBe(true);
    expect(ev.verifyWebhookSignature('whsec_wrong', String(ok.headers['x-lims-signature']), ok.body)).toBe(false);
    expect(ev.verifyWebhookSignature(created.body.secret, String(ok.headers['x-lims-signature']), ok.body.replace(marker, 'tampered'))).toBe(false);
    for (const h of r.hits) expect(h.headers['x-lims-event-id']).toBe(eventId); // the same event every time: the receiver can deduplicate

    const [d] = await sql(`SELECT status, attempts, last_status_code, delivered_at FROM event_deliveries WHERE subscription_id = $1`, [sub.id]);
    expect(d).toMatchObject({ status: 'delivered', attempts: 4, last_status_code: 200 });
    expect(d.delivered_at).not.toBeNull();
  });

  it('a receiver that never succeeds ends as a dead letter after 6 attempts; an Administrator requeues it (audited)', async () => {
    const r = await receiver([500]); servers.push(r.server);
    const sub = (await create({ name: uniq('down'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] })).body.subscription;
    await emitAlert(uniq('never'));
    await drain(10);
    expect(r.hits).toHaveLength(6);
    const dead = await t.request.get(`/api/event-subscriptions/${sub.id}/deliveries?status=dead`).set(H.admin);
    expect(dead.status, JSON.stringify(dead.body)).toBe(200);
    expect(dead.body.deliveries).toHaveLength(1);
    expect(dead.body.deliveries[0]).toMatchObject({ status: 'dead', attempts: 6, lastStatusCode: 500 });

    r.script = [200];
    const d = dead.body.deliveries[0];
    expect((await t.request.post(`/api/event-deliveries/${d.id}/retry`).set(H.qa).send({ reason: 'receiver repaired', expectedVersion: d.version })).status).toBe(403);
    const retry = await t.request.post(`/api/event-deliveries/${d.id}/retry`).set(H.admin).send({ reason: 'receiver repaired', expectedVersion: d.version });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect((await t.request.post(`/api/event-deliveries/${d.id}/retry`).set(H.admin).send({ reason: 'again', expectedVersion: d.version })).status).toBe(409);
    expect(await sql(`SELECT action, reason FROM audit_trail WHERE entity = 'EventDelivery' AND entity_id = $1`, [d.id])).toEqual([{ action: 'Requeue', reason: 'receiver repaired' }]);
    await drain(2);
    expect(r.hits).toHaveLength(7);
    expect((await sql(`SELECT status FROM event_deliveries WHERE id = $1`, [d.id]))[0].status).toBe('delivered');
  });

  it('a redirect is not followed and counts as a failed attempt', async () => {
    const target = await receiver([200]); servers.push(target.server);
    const r = await receiver([302], { Location: target.url }); servers.push(r.server);
    const sub = (await create({ name: uniq('redirect'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] })).body.subscription;
    await emitAlert(uniq('redirected'));
    await drain(1);
    expect(r.hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
    expect((await sql(`SELECT status, last_status_code FROM event_deliveries WHERE subscription_id = $1`, [sub.id]))[0]).toMatchObject({ status: 'pending', last_status_code: 302 });
  });
});

describe('the SSRF guard', () => {
  it('refuses 169.254.169.254 at creation, even when the allow-list would admit it', async () => {
    process.env.EVENTS_WEBHOOK_ALLOWLIST = '0.0.0.0/0';
    try {
      const res = await create({ name: uniq('metadata'), sink: 'webhook', target: 'http://169.254.169.254/latest/meta-data/', eventTypes: ['system.alert'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('169.254.169.254');
    } finally { process.env.EVENTS_WEBHOOK_ALLOWLIST = '127.0.0.1/32'; }
  });

  it('refuses a destination outside the LAN allow-list, credentials in the URL, and other schemes', async () => {
    for (const target of ['http://10.20.30.40/hook', 'http://user:secret@127.0.0.1:9/hook', 'ftp://127.0.0.1/hook', 'file:///etc/passwd']) {
      const res = await create({ name: uniq('bad'), sink: 'webhook', target, eventTypes: ['system.alert'] });
      expect(res.status, target).toBe(400);
    }
  });

  it('checks again at delivery time: an address no longer allowed is not contacted', async () => {
    const r = await receiver([200]); servers.push(r.server);
    const sub = (await create({ name: uniq('rebind'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] })).body.subscription;
    await emitAlert(uniq('rebind'));
    await drain(1, { allowList: [] });
    expect(r.hits).toHaveLength(0);
    const [d] = await sql(`SELECT status, attempts, last_error FROM event_deliveries WHERE subscription_id = $1`, [sub.id]);
    expect(d.status).toBe('pending');
    expect(d.last_error).toMatch(/allow-list/);
  });
});

describe('e-mail and file sinks', () => {
  it('the file sink drops one complete JSON file per event, by atomic rename, and refuses a path outside the drop directory', async () => {
    expect((await create({ name: uniq('escape'), sink: 'file', target: '../outside', eventTypes: ['system.alert'] })).status).toBe(400);
    const folder = `erp-${process.pid}`;
    const sub = (await create({ name: uniq('erp drop'), sink: 'file', target: folder, eventTypes: ['system.alert'] })).body.subscription;
    expect(sub.sink).toBe('file');
    const marker = uniq('to erp');
    const eventId = await emitAlert(marker);
    await drain(1);
    const files = fs.readdirSync(path.join(DROP, folder));
    expect(files).toEqual([`${eventId}.json`]);
    expect(JSON.parse(fs.readFileSync(path.join(DROP, folder, files[0]), 'utf8'))).toMatchObject({ id: eventId, type: 'system.alert', data: { message: marker } });
  });

  it('the e-mail sink sends the notification text through the SMTP relay, and is refused when no relay is configured', async () => {
    const r = await receiver([200]); servers.push(r.server);
    void r;
    delete process.env.EVENTS_SMTP_HOST;
    expect((await create({ name: uniq('mail'), sink: 'email', target: 'qa-team@example.invalid', eventTypes: ['system.alert'] })).status).toBe(400);

    const lines: string[] = [];
    const smtp = net.createServer(sock => {
      let inData = false;
      sock.write('220 test ESMTP\r\n');
      let buf = '';
      sock.on('data', chunk => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          lines.push(line);
          if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } continue; }
          if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 OK\r\n');
          else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>(ok => smtp.listen(0, '127.0.0.1', () => ok()));
    try {
      process.env.EVENTS_SMTP_HOST = '127.0.0.1';
      process.env.EVENTS_SMTP_PORT = String((smtp.address() as AddressInfo).port);
      process.env.EVENTS_SMTP_FROM = 'lims@example.invalid';
      process.env.EVENTS_SMTP_SECURITY = 'none';
      const sub = (await create({ name: uniq('mail ok'), sink: 'email', target: 'qa-team@example.invalid', eventTypes: ['system.alert'] })).body.subscription;
      const marker = uniq('mail alert');
      await emitAlert(marker);
      await drain(1);
      expect(lines).toContain('MAIL FROM:<lims@example.invalid>');
      expect(lines).toContain('RCPT TO:<qa-team@example.invalid>');
      expect(lines.some(l => l.includes(marker))).toBe(true);
      expect(lines.some(l => /^Subject: .*System alert/.test(l))).toBe(true);
      expect((await sql(`SELECT status FROM event_deliveries WHERE subscription_id = $1`, [sub.id]))[0].status).toBe('delivered');
    } finally {
      smtp.close();
      for (const k of ['EVENTS_SMTP_HOST', 'EVENTS_SMTP_PORT', 'EVENTS_SMTP_FROM', 'EVENTS_SMTP_SECURITY']) delete process.env[k];
    }
  });
});

describe('key rotation', () => {
  it('moves the webhook secrets to the new key generation, and deliveries still carry a valid HMAC', async () => {
    const { createKeystore, setKeystore } = await import('../../src/server/crypto/keystore');
    const { rotateStoredSecrets } = await import('../../src/server/crypto/rotate');
    const r = await receiver([200]); servers.push(r.server);
    const created = await create({ name: uniq('rotated'), sink: 'webhook', target: r.url, eventTypes: ['system.alert'] });
    const sub = created.body.subscription;
    expect((await sql(`SELECT secret_enc FROM event_subscriptions WHERE id = $1`, [sub.id]))[0].secret_enc).toMatch(/^v1:/);

    const gen2 = createKeystore({ current: 2, keys: { 1: process.env.JWT_SECRET!, 2: 'k'.repeat(40) } });
    setKeystore(gen2);
    try {
      const report = await rotateStoredSecrets(dbMod.db, { actor: 'cli:tester', reason: 'Scheduled key rotation', keystore: gen2 });
      expect(report.webhookSecrets).toBeGreaterThanOrEqual(1);
      expect((await sql(`SELECT secret_enc FROM event_subscriptions WHERE id = $1`, [sub.id]))[0].secret_enc).toMatch(/^v2:/);
      expect((await sql(`SELECT count(*)::int AS n FROM event_subscriptions WHERE secret_enc NOT LIKE 'v2:%'`))[0].n).toBe(0);
      expect((await rotateStoredSecrets(dbMod.db, { actor: 'cli:tester', reason: 'Second run', keystore: gen2 })).webhookSecrets).toBe(0);

      const marker = uniq('after rotation');
      await emitAlert(marker);
      await drain(1);
      const hit = r.hits.find(h => h.body.includes(marker))!;
      expect(hit).toBeDefined();
      expect(ev.verifyWebhookSignature(created.body.secret, String(hit.headers['x-lims-signature']), hit.body)).toBe(true);
    } finally {
      setKeystore(null);
    }
  });
});
