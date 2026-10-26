/**
 * Roadmap M17 (r2-master-data): products, product batches and customers as first-class records, and sample registration from them.
 *
 * Before: material and batch were free text typed at registration (an exact, case-sensitive match to an Active specification), there
 * was no product, no manufacturing or expiry date and no customer, and the traceability screen offered three hard-coded batch numbers.
 *
 * After:
 *   - products (unique by name, the material key the specifications use), batches (unique per product: the same batch number under
 *     two products is two batches) and customers are created and edited through strict schemas, with the version predicate and an
 *     audit entry in the same transaction;
 *   - a product's or a batch's status changes only with an e-signature (MASTER_DATA_STATUS), bound to the record version;
 *   - registering a sample from a batch fills the frozen samples.material and samples.batch text columns from the master rows and
 *     keeps the ids in the sample_context sidecar, in the registration's transaction.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, race, uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst1: await t.auth('analyst1@gxp.com') };
});

const PARAMS = [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }];

async function createProduct(over: Record<string, unknown> = {}, who: keyof typeof H = 'qa') {
  const name = uniq('Paracetamol 500 mg');
  return t.request.post('/api/products').set(H[who]).send({ code: uniq('PRD'), name, ...over });
}
async function product(over: Record<string, unknown> = {}) {
  const res = await createProduct(over);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; name: string; code: string; version: number; status: string };
}
async function createBatch(productId: string, over: Record<string, unknown> = {}, who: keyof typeof H = 'qa') {
  return t.request.post('/api/batches').set(H[who]).send({ productId, batchNo: uniq('B'), manufacturedOn: '2026-09-01', expiresOn: '2028-08-31', batchSize: '500 000 tablets', ...over });
}
async function batch(productId: string, over: Record<string, unknown> = {}) {
  const res = await createBatch(productId, over);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; batchNo: string; version: number; status: string; productId: string };
}
const sign = (path: string, body: Record<string, unknown>, who: keyof typeof H = 'qa') =>
  t.request.post(path).set(H[who]).send({ password: 'password', reason: 'Master data status decision', ...body });

describe('products', () => {
  it('are created by QA with an audit entry, listed, and read with their batches and the specification in force', async () => {
    const p = await product({ description: 'Film-coated tablets' });
    expect(p).toMatchObject({ status: 'Active', version: 1, description: 'Film-coated tablets' });
    const audit = await sql(`SELECT action, user_id, new_value FROM audit_trail WHERE entity = 'Product' AND entity_id = $1`, [p.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'Create', user_id: 'usr-qa' });
    expect(JSON.parse(audit[0].new_value)).toMatchObject({ name: p.name, code: p.code, status: 'Active' });

    const list = await t.request.get('/api/products').set(H.analyst1);
    expect(list.status).toBe(200);
    expect(list.body.map((x: any) => x.id)).toContain(p.id);

    await insertActiveSpec(t, p.name, PARAMS as any);
    const detail = await t.request.get(`/api/products/${p.id}`).set(H.analyst1);
    expect(detail.status).toBe(200);
    expect(detail.body.product.id).toBe(p.id);
    expect(detail.body.activeSpec).toMatchObject({ revision: 1, parameters: ['Assay'] });
    expect(detail.body.batches).toEqual([]);
  });

  it('refuses a second product with the same name in another spelling (the material key) or the same code: 409', async () => {
    const p = await product();
    expect((await createProduct({ name: `  ${p.name.toUpperCase()}  ` })).status).toBe(409);
    expect((await createProduct({ code: p.code })).status).toBe(409);
  });

  it('is master data: an Analyst or a Reviewer may read it but not create it (403)', async () => {
    expect((await createProduct({}, 'analyst1')).status).toBe(403);
    expect((await createProduct({}, 'reviewer')).status).toBe(403);
  });

  it('accepts only the fields a person states: id, status, version or an unknown key are 400', async () => {
    for (const extra of [{ id: 'PRD-X' }, { status: 'Inactive' }, { version: 3 }, { createdBy: 'usr-admin' }, { surprise: 1 }]) {
      const res = await createProduct(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('edits the description with the version predicate; name and code cannot be changed', async () => {
    const p = await product();
    const ok = await t.request.put(`/api/products/${p.id}`).set(H.qa).send({ description: 'Blister of 10', expectedVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ description: 'Blister of 10', version: 2 });
    const stale = await t.request.put(`/api/products/${p.id}`).set(H.qa).send({ description: 'Bottle', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await t.request.put(`/api/products/${p.id}`).set(H.qa).send({ name: 'Other', expectedVersion: 2 })).status).toBe(400);
    const audit = await sql(`SELECT action, field, old_value, new_value FROM audit_trail WHERE entity = 'Product' AND entity_id = $1 ORDER BY sequence`, [p.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Update']);
    expect(audit[1]).toMatchObject({ field: 'description', old_value: '', new_value: 'Blister of 10' });
  });

  it('changes status only with a signature (MASTER_DATA_STATUS) bound to the record version, and an Inactive product takes no batch or registration', async () => {
    const p = await product();
    await insertActiveSpec(t, p.name, PARAMS as any);
    const b = await batch(p.id);
    const noPassword = await t.request.post(`/api/products/${p.id}/status`).set(H.qa).send({ status: 'Inactive', expectedVersion: 1, reason: 'Discontinued' });
    expect(noPassword.status).toBe(400);
    const wrong = await sign(`/api/products/${p.id}/status`, { status: 'Inactive', expectedVersion: 1, password: 'wrong' });
    expect(wrong.status).toBe(401);
    expect((await one('SELECT status, version FROM products WHERE id = $1', [p.id]))).toEqual({ status: 'Active', version: 1 });

    const res = await sign(`/api/products/${p.id}/status`, { status: 'Inactive', expectedVersion: 1, reason: 'Product discontinued' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.product).toMatchObject({ status: 'Inactive', version: 2 });
    const sig = await one(`SELECT entity_type, entity_id, meaning_code, record_version, signer_id FROM signatures WHERE id = $1`, [res.body.signature.id]);
    expect(sig).toEqual({ entity_type: 'Product', entity_id: p.id, meaning_code: 'MASTER_DATA_STATUS', record_version: 2, signer_id: 'usr-qa' });
    const verify = await t.request.get(`/api/signatures/verify/${res.body.signature.id}`).set(H.qa);
    expect(verify.body).toMatchObject({ status: 'valid', valid: true });

    // The same status again is not a change.
    expect((await sign(`/api/products/${p.id}/status`, { status: 'Inactive', expectedVersion: 2 })).status).toBe(409);
    // An Analyst cannot sign a master data decision.
    expect((await sign(`/api/products/${p.id}/status`, { status: 'Active', expectedVersion: 2 }, 'analyst1')).status).toBe(403);

    expect((await createBatch(p.id)).status).toBe(409);
    const reg = await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({});
    expect(reg.status).toBe(409);
    expect(reg.body.error).toMatch(/Inactive/);
  });
});

describe('batches', () => {
  it('the same batch number under two products is allowed; a duplicate within one product is 409', async () => {
    const a = await product();
    const b = await product();
    const batchNo = uniq('LOT');
    expect((await createBatch(a.id, { batchNo })).status).toBe(200);
    expect((await createBatch(b.id, { batchNo })).status).toBe(200);
    const dup = await createBatch(a.id, { batchNo });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain(batchNo);
    // Another spelling of the same number (case, spaces) is the same batch.
    expect((await createBatch(a.id, { batchNo: ` ${batchNo.toLowerCase()} ` })).status).toBe(409);
  });

  it('two people creating the same batch at the same moment: one 200, one 409, one row', async () => {
    const p = await product();
    const batchNo = uniq('RACE');
    const codes = await race(2, () => createBatch(p.id, { batchNo }));
    expect(codes).toEqual([200, 409]);
    expect((await sql('SELECT id FROM product_batches WHERE product_id = $1', [p.id]))).toHaveLength(1);
  });

  it('starts in Quarantine with its dates and size; expiry before manufacture and a calendar day that does not exist are 400', async () => {
    const p = await product();
    const b = await batch(p.id);
    expect(b).toMatchObject({ status: 'Quarantine', version: 1, manufacturedOn: '2026-09-01', expiresOn: '2028-08-31', batchSize: '500 000 tablets' });
    expect((await createBatch(p.id, { manufacturedOn: '2026-09-01', expiresOn: '2026-08-01' })).status).toBe(400);
    expect((await createBatch(p.id, { manufacturedOn: '2026-02-30' })).status).toBe(400);
    expect((await createBatch(p.id, { status: 'Released' })).status).toBe(400);
    expect((await createBatch('PRD-DOES-NOT-EXIST')).status).toBe(404);
    expect((await createBatch(p.id, {}, 'analyst1')).status).toBe(403);
  });

  it('is edited in Quarantine with the version predicate and an audit entry per field; a released batch is frozen (423)', async () => {
    const p = await product();
    const b = await batch(p.id);
    const ok = await t.request.put(`/api/batches/${b.id}`).set(H.qa).send({ expiresOn: '2028-09-30', expectedVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ expiresOn: '2028-09-30', version: 2 });
    const audit = await sql(`SELECT action, field, old_value, new_value FROM audit_trail WHERE entity = 'ProductBatch' AND entity_id = $1 ORDER BY sequence`, [b.id]);
    expect(audit.map(a => [a.action, a.field])).toEqual([['Create', 'all'], ['Update', 'expiresOn']]);
    expect(audit[1]).toMatchObject({ old_value: '2028-08-31', new_value: '2028-09-30' });
    expect((await t.request.put(`/api/batches/${b.id}`).set(H.qa).send({ expiresOn: '2028-10-31', expectedVersion: 1 })).status).toBe(409);
    expect((await t.request.put(`/api/batches/${b.id}`).set(H.qa).send({ batchNo: 'X', expectedVersion: 2 })).status).toBe(400);

    await sql(`INSERT INTO batch_releases (id, batch, status, version) VALUES ($1, $2, 'Released', 1)`, [uniq('BR'), b.batchNo]);
    const rel = await sign(`/api/batches/${b.id}/status`, { status: 'Released', expectedVersion: 2 });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    const frozen = await t.request.put(`/api/batches/${b.id}`).set(H.qa).send({ expiresOn: '2029-01-31', expectedVersion: 3 });
    expect(frozen.status).toBe(423);
  });

  it('status: Released only after the formal batch release, Rejected and Recalled are terminal, every change signed and verifiable', async () => {
    const p = await product();
    const b = await batch(p.id);
    const early = await sign(`/api/batches/${b.id}/status`, { status: 'Released', expectedVersion: 1 });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/batch release/i);

    await sql(`INSERT INTO batch_releases (id, batch, status, version) VALUES ($1, $2, 'Released', 1)`, [uniq('BR'), b.batchNo]);
    const released = await sign(`/api/batches/${b.id}/status`, { status: 'Released', expectedVersion: 1 });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.batch).toMatchObject({ status: 'Released', version: 2 });
    expect((await sign(`/api/batches/${b.id}/status`, { status: 'Quarantine', expectedVersion: 2 })).status).toBe(409);
    const recalled = await sign(`/api/batches/${b.id}/status`, { status: 'Recalled', expectedVersion: 2, reason: 'Field complaint, recall decision RC-01' });
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    expect((await sign(`/api/batches/${b.id}/status`, { status: 'Released', expectedVersion: 3 })).status).toBe(423);

    const sigs = await sql(`SELECT id, meaning_code, record_version FROM signatures WHERE entity_type = 'ProductBatch' AND entity_id = $1 ORDER BY record_version`, [b.id]);
    expect(sigs.map(s => [s.meaning_code, s.record_version])).toEqual([['MASTER_DATA_STATUS', 2], ['MASTER_DATA_STATUS', 3]]);
    for (const s of sigs) expect((await t.request.get(`/api/signatures/verify/${s.id}`).set(H.qa)).body, s.id).toMatchObject({ status: 'valid' });

    // A signed batch altered in the database no longer verifies.
    await sql(`UPDATE product_batches SET expires_on = '2030-01-01' WHERE id = $1`, [b.id]);
    expect((await t.request.get(`/api/signatures/verify/${sigs[1].id}`).set(H.qa)).body).toMatchObject({ status: 'record-modified', valid: false });
  });

  it('a status change with a stale version is 409 and leaves no signature', async () => {
    const p = await product();
    const b = await batch(p.id);
    await t.request.put(`/api/batches/${b.id}`).set(H.qa).send({ batchSize: '1 000 kg', expectedVersion: 1 });
    const stale = await sign(`/api/batches/${b.id}/status`, { status: 'Rejected', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(await sql(`SELECT id FROM signatures WHERE entity_type = 'ProductBatch' AND entity_id = $1`, [b.id])).toEqual([]);
    expect((await one('SELECT status FROM product_batches WHERE id = $1', [b.id])).status).toBe('Quarantine');
  });
});

describe('registration from a product batch', () => {
  it('fills samples.material and samples.batch from the master rows and keeps the ids in sample_context, in one transaction', async () => {
    const p = await product();
    await insertActiveSpec(t, p.name, PARAMS as any);
    const b = await batch(p.id);
    const c = await t.request.post('/api/customers').set(H.qa).send({ code: uniq('CUST'), name: 'Nile Pharmacies' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);

    const res = await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({ customerId: c.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sampleId = res.body.sample.id as string;
    expect(sampleId).toMatch(/^SMP-\d{4}-\d{5}$/);
    expect(await one('SELECT material, batch, state, created_by, spec_revision FROM samples WHERE id = $1', [sampleId]))
      .toEqual({ material: p.name, batch: b.batchNo, state: 'Logged', created_by: 'usr-analyst1', spec_revision: 1 });
    expect(await one('SELECT product_id, batch_id, customer_id, origin, created_by FROM sample_context WHERE sample_id = $1', [sampleId]))
      .toEqual({ product_id: p.id, batch_id: b.id, customer_id: c.body.id, origin: 'registration', created_by: 'usr-analyst1' });
    expect((await sql('SELECT parameter FROM results WHERE sample_id = $1', [sampleId])).map(r => r.parameter)).toEqual(['Assay']);
    const audit = await sql(`SELECT entity, action FROM audit_trail WHERE entity_id = $1 ORDER BY sequence`, [sampleId]);
    expect(audit).toEqual([{ entity: 'Sample', action: 'Create' }, { entity: 'SampleContext', action: 'Create' }]);

    // The batch's samples are found by the ids, and the text columns agree with them.
    const detail = await t.request.get(`/api/batches/${b.id}`).set(H.analyst1);
    expect(detail.status).toBe(200);
    expect(detail.body.samples.map((s: any) => s.id)).toEqual([sampleId]);
  });

  it('is refused, with nothing written, when the product has no specification in force, the batch is Rejected, or the customer is unknown', async () => {
    const p = await product();
    const b = await batch(p.id);
    const before = Number((await one('SELECT count(*) AS n FROM samples')).n);
    const noSpec = await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({});
    expect(noSpec.status).toBe(400);
    expect(noSpec.body.error).toMatch(/No Active specification/);

    await insertActiveSpec(t, p.name, PARAMS as any);
    expect((await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({ customerId: 'CUS-NOPE' })).status).toBe(404);
    const rej = await sign(`/api/batches/${b.id}/status`, { status: 'Rejected', expectedVersion: 1 });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const blocked = await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Rejected/);
    expect(Number((await one('SELECT count(*) AS n FROM samples')).n)).toBe(before);
  });

  it('is a registration: QA and Reviewer may not register (403), unknown keys are 400', async () => {
    const p = await product();
    await insertActiveSpec(t, p.name, PARAMS as any);
    const b = await batch(p.id);
    expect((await t.request.post(`/api/batches/${b.id}/samples`).set(H.reviewer).send({})).status).toBe(403);
    expect((await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({ material: 'Other' })).status).toBe(400);
  });

  it('the context row cannot be changed afterwards (append-only)', async () => {
    const p = await product();
    await insertActiveSpec(t, p.name, PARAMS as any);
    const b = await batch(p.id);
    const res = await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({});
    await expect(sql(`UPDATE sample_context SET customer_id = NULL WHERE sample_id = $1`, [res.body.sample.id])).rejects.toThrow(/not permitted/);
    await expect(sql(`DELETE FROM sample_context WHERE sample_id = $1`, [res.body.sample.id])).rejects.toThrow(/not permitted/);
  });
});

describe('customers', () => {
  it('are created, edited with the version predicate and deactivated with a reason, each audited; a duplicate code is 409', async () => {
    const code = uniq('CUST');
    const c = await t.request.post('/api/customers').set(H.qa).send({ code, name: 'Delta Hospital', contact: 'qa@delta.example' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'Active', version: 1 });
    expect((await t.request.post('/api/customers').set(H.qa).send({ code: code.toLowerCase(), name: 'Another' })).status).toBe(409);
    expect((await t.request.post('/api/customers').set(H.analyst1).send({ code: uniq('C'), name: 'X' })).status).toBe(403);

    const upd = await t.request.put(`/api/customers/${c.body.id}`).set(H.qa).send({ name: 'Delta General Hospital', expectedVersion: 1 });
    expect(upd.status).toBe(200);
    expect((await t.request.put(`/api/customers/${c.body.id}`).set(H.qa).send({ name: 'Y', expectedVersion: 1 })).status).toBe(409);
    expect((await t.request.put(`/api/customers/${c.body.id}`).set(H.qa).send({ status: 'Inactive', expectedVersion: 2 })).status).toBe(400);
    const off = await t.request.post(`/api/customers/${c.body.id}/status`).set(H.qa).send({ status: 'Inactive', expectedVersion: 2, reason: 'Contract ended' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ status: 'Inactive', version: 3 });
    const audit = await sql(`SELECT action, field, reason FROM audit_trail WHERE entity = 'Customer' AND entity_id = $1 ORDER BY sequence`, [c.body.id]);
    expect(audit.map(a => [a.action, a.field])).toEqual([['Create', 'all'], ['Update', 'name'], ['StatusChange', 'status']]);
    expect(audit[2].reason).toBe('Contract ended');

    const list = await t.request.get('/api/customers').set(H.analyst1);
    expect(list.status).toBe(200);
    expect(list.body.find((x: any) => x.id === c.body.id)).toMatchObject({ status: 'Inactive' });

    // An inactive customer is not offered for a new registration.
    const p = await product();
    await insertActiveSpec(t, p.name, PARAMS as any);
    const b = await batch(p.id);
    expect((await t.request.post(`/api/batches/${b.id}/samples`).set(H.analyst1).send({ customerId: c.body.id })).status).toBe(409);
  });
});

describe('the traceability dossier', () => {
  it('lists the batches that exist (no invented ones) and shows the master record of the batch: product, dates, status', async () => {
    const p = await product();
    const b = await batch(p.id);
    const list = await t.request.get('/api/traceability/batches').set(H.analyst1);
    expect(list.status).toBe(200);
    expect(list.body.find((x: any) => x.batch === b.batchNo)).toMatchObject({ material: p.name, masterStatus: 'Quarantine' });
    expect(JSON.stringify(list.body)).not.toContain('Pharmaceutical Formulation');

    const dossier = await t.request.get(`/api/traceability/batch/${encodeURIComponent(b.batchNo)}`).set(H.analyst1);
    expect(dossier.status).toBe(200);
    expect(dossier.body.master).toEqual([expect.objectContaining({
      id: b.id, productId: p.id, productName: p.name, batchNo: b.batchNo, status: 'Quarantine', manufacturedOn: '2026-09-01', expiresOn: '2028-08-31',
    })]);
  });
});
