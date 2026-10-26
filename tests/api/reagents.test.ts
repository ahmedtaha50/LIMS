/**
 * Roadmap M30 (r2-reagents): the reagent, reference-standard and solution lifecycle with the usage-to-result link.
 *
 *   receipt     a lot of an item is received with the receiver's e-signature (RECEIPT) into Quarantine; its first ledger row is the
 *               quantity received
 *   release     a second person releases it (REAGENT_LOT_RELEASE): never the receiver (403 SOD_VIOLATION, no attempt counted)
 *   opening     sets in_use_expiry = min(expiry, opening day + in-use shelf life)
 *   solutions   cannot expire after any parent (application 400 naming the parent and its date; trigger for any other writer)
 *   ledger      append-only, never negative, each row continuing the balance (triggers)
 *   link        a result lists the lots it was measured with; an expired, quarantined, rejected or retest-overdue lot is refused with
 *               400 naming the lot and the date, at link time and at every later save of the result (result guard reagent-lots)
 *   traceback   from a lot to every result, directly or through solutions made from it
 *   schedule    reagents.expiry flips Expired and announces 30 and 7 days before, once each
 *
 * Needs the gate patch (docs/changes/r2-reagents.gate.patch): the routes, the route table, the guard, lotIds on the result save, the
 * permissions, the schedule and the event type.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = day(0);

async function item(over: Record<string, unknown> = {}) {
  const res = await t.request.post('/api/reagent-items').set(H.qa).send({ code: uniq('MEOH'), name: 'Methanol HPLC', category: 'Solvent', unit: 'mL', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; code: string; unit: string };
}
const receive = (itemId: string, over: Record<string, unknown> = {}, who = 'analyst1') =>
  t.request.post('/api/reagent-lots').set(H[who]).send({ itemId, lotNumber: uniq('M'), supplier: 'Merck', quantity: 1000, expiryDate: day(365), password: TEST_PASSWORD, ...over });
const lotRow = (id: string) => one('SELECT * FROM reagent_lots WHERE id = $1', [id]);
const ledger = (id: string) => sql('SELECT tx_type, qty_delta::float AS delta, balance_after::float AS balance, result_id, into_solution_id FROM reagent_transactions WHERE lot_id = $1 OR solution_id = $1 ORDER BY seq', [id]);
const release = async (lotId: string, who = 'qa') => t.request.post(`/api/reagent-lots/${lotId}/release`).set(H[who]).send({ expectedVersion: (await lotRow(lotId)).version, password: TEST_PASSWORD });
const open = async (lotId: string, who = 'analyst1') => t.request.post(`/api/reagent-lots/${lotId}/open`).set(H[who]).send({ expectedVersion: (await lotRow(lotId)).version });

/** A lot received, released by QA and opened: ready for use. */
async function usableLot(over: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}) {
  const it = await item(itemOver);
  const r = await receive(it.id, over);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await release(r.body.lot.id)).status).toBe(200);
  const o = await open(r.body.lot.id);
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  return o.body as { id: string; inUseExpiry: string; unit: string };
}

/** A lot written straight into the table (dates in the past are what the API rightly refuses to receive). */
async function lotInDb(status: string, dates: { expiry: string; inUse?: string | null; retest?: string | null }, receivedBy = 'usr-analyst2') {
  const it = await item();
  const id = uniq('RL-T');
  await sql(`INSERT INTO reagent_lots (id, item_id, lot_number, supplier, received_quantity, unit, expiry_date, in_use_expiry, retest_date, status, received_by, received_at, opened_at, closed_at)
             VALUES ($1, $2, $3, 'Sigma', 100, 'mL', $4, $5, $6, $7, $8, '2026-01-05T09:00:00Z', CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, CASE WHEN $7 IN ('Rejected','Consumed','Disposed','Expired') THEN '2026-02-01T09:00:00Z'::timestamptz END)`,
    [id, it.id, uniq('L'), dates.expiry, dates.inUse ?? null, dates.retest ?? null, status, receivedBy]);
  const seq = (await one(`INSERT INTO counters (key, value) VALUES ('reagent_tx', 1) ON CONFLICT (key) DO UPDATE SET value = counters.value + 1 RETURNING value`)).value;
  await sql(`INSERT INTO reagent_transactions (id, seq, lot_id, tx_type, qty_delta, balance_after, unit, reason, performed_by) VALUES ($1, $2, $3, 'Receipt', 100, 100, 'mL', 'test receipt', $4)`,
    [`RTX-${String(seq).padStart(9, '0')}`, Number(seq), id, receivedBy]);
  return id;
}

async function sampleInTesting() {
  const s = await registerSample(t);
  const sub = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: s.version });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const result = await one('SELECT id, version FROM results WHERE sample_id = $1 ORDER BY id LIMIT 1', [s.id]);
  return { id: s.id, resultId: result.id as string, resultVersion: result.version as number };
}
const link = (sampleId: string, resultId: string, body: Record<string, unknown>, who = 'analyst1') =>
  t.request.post(`/api/samples/${sampleId}/results/${resultId}/materials`).set(H[who]).send(body);
const saveResult = async (s: { id: string; resultId: string }, value: string, extra: Record<string, unknown> = {}) => {
  const v = (await one('SELECT version FROM results WHERE id = $1', [s.resultId])).version;
  return t.request.put(`/api/samples/${s.id}/results/${s.resultId}`).set(H.analyst1).send({ value, reason: 'Initial entry from worksheet', expectedVersion: v, ...extra });
};

describe('receipt into quarantine (e-signed)', () => {
  it('a received lot is in Quarantine, its receipt is signed (RECEIPT) and the ledger starts with the quantity received', async () => {
    const it = await item();
    const res = await receive(it.id, { lotNumber: 'M-4471', coaReference: 'CoA 4471/26', retestDate: day(180) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lot = res.body.lot;
    expect(lot.id).toMatch(/^RL-\d{6}$/);
    expect(lot).toMatchObject({ status: 'Quarantine', lotNumber: 'M-4471', unit: 'mL', receivedBy: 'usr-analyst1', balance: 1000, usable: false });
    expect(lot.blockedReason).toMatch(new RegExp(`${lot.id}.*Quarantine \\(received ${TODAY}\\)`));
    expect(res.body.signature).toMatchObject({ meaningCode: 'RECEIPT', signerId: 'usr-analyst1', entityType: 'ReagentLot', entityId: lot.id, recordVersion: 1 });
    expect((await t.request.get(`/api/signatures/verify/${res.body.signature.id}`).set(H.qa)).body).toMatchObject({ valid: true });
    expect(await ledger(lot.id)).toEqual([{ tx_type: 'Receipt', delta: 1000, balance: 1000, result_id: null, into_solution_id: null }]);
    const audit = await sql(`SELECT action FROM audit_trail WHERE entity = 'ReagentLot' AND entity_id = $1 ORDER BY sequence`, [lot.id]);
    expect(audit.map(a => a.action)).toEqual(['Receive']);
    expect(JSON.stringify(await sql(`SELECT * FROM audit_trail WHERE entity_id = $1`, [lot.id]))).not.toContain(TEST_PASSWORD);
  });

  it('a wrong password is 401 and nothing is received; a Reviewer cannot receive (RECEIPT is for Analyst, QA, Admin)', async () => {
    const it = await item();
    const lotNumber = uniq('WRONG');
    expect((await receive(it.id, { lotNumber, password: 'not-the-password' }, 'analyst2')).status).toBe(401);
    expect((await one('SELECT count(*)::int AS n FROM reagent_lots WHERE lot_number = $1', [lotNumber])).n).toBe(0);
    expect((await receive(it.id, { lotNumber }, 'reviewer')).status).toBe(403);
    expect((await one('SELECT count(*)::int AS n FROM reagent_lots WHERE lot_number = $1', [lotNumber])).n).toBe(0);
  });

  it('refuses an expired lot, a retest date after expiry, a reference standard without potency, a potency without its basis and server-controlled fields', async () => {
    const it = await item();
    expect((await receive(it.id, { expiryDate: day(-1) })).status).toBe(400);
    expect((await receive(it.id, { retestDate: day(400), expiryDate: day(300) })).status).toBe(400);
    expect((await receive(it.id, { potency: 99.6 })).status).toBe(400);
    const std = await item({ code: uniq('USP-STD'), name: 'Paracetamol RS', category: 'ReferenceStandard', unit: 'mg' });
    const noPotency = await receive(std.id);
    expect(noPotency.status).toBe(400);
    expect(noPotency.body.error).toMatch(/potency/i);
    const ok = await receive(std.id, { potency: 99.8, potencyBasis: 'Dried basis' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lot).toMatchObject({ potency: 99.8, potencyBasis: 'Dried basis', unit: 'mg' });
    for (const extra of [{ status: 'Approved' }, { id: 'RL-999999' }, { receivedBy: 'usr-qa' }, { unit: 'L' }, { version: 3 }]) {
      expect((await receive(it.id, extra)).status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('release from quarantine by a second person (e-signed)', () => {
  it('the receiver cannot release the lot (403 SOD_VIOLATION, no attempt counted); QA releases it with REAGENT_LOT_RELEASE', async () => {
    const it = await item();
    const lot = (await receive(it.id, {}, 'admin')).body.lot;
    const before = (await one(`SELECT failed_attempts FROM users WHERE id = 'usr-admin'`)).failed_attempts;
    const self = await release(lot.id, 'admin');
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SOD_VIOLATION');
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-admin'`)).failed_attempts).toBe(before);
    expect((await lotRow(lot.id)).status).toBe('Quarantine');

    expect((await release(lot.id, 'analyst2')).status).toBe(403); // no reagent.approve
    const stale = await t.request.post(`/api/reagent-lots/${lot.id}/release`).set(H.qa).send({ expectedVersion: 7, password: TEST_PASSWORD });
    expect(stale.status).toBe(409);

    const ok = await release(lot.id, 'qa');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lot).toMatchObject({ status: 'Approved', releasedBy: 'usr-qa', version: 2 });
    expect(ok.body.signature).toMatchObject({ meaningCode: 'REAGENT_LOT_RELEASE', signerId: 'usr-qa', recordVersion: 2 });
    expect((await t.request.get(`/api/signatures/verify/${ok.body.signature.id}`).set(H.qa)).body).toMatchObject({ valid: true });
    expect((await release(lot.id, 'qa')).status).toBe(409); // already released
  });

  it('a rejection needs a reason; a rejected lot is final', async () => {
    const it = await item();
    const lot = (await receive(it.id)).body.lot;
    const noReason = await t.request.post(`/api/reagent-lots/${lot.id}/reject`).set(H.qa).send({ expectedVersion: 1, password: TEST_PASSWORD });
    expect(noReason.status).toBe(400);
    const res = await t.request.post(`/api/reagent-lots/${lot.id}/reject`).set(H.qa).send({ expectedVersion: 1, password: TEST_PASSWORD, reason: 'Seal broken on arrival' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lot.status).toBe('Rejected');
    expect(res.body.signature.meaningCode).toBe('REAGENT_LOT_REJECTION');
    expect((await release(lot.id)).status).toBe(423);
    expect((await open(lot.id)).status).toBe(423);
  });
});

describe('opening a lot sets in_use_expiry (acceptance 2)', () => {
  it('in_use_expiry = opening day + in-use shelf life, never after the expiry date; no shelf life means the expiry date', async () => {
    const a = await usableLot({ expiryDate: day(365) }, { inUseShelfLifeDays: 30 });
    expect(a.inUseExpiry).toBe(day(30));
    expect((await lotRow(a.id))).toMatchObject({ status: 'InUse', in_use_expiry: day(30), opened_by: 'usr-analyst1' });
    const b = await usableLot({ expiryDate: day(10) }, { inUseShelfLifeDays: 30 });
    expect(b.inUseExpiry).toBe(day(10));
    const c = await usableLot({ expiryDate: day(200) });
    expect(c.inUseExpiry).toBe(day(200));
    const audit = await one(`SELECT action, reason FROM audit_trail WHERE entity = 'ReagentLot' AND entity_id = $1 AND action = 'Open'`, [a.id]);
    expect(audit.reason).toContain(`in use until ${day(30)}`);
  });

  it('a lot in Quarantine cannot be opened (409); an opened lot is not opened again', async () => {
    const it = await item();
    const lot = (await receive(it.id)).body.lot;
    expect((await open(lot.id)).status).toBe(409);
    const used = await usableLot();
    expect((await open(used.id)).status).toBe(409);
  });
});

describe('prepared solutions cannot outlive their parent (acceptance 2)', () => {
  const prepare = (components: Array<{ materialId: string; quantity: number }>, expiryDate: string, who = 'analyst1') =>
    t.request.post('/api/prepared-solutions').set(H[who]).send({ name: 'Mobile phase A', concentration: '0.1 % TFA', preparation: 'SOP-HPLC-004 step 3', quantity: 500, unit: 'mL', expiryDate, components });

  it('an expiry after the parent lot\'s in-use expiry is 400 naming the lot and its date; nothing is written', async () => {
    const lot = await usableLot({ expiryDate: day(365) }, { inUseShelfLifeDays: 20 });
    const before = await ledger(lot.id);
    const res = await prepare([{ materialId: lot.id, quantity: 50 }], day(21));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(lot.id);
    expect(res.body.error).toContain(day(20));
    expect(await ledger(lot.id)).toEqual(before);
    expect((await one(`SELECT count(*)::int AS n FROM prepared_solutions WHERE expiry_date = $1 AND name = 'Mobile phase A'`, [day(21)])).n).toBe(0);
  });

  it('within the parent\'s limit: the solution exists, the parent is consumed into it, and the ledger shows both sides', async () => {
    const lot = await usableLot({ expiryDate: day(365) }, { inUseShelfLifeDays: 20 });
    const res = await prepare([{ materialId: lot.id, quantity: 50 }], day(20));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sol = res.body;
    expect(sol.id).toMatch(/^PS-\d{6}$/);
    expect(sol).toMatchObject({ status: 'Active', balance: 500, usable: true, expiryDate: day(20) });
    expect(await ledger(lot.id)).toEqual([
      { tx_type: 'Receipt', delta: 1000, balance: 1000, result_id: null, into_solution_id: null },
      { tx_type: 'Consumed', delta: -50, balance: 950, result_id: null, into_solution_id: sol.id },
    ]);
    expect(await ledger(sol.id)).toEqual([{ tx_type: 'Prepared', delta: 500, balance: 500, result_id: null, into_solution_id: null }]);
    const detail = await t.request.get(`/api/prepared-solutions/${sol.id}`).set(H.analyst1);
    expect(detail.body.components).toEqual([expect.objectContaining({ materialId: lot.id, quantity: 50, unit: 'mL' })]);

    // A dilution of that solution cannot outlive it either.
    const child = await prepare([{ materialId: sol.id, quantity: 10 }], day(21));
    expect(child.status).toBe(400);
    expect(child.body.error).toContain(sol.id);
    expect((await prepare([{ materialId: sol.id, quantity: 10 }], day(15))).status).toBe(200);
  });

  it('a component that is not usable (quarantined) is refused naming it; a parent cannot give more than it holds', async () => {
    const q = await lotInDb('Quarantine', { expiry: day(100) });
    const res = await prepare([{ materialId: q, quantity: 1 }], day(5));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(`${q}.*Quarantine \\(received 2026-01-05\\)`));
    const lot = await usableLot();
    const tooMuch = await prepare([{ materialId: lot.id, quantity: 1001 }], day(5));
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/has 1000 mL left/);
  });

  it('the database refuses a component whose solution outlives the lot, whoever writes it', async () => {
    const lot = await usableLot({ expiryDate: day(365) }, { inUseShelfLifeDays: 5 });
    const sol = (await prepare([{ materialId: lot.id, quantity: 1 }], day(5))).body;
    const tx = (await one(`SELECT id FROM reagent_transactions WHERE into_solution_id = $1`, [sol.id])).id;
    await sql(`INSERT INTO prepared_solutions (id, name, preparation, quantity, unit, expiry_date, prepared_by) VALUES ('PS-T-LONG', 'x', 'x', 1, 'mL', $1, 'usr-analyst1')`, [day(30)]);
    await expect(sql(`INSERT INTO prepared_solution_components (id, solution_id, lot_id, quantity, unit, transaction_id) VALUES ('PSC-T', 'PS-T-LONG', $1, 1, 'mL', $2)`, [lot.id, tx]))
      .rejects.toThrow(/cannot outlive/);
  });
});

describe('the usage-to-result link and the expiry block (acceptance 1)', () => {
  it('linking an expired lot, a quarantined lot or a retest-overdue lot is 400 naming the lot and the date; nothing is written', async () => {
    const s = await sampleInTesting();
    const expired = await lotInDb('InUse', { expiry: day(-3), inUse: day(-3) });
    const quarantined = await lotInDb('Quarantine', { expiry: day(100) });
    const retest = await lotInDb('InUse', { expiry: day(100), inUse: day(100), retest: day(-1) });
    const inUseOver = await lotInDb('InUse', { expiry: day(100), inUse: day(-2) });
    for (const [lotId, text] of [[expired, `expired on ${day(-3)}`], [quarantined, 'Quarantine (received 2026-01-05)'], [retest, `retest date ${day(-1)}`], [inUseOver, `in-use expiry on ${day(-2)}`]]) {
      const res = await link(s.id, s.resultId, { materialId: lotId });
      expect(res.status, lotId).toBe(400);
      expect(res.body.error).toContain(lotId);
      expect(res.body.error).toContain(text);
    }
    expect((await one('SELECT count(*)::int AS n FROM result_materials WHERE result_id = $1', [s.resultId])).n).toBe(0);
  });

  it('a usable lot is linked with the quantity used: a Used ledger row carries the result; more than the balance is refused', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    const res = await link(s.id, s.resultId, { materialId: lot.id, quantity: 25.5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ resultId: s.resultId, sampleId: s.id, materialId: lot.id, quantity: 25.5, resultVersion: s.resultVersion, linkedBy: 'usr-analyst1' });
    expect((await ledger(lot.id)).at(-1)).toEqual({ tx_type: 'Used', delta: -25.5, balance: 974.5, result_id: s.resultId, into_solution_id: null });
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'ResultMaterial' AND entity_id = $1`, [res.body.id])).n).toBe(1);
    expect((await link(s.id, s.resultId, { materialId: lot.id })).status).toBe(409); // once per result

    const s2 = await sampleInTesting();
    const tooMuch = await link(s2.id, s2.resultId, { materialId: lot.id, quantity: 975 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/974\.5 mL left/);
    expect((await t.request.get(`/api/samples/${s.id}/materials`).set(H.reviewer)).body).toEqual([expect.objectContaining({ materialId: lot.id, usable: true })]);
  });

  it('the last of a lot used up closes it (Consumed)', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    expect((await link(s.id, s.resultId, { materialId: lot.id, quantity: 1000 })).status).toBe(200);
    expect((await lotRow(lot.id)).status).toBe('Consumed');
  });

  it('saving a result whose linked lot has since been rejected is 400 naming the lot and the date; the result is unchanged', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    expect((await link(s.id, s.resultId, { materialId: lot.id })).status).toBe(200);
    const rej = await t.request.post(`/api/reagent-lots/${lot.id}/reject`).set(H.qa).send({ expectedVersion: (await lotRow(lot.id)).version, password: TEST_PASSWORD, reason: 'Contaminated, investigation DEV-12' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const res = await saveResult(s, '99.5');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(lot.id);
    expect(res.body.error).toContain(`Rejected on ${TODAY}`);
    expect((await one('SELECT value, version FROM results WHERE id = $1', [s.resultId]))).toEqual({ value: null, version: s.resultVersion });
  });

  it('a lot that was usable when linked and has expired since blocks the save, naming the lot and its expiry date', async () => {
    const s = await sampleInTesting();
    const lot = await lotInDb('InUse', { expiry: day(-1), inUse: day(-1) });
    // The link of a day when the lot was still in date (written directly: the API would refuse it today).
    await sql(`INSERT INTO result_materials (id, result_id, sample_id, lot_id, result_version, linked_by, linked_at) VALUES ($1, $2, $3, $4, $5, 'usr-analyst1', now() - interval '2 days')`,
      [uniq('RM-T'), s.resultId, s.id, lot, s.resultVersion]);
    const res = await saveResult(s, '99.5');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(lot);
    expect(res.body.error).toContain(`expired on ${day(-1)}`);
  });

  it('PUT result with lotIds listing an expired lot is 400 naming the lot and the date and writes nothing; a usable one is linked to the new version', async () => {
    const s = await sampleInTesting();
    const expired = await lotInDb('Expired', { expiry: day(-10) });
    const bad = await saveResult(s, '100.1', { lotIds: [expired] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(expired);
    expect(bad.body.error).toContain(`expired on ${day(-10)}`);
    expect((await one('SELECT value FROM results WHERE id = $1', [s.resultId])).value).toBeNull();
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Result' AND entity_id = $1`, [s.resultId])).n).toBe(0);

    const lot = await usableLot();
    const ok = await saveResult(s, '100.1', { lotIds: [lot.id] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await sql('SELECT lot_id, result_version FROM result_materials WHERE result_id = $1', [s.resultId])).toEqual([{ lot_id: lot.id, result_version: ok.body.version }]);
  });

  it('the batch save takes lotIds per row, with the same refusal', async () => {
    const s = await sampleInTesting();
    const q = await lotInDb('Quarantine', { expiry: day(30) });
    const v = (await one('SELECT version FROM results WHERE id = $1', [s.resultId])).version;
    const res = await t.request.put(`/api/samples/${s.id}/results-batch`).set(H.analyst1).send({ items: [{ resultId: s.resultId, value: '99.9', expectedVersion: v, lotIds: [q] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(q);
    expect(res.body.details[0]).toMatchObject({ resultId: s.resultId });
  });

  it('a wrong link is withdrawn once, with a reason; the guard then ignores it', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    const l = (await link(s.id, s.resultId, { materialId: lot.id })).body;
    await t.request.post(`/api/reagent-lots/${lot.id}/reject`).set(H.qa).send({ expectedVersion: (await lotRow(lot.id)).version, password: TEST_PASSWORD, reason: 'Wrong grade delivered' });
    expect((await saveResult(s, '99.5')).status).toBe(400);
    expect((await t.request.post(`/api/result-materials/${l.id}/withdraw`).set(H.analyst1).send({ reason: 'x' })).status).toBe(400);
    const w = await t.request.post(`/api/result-materials/${l.id}/withdraw`).set(H.analyst1).send({ reason: 'Picked the wrong bottle; lot not used' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.withdrawnBy).toBe('usr-analyst1');
    expect((await t.request.post(`/api/result-materials/${l.id}/withdraw`).set(H.analyst1).send({ reason: 'Picked the wrong bottle again' })).status).toBe(409);
    expect((await saveResult(s, '99.5')).status).toBe(200);
  });

  it('only result-entry roles link materials, and only while the sample is in Testing', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    expect((await link(s.id, s.resultId, { materialId: lot.id }, 'qa')).status).toBe(403);
    const logged = await registerSample(t);
    expect((await link(logged.id, logged.result.id, { materialId: lot.id })).status).toBe(409);
    expect((await link(s.id, s.resultId, { materialId: lot.id, lotId: 'x' })).status).toBe(400);
  });

  it('a solution made from a lot that is later rejected cannot be used for results', async () => {
    const lot = await usableLot();
    const sol = (await t.request.post('/api/prepared-solutions').set(H.analyst1).send({ name: 'Buffer pH 7', preparation: 'SOP-BUF-001', quantity: 100, unit: 'mL', expiryDate: day(10), components: [{ materialId: lot.id, quantity: 5 }] })).body;
    await t.request.post(`/api/reagent-lots/${lot.id}/reject`).set(H.qa).send({ expectedVersion: (await lotRow(lot.id)).version, password: TEST_PASSWORD, reason: 'Supplier recall notice 2026-77' });
    const s = await sampleInTesting();
    const res = await link(s.id, s.resultId, { materialId: sol.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`made from reagent lot ${lot.id}, which was Rejected on ${TODAY}`);
    const picker = (await t.request.get('/api/reagent-materials').set(H.analyst1)).body as any[];
    expect(picker.find(m => m.id === sol.id)).toMatchObject({ usable: false });
    expect(picker.find(m => m.id === lot.id)).toBeUndefined(); // rejected lots are not offered at all
  });
});

describe('the ledger and the records cannot be rewritten (acceptance 3)', () => {
  it('reagent_transactions refuses UPDATE, DELETE and TRUNCATE, a balance that does not follow, and a negative balance', async () => {
    const lot = await usableLot();
    await expect(sql(`UPDATE reagent_transactions SET qty_delta = 5 WHERE lot_id = $1`, [lot.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`DELETE FROM reagent_transactions WHERE lot_id = $1`, [lot.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`TRUNCATE reagent_transactions CASCADE`)).rejects.toThrow(/not permitted/);
    await expect(sql(`INSERT INTO reagent_transactions (id, seq, lot_id, tx_type, qty_delta, balance_after, unit, reason, performed_by) VALUES ('RTX-T1', 999999001, $1, 'Consumed', -10, 500, 'mL', 'x', 'usr-qa')`, [lot.id]))
      .rejects.toThrow(/does not follow/);
    await expect(sql(`INSERT INTO reagent_transactions (id, seq, lot_id, tx_type, qty_delta, balance_after, unit, reason, performed_by) VALUES ('RTX-T2', 999999002, $1, 'Consumed', -1010, -10, 'mL', 'x', 'usr-qa')`, [lot.id]))
      .rejects.toThrow(/balance_check|violates check/);
    expect((await ledger(lot.id)).length).toBe(1);
  });

  it('a lot is never deleted, its receipt never changes, its status only moves forward and a final status freezes it', async () => {
    const lot = await usableLot();
    await expect(sql(`DELETE FROM reagent_lots WHERE id = $1`, [lot.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`UPDATE reagent_lots SET expiry_date = '2099-01-01' WHERE id = $1`, [lot.id])).rejects.toThrow(/receipt record/);
    await expect(sql(`UPDATE reagent_lots SET status = 'Quarantine' WHERE id = $1`, [lot.id])).rejects.toThrow(/cannot move/);
    await expect(sql(`UPDATE reagent_lots SET in_use_expiry = $2 WHERE id = $1`, [lot.id, day(400)])).rejects.toThrow();
    const rejected = await lotInDb('Rejected', { expiry: day(30) });
    await expect(sql(`UPDATE reagent_lots SET storage_location = 'Fridge 2' WHERE id = $1`, [rejected])).rejects.toThrow(/can no longer be changed/);
  });

  it('a result link is never deleted and only withdrawn once', async () => {
    const s = await sampleInTesting();
    const lot = await usableLot();
    const l = (await link(s.id, s.resultId, { materialId: lot.id })).body;
    await expect(sql(`DELETE FROM result_materials WHERE id = $1`, [l.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`UPDATE result_materials SET lot_id = NULL, solution_id = NULL WHERE id = $1`, [l.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`UPDATE result_materials SET result_version = 9 WHERE id = $1`, [l.id])).rejects.toThrow(/not permitted/);
  });
});

describe('traceback from a lot to every result', () => {
  it('lists the results measured with the lot, directly or through a solution made from it, and marks a withdrawn link', async () => {
    const lot = await usableLot();
    const sol = (await t.request.post('/api/prepared-solutions').set(H.analyst1).send({ name: 'Diluent', preparation: 'SOP-DIL-002', quantity: 200, unit: 'mL', expiryDate: day(10), components: [{ materialId: lot.id, quantity: 20 }] })).body;
    const a = await sampleInTesting();
    const b = await sampleInTesting();
    const c = await sampleInTesting();
    await link(a.id, a.resultId, { materialId: lot.id });
    await link(b.id, b.resultId, { materialId: sol.id, quantity: 5 });
    const wrong = (await link(c.id, c.resultId, { materialId: lot.id })).body;
    await t.request.post(`/api/result-materials/${wrong.id}/withdraw`).set(H.analyst1).send({ reason: 'Entered against the wrong sample' });
    const res = await t.request.get(`/api/reagent-lots/${lot.id}/traceback`).set(H.qa);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.solutions.map((x: any) => x.id)).toEqual([sol.id]);
    const byResult = Object.fromEntries(res.body.results.map((r: any) => [r.resultId, r]));
    expect(Object.keys(byResult).sort()).toEqual([a.resultId, b.resultId, c.resultId].sort());
    expect(byResult[b.resultId]).toMatchObject({ materialId: sol.id, sampleId: b.id, quantity: 5 });
    expect(byResult[a.resultId]).toMatchObject({ materialId: lot.id, withdrawnAt: null });
    expect(byResult[c.resultId].withdrawnAt).not.toBeNull();
    expect(res.body.truncated).toBe(false);
  });
});

describe('the scheduled job reagents.expiry', () => {
  it('flips lots and solutions past their use limit to Expired with an audit entry, and announces 30 and 7 days before once each', async () => {
    const { runReagentExpiry } = await import('../../src/server/schedules/reagents');
    const { db } = await import('../../src/db/index');
    const past = await lotInDb('InUse', { expiry: day(100), inUse: day(-1) });
    const soon7 = await lotInDb('InUse', { expiry: day(5), inUse: day(5) });
    const soon30 = await lotInDb('Approved', { expiry: day(25) });
    const far = await lotInDb('Approved', { expiry: day(200) });
    const r1 = await runReagentExpiry(db, { actorId: 'usr-admin' });
    expect(r1.expired).toBeGreaterThanOrEqual(1);
    expect(await lotRow(past)).toMatchObject({ status: 'Expired', closed_by: 'usr-admin' });
    expect((await one(`SELECT action, reason FROM audit_trail WHERE entity = 'ReagentLot' AND entity_id = $1 AND action = 'Expire'`, [past])).reason).toContain(`in-use expiry ${day(-1)}`);
    const alerts = async (id: string) => (await sql(`SELECT payload FROM outbox_events WHERE type = 'reagent.expiry_alert' AND entity_id = $1`, [id])).map(r => r.payload.threshold);
    expect(await alerts(past)).toEqual([0]);
    expect(await alerts(soon7)).toEqual([7]);
    expect(await alerts(soon30)).toEqual([30]);
    expect(await alerts(far)).toEqual([]);
    const r2 = await runReagentExpiry(db, { actorId: 'usr-admin' });
    expect(r2.expired).toBe(0);
    expect(await alerts(soon7)).toEqual([7]);
    expect(await alerts(soon30)).toEqual([30]);
    // The schedule ships with the application.
    const { SCHEDULES } = await import('../../src/server/schedules');
    expect(SCHEDULES.map(s => s.name)).toContain('reagents.expiry');
  });
});

describe('the dashboard counts lots', () => {
  it('active lots may be used today, expired lots are past their use limit', async () => {
    const before = (await t.request.get('/api/dashboard').set(H.qa)).body;
    await usableLot();
    await lotInDb('InUse', { expiry: day(-5), inUse: day(-5) });
    const after = (await t.request.get('/api/dashboard').set(H.qa)).body;
    expect(after.reagentsActive).toBe(before.reagentsActive + 1);
    expect(after.reagentsExpired).toBe(before.reagentsExpired + 1);
  });
});
