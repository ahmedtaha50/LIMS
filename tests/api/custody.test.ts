/**
 * Roadmap M29 (r2-custody-labels): sample receipt, chain of custody, storage, aliquots, retains, labels and scan lookup.
 *
 *   receipt      a sample is received (condition, seal, temperature against the required storage) before testing starts; a receipt
 *                deviation blocks Logged -> Testing until QA acknowledges it with a signature (CUSTODY_DEVIATION_ACK), never the receiver
 *   ledger       the primary container made at receipt and its aliquots; every movement is a row of the hash-linked, append-only
 *                custody ledger with the running balance, which never goes negative
 *   retains      a container kept until a date; disposal is signed (RETAIN_DISPOSAL) and only once the date has come
 *   labels       every print is logged in a hash-linked ledger; a reprint without a reason is refused
 *   resolve      GET /resolve?code= turns a scanned code into the record, its address and what blocks work on it
 *
 * Needs the gate patch (docs/changes/r2-custody-labels.gate.patch): the route modules, the route table, the guard and the permissions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const PW = 'password';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** A sample registered by the API but NOT received (registerSample of the fixtures records the receipt since M29). */
async function unreceivedSample() {
  const material = uniq('Material');
  await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', 'Active', $3::jsonb)`,
    [uniq('SPEC'), material, JSON.stringify([{ name: 'Assay (%)', min: 98, max: 102 }])]);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}
const goodReceipt = (over: Record<string, unknown> = {}) => ({
  condition: 'Intact', sealIntact: true, temperatureC: 5, requiredStorage: '2-8 °C', requiredTempMin: 2, requiredTempMax: 8,
  quantity: 20, unit: 'mL', ...over,
});
const receive = (id: string, body: Record<string, unknown>, who = 'analyst1') => t.request.post(`/api/custody/samples/${id}/receipt`).set(H[who]).send(body);
const custody = async (id: string, who = 'analyst1') => {
  const res = await t.request.get(`/api/custody/samples/${id}`).set(H[who]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const sampleVersion = async (id: string) => (await sql(`select version from samples where id = $1`, [id]))[0].version as number;
const startTesting = async (id: string) => {
  const expectedVersion = await sampleVersion(id);
  return t.request.post(`/api/samples/${id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion });
};
const ack = async (id: string, who = 'qa', extra: Record<string, unknown> = {}) => {
  const expectedVersion = (await custody(id)).receipt.version;
  return t.request.post(`/api/custody/samples/${id}/receipt/acknowledge`).set(H[who])
    .send({ password: PW, reason: 'Excursion assessed: stability data cover 2 h at 25 °C', expectedVersion, ...extra });
};

describe('receipt before testing (acceptance 1)', () => {
  it('Begin Testing on an unreceived sample returns 400 and says the receipt is missing', async () => {
    const id = await unreceivedSample();
    const res = await startTesting(id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRANSITION_BLOCKED');
    expect(res.body.error).toMatch(/not been received/i);
    expect((await custody(id)).status).toBe('Not received');
  });

  it('a receipt in range creates the receipt, the primary container and the first ledger row; testing may start', async () => {
    const id = await unreceivedSample();
    const res = await receive(id, goodReceipt());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.receipt).toMatchObject({ sampleId: id, deviation: false, receivedBy: 'usr-analyst1', condition: 'Intact', version: 1 });
    expect(res.body.container).toMatchObject({ sampleId: id, kind: 'Primary', quantity: 20, unit: 'mL', status: 'Active' });
    expect(res.body.container.id).toMatch(/^CTN-\d{6,}$/);
    const c = await custody(id);
    expect(c.status).toBe('Received');
    expect(c.events.map((e: any) => [e.eventType, e.qtyDelta, e.balanceAfter])).toEqual([['Receipt', 20, 20]]);
    const audit = await sql(`select action from audit_trail where entity = 'SampleReceipt' and entity_id = $1`, [id]);
    expect(audit.map(a => a.action)).toEqual(['Receive']);
    expect((await startTesting(id)).status).toBe(200);
  });

  it('a sample is received once (409), and server-controlled fields are refused (400)', async () => {
    const id = await unreceivedSample();
    expect((await receive(id, goodReceipt())).status).toBe(200);
    const again = await receive(id, goodReceipt());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_RECEIVED');
    const id2 = await unreceivedSample();
    expect((await receive(id2, goodReceipt({ deviation: false }))).status).toBe(400);
    expect((await receive(id2, goodReceipt({ receivedBy: 'usr-qa' }))).status).toBe(400);
    expect((await receive(id2, goodReceipt({ quantity: -1 }))).status).toBe(400);
  });

  it('an out-of-range temperature blocks testing until QA signs; the receiver may not acknowledge', async () => {
    const id = await unreceivedSample();
    const res = await receive(id, goodReceipt({ temperatureC: 14.5 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.receipt.deviation).toBe(true);
    expect(res.body.receipt.deviationReasons).toMatch(/14\.5/);
    expect((await custody(id)).status).toBe('Deviation: awaiting QA');

    const blocked = await startTesting(id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/receipt deviation/i);

    // The analyst cannot sign at all (custody.approve), and an Admin who received the sample may not acknowledge it (independence).
    expect((await ack(id, 'analyst1')).status).toBe(403);
    const idAdmin = await unreceivedSample();
    expect((await receive(idAdmin, goodReceipt({ sealIntact: false }), 'admin')).status).toBe(200);
    const sod = await ack(idAdmin, 'admin');
    expect(sod.status).toBe(403);
    expect(sod.body.code).toBe('SOD_VIOLATION');

    const noReason = await ack(id, 'qa', { reason: undefined });
    expect(noReason.status).toBe(400);

    const signed = await ack(id, 'qa');
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.signature).toMatchObject({ meaningCode: 'CUSTODY_DEVIATION_ACK', entityType: 'SampleReceipt', entityId: id, recordVersion: 2 });
    expect((await custody(id)).status).toBe('Deviation acknowledged');
    const verify = await t.request.get(`/api/signatures/verify/${signed.body.signature.id}`).set(H.qa);
    expect(verify.body.status).toBe('valid');

    const twice = await ack(id, 'qa');
    expect(twice.status).toBe(409);
    expect((await startTesting(id)).status).toBe(200);
  });

  it('a broken seal or a damaged container is a deviation too; a missing temperature for a required range is one', async () => {
    for (const over of [{ sealIntact: false }, { condition: 'Damaged' }, { temperatureC: null }]) {
      const id = await unreceivedSample();
      const res = await receive(id, goodReceipt(over));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.receipt.deviation, JSON.stringify(over)).toBe(true);
    }
    const ambient = await unreceivedSample();
    const res = await receive(ambient, goodReceipt({ temperatureC: null, requiredStorage: 'Ambient, protect from light', requiredTempMin: null, requiredTempMax: null }));
    expect(res.body.receipt.deviation).toBe(false);
  });
});

describe('containers, aliquots and the custody ledger (acceptance 2)', () => {
  async function received(quantity = 20) {
    const id = await unreceivedSample();
    const res = await receive(id, goodReceipt({ quantity }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { id, container: res.body.container as { id: string; version: number } };
  }
  const containerOf = async (sampleId: string, cid: string) => (await custody(sampleId)).containers.find((c: any) => c.id === cid);
  const aliquot = async (sampleId: string, cid: string, quantity: number, who = 'analyst1') => {
    const expectedVersion = (await containerOf(sampleId, cid)).version;
    return t.request.post(`/api/custody/containers/${cid}/aliquots`).set(H[who]).send({ quantity, reason: 'Aliquot for assay', expectedVersion });
  };

  it('aliquoting 5 mL from 20 mL creates a child and two ledger rows', async () => {
    const { id, container } = await received(20);
    const res = await aliquot(id, container.id, 5);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.parent).toMatchObject({ id: container.id, quantity: 15 });
    expect(res.body.child).toMatchObject({ parentId: container.id, kind: 'Aliquot', quantity: 5, unit: 'mL', sampleId: id });
    const c = await custody(id);
    const rows = c.events.map((e: any) => [e.eventType, e.containerId, e.qtyDelta, e.balanceAfter]);
    expect(rows).toEqual([
      ['Receipt', container.id, 20, 20],
      ['Aliquot out', container.id, -5, 15],
      ['Aliquot in', res.body.child.id, 5, 5],
    ]);
    // hash-linked: each row's prev_hash is the hash of the row before it in the ledger
    const all = await sql(`select seq, prev_hash, hash from custody_events order by seq`);
    for (let i = 1; i < all.length; i++) expect(all[i].prev_hash).toBe(all[i - 1].hash);
    const v = await t.request.get('/api/custody/verify').set(H.qa);
    expect(v.status).toBe(200);
    expect(v.body.ledger).toMatchObject({ valid: true });
  });

  it('the balance never goes negative: an aliquot or consumption larger than the balance is refused and writes nothing', async () => {
    const { id, container } = await received(10);
    const before = (await sql(`select count(*)::int as n from custody_events`))[0].n;
    const res = await aliquot(id, container.id, 10.5);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_QUANTITY');
    const expectedVersion = (await containerOf(id, container.id)).version;
    const consume = await t.request.post(`/api/custody/containers/${container.id}/consume`).set(H.analyst1).send({ quantity: 11, reason: 'Used for testing', expectedVersion });
    expect(consume.status).toBe(409);
    expect((await sql(`select count(*)::int as n from custody_events`))[0].n).toBe(before);
    // The whole balance may be used; the container is then Empty.
    const all = await t.request.post(`/api/custody/containers/${container.id}/consume`).set(H.analyst1).send({ quantity: 10, reason: 'Used for testing', expectedVersion });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.container).toMatchObject({ quantity: 0, status: 'Empty' });
    // and the database refuses a row whose balance does not follow from the ledger, or is negative, whoever writes it
    const last = (await sql(`select * from custody_events where container_id = $1 order by seq desc limit 1`, [container.id]))[0];
    await expect(sql(`insert into custody_events (id, seq, container_id, sample_id, event_type, qty_delta, balance_after, unit, reason, actor_id, prev_hash, hash)
      values ('CE-X1', 999999, $1, $2, 'Consume', -1, -1, 'mL', 'x', 'usr-analyst1', 'p', 'h')`, [container.id, id])).rejects.toThrow(/custody_events_balance_check|does not follow/);
    await expect(sql(`insert into custody_events (id, seq, container_id, sample_id, event_type, qty_delta, balance_after, unit, reason, actor_id, prev_hash, hash)
      values ('CE-X2', 999998, $1, $2, 'Receipt', 5, 50, 'mL', 'x', 'usr-analyst1', 'p', 'h')`, [container.id, id])).rejects.toThrow(/does not follow/);
    expect(Number(last.balance_after)).toBe(0);
  });

  it('two aliquots at once from the last 6 mL: one succeeds, the other gets 409, the balance is not overdrawn', async () => {
    const { id, container } = await received(6);
    const expectedVersion = (await containerOf(id, container.id)).version;
    const send = () => t.request.post(`/api/custody/containers/${container.id}/aliquots`).set(H.analyst1).send({ quantity: 4, reason: 'Aliquot for assay', expectedVersion });
    const codes = (await Promise.all([send(), send()])).map(r => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect((await containerOf(id, container.id)).quantity).toBe(2);
  });

  it('UPDATE and DELETE on the ledger are refused', async () => {
    await received(1);
    await expect(sql(`update custody_events set qty_delta = 0`)).rejects.toThrow(/append-only/);
    await expect(sql(`delete from custody_events`)).rejects.toThrow(/append-only/);
    await expect(sql(`truncate custody_events cascade`)).rejects.toThrow(/append-only/);
  });

  it('a transfer moves the container to a location and a holder, in the ledger, with the version predicate', async () => {
    const { id, container } = await received(3);
    const loc = await t.request.post('/api/custody/locations').set(H.qa).send({ code: uniq('FRIDGE'), name: 'QC fridge 2', kind: 'Storage unit', tempMin: 2, tempMax: 8 });
    expect(loc.status, JSON.stringify(loc.body)).toBe(200);
    expect(loc.body.id).toMatch(/^LOC-\d{6,}$/);
    // An analyst does not define locations
    expect((await t.request.post('/api/custody/locations').set(H.analyst1).send({ code: uniq('X'), name: 'x', kind: 'Room' })).status).toBe(403);
    const expectedVersion = (await containerOf(id, container.id)).version;
    const res = await t.request.post(`/api/custody/containers/${container.id}/transfer`).set(H.analyst1)
      .send({ toLocationId: loc.body.id, toHolderId: 'usr-analyst2', reason: 'Handed over for assay', expectedVersion });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.container).toMatchObject({ locationId: loc.body.id, holderId: 'usr-analyst2', quantity: 3 });
    const stale = await t.request.post(`/api/custody/containers/${container.id}/transfer`).set(H.analyst1)
      .send({ toHolderId: 'usr-analyst1', reason: 'Handed back', expectedVersion });
    expect(stale.status).toBe(409);
    const e = (await custody(id)).events.at(-1);
    expect(e).toMatchObject({ eventType: 'Transfer', qtyDelta: 0, balanceAfter: 3, toLocationId: loc.body.id, toHolderId: 'usr-analyst2', fromHolderId: 'usr-analyst1' });
  });
});

describe('retain register', () => {
  it('a retain is registered with its date, refused for disposal before it, then disposed of with a signature', async () => {
    const id = await unreceivedSample();
    const r = await receive(id, goodReceipt({ quantity: 50 }));
    const cid = r.body.container.id;
    const retain = await t.request.post(`/api/custody/containers/${cid}/retain`).set(H.analyst1)
      .send({ retainUntil: inDays(30), reason: 'Retain sample per SOP', expectedVersion: r.body.container.version });
    expect(retain.status, JSON.stringify(retain.body)).toBe(200);
    expect(retain.body.retain).toMatchObject({ containerId: cid, status: 'Retained', retainUntil: inDays(30) });
    const list = await t.request.get('/api/custody/retains').set(H.qa);
    expect(list.body.find((x: any) => x.id === retain.body.retain.id)).toMatchObject({ due: false });

    const dispose = (who = 'qa', extra: Record<string, unknown> = {}) => t.request.post(`/api/custody/retains/${retain.body.retain.id}/dispose`).set(H[who])
      .send({ method: 'Incineration via waste contractor', password: PW, reason: 'Retention period ended', expectedVersion: 1, ...extra });
    const early = await dispose();
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('RETAIN_NOT_DUE');

    // the retention period ends (arranged in SQL: there is no route to shorten it)
    await sql(`update sample_retains set retain_until = $2 where id = $1`, [retain.body.retain.id, inDays(-1)]);
    const due = await t.request.get('/api/custody/retains?due=true').set(H.qa);
    expect(due.body.map((x: any) => x.id)).toContain(retain.body.retain.id);
    expect((await dispose('analyst1')).status).toBe(403);
    const ok = await dispose();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.signature).toMatchObject({ meaningCode: 'RETAIN_DISPOSAL', entityType: 'SampleRetain' });
    expect(ok.body.retain).toMatchObject({ status: 'Disposed', disposalMethod: 'Incineration via waste contractor' });
    const c = await custody(id);
    expect(c.containers.find((x: any) => x.id === cid)).toMatchObject({ status: 'Disposed', quantity: 0 });
    expect(c.events.at(-1)).toMatchObject({ eventType: 'Dispose', qtyDelta: -50, balanceAfter: 0 });
    expect((await dispose('qa', { expectedVersion: 2 })).status).toBe(409);
  });
});

describe('labels (acceptance 3, second part)', () => {
  it('the first print is logged; a reprint without a reason is refused, with one is logged as a reprint', async () => {
    const id = await unreceivedSample();
    const print = (body: Record<string, unknown>) => t.request.post('/api/custody/labels').set(H.analyst1).send({ entityType: 'Sample', entityId: id, symbology: 'code128', copies: 2, ...body });
    const first = await print({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.print).toMatchObject({ entityId: id, code: id, isReprint: false, copies: 2 });
    expect(first.body.label).toMatchObject({ code: id, title: id });

    const noReason = await print({ symbology: 'qr' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REPRINT_REASON_REQUIRED');
    const short = await print({ reason: 'x' });
    expect(short.status).toBe(400);
    const again = await print({ reason: 'Label smudged during thawing' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.print).toMatchObject({ isReprint: true, reason: 'Label smudged during thawing' });

    const log = await t.request.get(`/api/custody/labels?entityType=Sample&entityId=${id}`).set(H.qa);
    expect(log.body.map((p: any) => p.isReprint)).toEqual([false, true]);
    const rows = await sql(`select prev_hash, hash from label_prints order by seq`);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    await expect(sql(`update label_prints set reason = 'x'`)).rejects.toThrow(/append-only/);
    expect((await t.request.get('/api/custody/verify').set(H.qa)).body.labels).toMatchObject({ valid: true });
    // a label is printed only for a record that exists
    expect((await t.request.post('/api/custody/labels').set(H.analyst1).send({ entityType: 'Sample', entityId: 'SMP-0000-99999', symbology: 'qr', copies: 1 })).status).toBe(404);
  });

  it('the verifier finds a ledger row changed behind the triggers', async () => {
    const id = await unreceivedSample();
    await receive(id, goodReceipt());
    const before = await t.request.get('/api/custody/verify').set(H.qa);
    expect(before.body.ledger.valid).toBe(true);
    const [{ reason }] = await sql(`select reason from custody_events where sample_id = $1`, [id]);
    await sql(`alter table custody_events disable trigger user`);
    await sql(`update custody_events set reason = 'tampered' where sample_id = $1`, [id]);
    await sql(`alter table custody_events enable trigger user`);
    const after = await t.request.get('/api/custody/verify').set(H.qa);
    expect(after.body.ledger.valid).toBe(false);
    expect(after.body.ledger.brokenAt).toBeGreaterThan(0);
    // put it back for the other tests of this file
    await sql(`alter table custody_events disable trigger user`);
    await sql(`update custody_events set reason = $2 where sample_id = $1`, [id, reason]);
    await sql(`alter table custody_events enable trigger user`);
  });
});

describe('scan lookup: GET /resolve (acceptance 3, first part)', () => {
  it('resolves a sample id that is not in any loaded list, with its address and its blockers', async () => {
    const id = await unreceivedSample();
    const res = await t.request.get(`/api/resolve?code=${encodeURIComponent(id)}`).set(H.analyst2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'Sample', id, href: `#/samples/${id}` });
    expect(res.body.blockers.join(' ')).toMatch(/not been received/i);
  });

  it('resolves a container to its sample, and names an expired sample as a blocker', async () => {
    const id = await unreceivedSample();
    const r = await receive(id, goodReceipt({ expDate: inDays(-2) }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = await t.request.get(`/api/resolve?code=${r.body.container.id}`).set(H.analyst2);
    expect(res.body).toMatchObject({ kind: 'Container', id: r.body.container.id, href: `#/samples/${id}`, sampleId: id });
    expect(res.body.blockers.join(' ')).toMatch(/expired/i);
  });

  it('names an overdue instrument and an expired reagent lot', async () => {
    await sql(`insert into instruments (id, name, type, status, calibration_due_date, last_calibration_date) values ('INS-CUST-1', 'HPLC 9', 'HPLC', 'Active', $1, '2025-01-01')`, [inDays(-3)]);
    const ins = await t.request.get('/api/resolve?code=INS-CUST-1').set(H.analyst1);
    expect(ins.body).toMatchObject({ kind: 'Instrument', id: 'INS-CUST-1' });
    expect(ins.body.blockers.join(' ')).toMatch(/calibration/i);
    await sql(`insert into reagents (id, name, lot_number, expiry_date, status, quantity) values ('REA-CUST-1', 'Acetonitrile', 'LOT-77', $1, 'Available', '1 L')`, [inDays(-1)]);
    const rea = await t.request.get('/api/resolve?code=LOT-77').set(H.analyst1);
    expect(rea.body).toMatchObject({ kind: 'Reagent', id: 'REA-CUST-1' });
    expect(rea.body.blockers.join(' ')).toMatch(/expired/i);
  });

  it('an unknown code is 404 with a message, and the query is strict', async () => {
    const res = await t.request.get('/api/resolve?code=NOPE-123').set(H.analyst1);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/NOPE-123/);
    expect((await t.request.get('/api/resolve').set(H.analyst1)).status).toBe(400);
    expect((await t.request.get('/api/resolve?code=x&extra=1').set(H.analyst1)).status).toBe(400);
  });
});

describe('the fixture registerSample', () => {
  it('records a receipt, so the other suites can start testing', async () => {
    const s = await registerSample(t);
    expect((await custody(s.id)).status).toBe('Received');
  });
});
