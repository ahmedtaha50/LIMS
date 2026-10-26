/**
 * Roadmap M13 (r1-quality-fixes), reagent receipt and the reagent counts of the dashboard.
 *
 * Before: the receipt screen posted a password that the strict schema rejected, so every receipt answered 400; had it been accepted
 * the route never looked at it; the expiry date was any string; the dashboard counted reagents by a column that does not exist
 * (expirationDate), so "expired" and "active" were always 0.
 *
 * After: the receipt is an e-signature (RECEIPT) by Analyst, QA or Admin, a wrong password is 401 and audited, the expiry date is a
 * real date that has not passed, and the dashboard counts by expiry_date, valid through the end of that day.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const dateFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const receive = (over: Record<string, unknown> = {}, who: keyof typeof H = 'analyst1') =>
  t.request.post('/api/reagents').set(H[who]).send({ name: uniq('Methanol HPLC grade'), lotNumber: uniq('LOT'), quantity: '2.5 L', expiryDate: dateFromToday(365), password: TEST_PASSWORD, ...over });

describe('receiving a reagent', () => {
  it('from the screen\'s own payload (with the password): 200, the reagent exists, and the receipt is signed', async () => {
    const lot = uniq('LOT');
    const res = await receive({ lotNumber: lot });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ lotNumber: lot, quantity: '2.5 L', status: 'Available' });
    expect(res.body.password).toBeUndefined();
    expect(res.body.id).toMatch(/^RGT-[0-9a-f]{8}$/);

    const row = await one('SELECT * FROM reagents WHERE id = $1', [res.body.id]);
    expect(row).toMatchObject({ lot_number: lot, expiry_date: dateFromToday(365) });

    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'Reagent' AND entity_id = $1`, [res.body.id]);
    expect(sig).toMatchObject({ meaning_code: 'RECEIPT', signer_id: 'usr-analyst1', signer_name: 'Test Analyst One', hash_version: 2 });
    expect(sig.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await one('SELECT * FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(audit).toMatchObject({ action: 'Create', entity: 'Reagent', entity_id: res.body.id, user_id: 'usr-analyst1' });
    expect(JSON.stringify(audit)).not.toContain(TEST_PASSWORD);
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true, status: 'valid' });
  });

  it('a wrong password returns 401, is audited (SignatureFailed), and no reagent is created', async () => {
    const lot = uniq('LOT-WRONG');
    const res = await receive({ lotNumber: lot, password: 'wrong-password' }, 'analyst2');
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect((await one('SELECT count(*)::int AS n FROM reagents WHERE lot_number = $1', [lot])).n).toBe(0);
    const failed = await sql(`SELECT * FROM audit_trail WHERE action = 'SignatureFailed' AND entity = 'Reagent' AND user_id = 'usr-analyst2'`);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst2'`)).failed_attempts).toBeGreaterThanOrEqual(1);
    expect((await receive({}, 'analyst2')).status).toBe(200); // a good signature clears the count
  });

  it('a request without a password is 400', async () => {
    const lot = uniq('LOT-NOPW');
    const { password, ...body } = { name: 'N', lotNumber: lot, quantity: '1 L', expiryDate: dateFromToday(30), password: 'x' };
    const res = await t.request.post('/api/reagents').set(H.analyst1).send(body);
    expect(res.status).toBe(400);
    expect((await one('SELECT count(*)::int AS n FROM reagents WHERE lot_number = $1', [lot])).n).toBe(0);
  });

  it('a Reviewer may not receive material (the RECEIPT meaning is for Analyst, QA and Admin): 403; QA and Admin may', async () => {
    const lot = uniq('LOT-ROLE');
    expect((await receive({ lotNumber: lot }, 'reviewer')).status).toBe(403);
    expect((await one('SELECT count(*)::int AS n FROM reagents WHERE lot_number = $1', [lot])).n).toBe(0);
    expect((await receive({}, 'qa')).status).toBe(200);
    expect((await receive({}, 'admin')).status).toBe(200);
  });

  it('the expiry date must be a real date that has not passed (today is still valid); the other fields are bounded text', async () => {
    for (const expiryDate of ['next year', '2030-02-30', '2030-13-01', dateFromToday(-1), '', 20300101 as any]) {
      const res = await receive({ expiryDate });
      expect(res.status, `${String(expiryDate)}: ${JSON.stringify(res.body)}`).toBe(400);
    }
    expect((await receive({ expiryDate: dateFromToday(0) })).status).toBe(200);
    expect((await receive({ name: '' })).status).toBe(400);
    expect((await receive({ lotNumber: 'x'.repeat(201) })).status).toBe(400);
    expect((await receive({ quantity: { a: 1 } })).status).toBe(400);
  });

  it('server-controlled fields are refused, not ignored: status, id, receivedBy', async () => {
    for (const extra of [{ status: 'Quarantined' }, { id: 'RGT-forged' }, { receivedBy: 'usr-qa' }]) {
      const res = await receive(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('the reagent counts on the dashboard', () => {
  it('count by expiry_date: expired is before today, active is today or later', async () => {
    const insert = (id: string, expiry: string) => sql(`INSERT INTO reagents (id, name, lot_number, expiry_date, status, quantity) VALUES ($1, 'R', $1, $2, 'Available', '1 L')`, [id, expiry]);
    await insert(uniq('RGT-EXP1'), dateFromToday(-30));
    await insert(uniq('RGT-EXP2'), dateFromToday(-1));
    await insert(uniq('RGT-ACT1'), dateFromToday(0)); // valid through the end of today
    await insert(uniq('RGT-ACT2'), dateFromToday(400));
    const total = (await one('SELECT count(*)::int AS n FROM reagents')).n;
    const res = await t.request.get('/api/dashboard').set(H.analyst1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const expired = (await one(`SELECT count(*)::int AS n FROM reagents WHERE expiry_date < $1`, [dateFromToday(0)])).n;
    expect(expired).toBeGreaterThanOrEqual(2);
    expect(res.body.reagentsExpired).toBe(expired);
    expect(res.body.reagentsActive).toBe(total - expired);
    expect(res.body.reagentsActive).toBeGreaterThanOrEqual(2);
  });
});
