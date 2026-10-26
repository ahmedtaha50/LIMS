/**
 * Roadmap M13 (r1-quality-fixes), batch materials: no defaulted values, two different people.
 *
 * Before: a dispensing that left out the CoA status was recorded as 'Verified Pass', potency '100.00 %', loss on drying '0.50 %' and
 * manufacturer 'Approved Manufacturer', and the verifier was always the person who dispensed it. Defaulted values are fabricated data
 * (21 CFR 211.84) and a verification by the dispenser verifies nothing (Annex 11 s.12, ALCOA attributable).
 *
 * After: the dispenser (the signed-in user) states every value; a different person, Reviewer, QA or Admin, verifies it by signing
 * with their own credentials in the same request (VERIFICATION). The dispenser verifying themselves is 403.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const verifierOf = (email: string, over: Record<string, unknown> = {}) => ({ email, password: TEST_PASSWORD, ...over });
const payload = (over: Record<string, unknown> = {}) => ({
  materialName: 'Paracetamol BP/USP powder', materialType: 'API (Active Pharmaceutical Ingredient)', lotNumber: uniq('LOT'),
  manufacturer: 'Granules India Ltd', coaNumber: uniq('COA'), coaStatus: 'Verified Pass', quantityDispensed: '500.00 kg',
  potencyAssay: '99.8 %', lossOnDrying: '0.20 %', verifier: verifierOf('reviewer@gxp.com'), ...over,
});
const dispense = (batch: string, over: Record<string, unknown> = {}, who: keyof typeof H = 'analyst1') =>
  t.request.post(`/api/traceability/batch/${batch}/material`).set(H[who]).send(payload(over));
const rows = (batch: string) => sql('SELECT * FROM batch_materials WHERE batch = $1', [batch]);

describe('a complete, verified dispensing', () => {
  it('is recorded exactly as stated: dispensed by the signed-in user, verified by the other person, nothing defaulted', async () => {
    const batch = uniq('B-OK');
    const body = payload();
    const res = await t.request.post(`/api/traceability/batch/${batch}/material`).set(H.analyst1).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await rows(batch);
    expect(row).toMatchObject({
      material_name: body.materialName, material_type: body.materialType, lot_number: body.lotNumber, manufacturer: 'Granules India Ltd', coa_number: body.coaNumber,
      coa_status: 'Verified Pass', quantity_dispensed: '500.00 kg', potency_assay: '99.8 %', loss_on_drying: '0.20 %', dispensed_by: 'usr-analyst1', verified_by: 'usr-reviewer',
    });
    expect(res.body).toMatchObject({ id: row.id, dispensedBy: 'usr-analyst1', verifiedBy: 'usr-reviewer' });
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
  });

  it('writes the dispenser\'s audit entry and the verifier\'s signature and audit entry, each under its own person', async () => {
    const batch = uniq('B-SIG');
    const res = await dispense(batch);
    const id = res.body.id as string;
    const audit = await sql(`SELECT action, user_id, entity FROM audit_trail WHERE entity = 'BatchMaterial' AND entity_id = $1 ORDER BY sequence`, [id]);
    expect(audit).toEqual([
      { action: 'Dispense', user_id: 'usr-analyst1', entity: 'BatchMaterial' },
      { action: 'Verify', user_id: 'usr-reviewer', entity: 'BatchMaterial' },
    ]);
    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'BatchMaterial' AND entity_id = $1`, [id]);
    expect(sig).toMatchObject({ meaning_code: 'VERIFICATION', signer_id: 'usr-reviewer', signer_name: 'Test Reviewer', signer_role: 'Reviewer', hash_version: 2 });
    expect(sig.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const linked = await one('SELECT action, user_id FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(linked).toEqual({ action: 'Verify', user_id: 'usr-reviewer' });
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true, status: 'valid', entityType: 'BatchMaterial' });
  });

  it('QA and Admin may verify as well; the batch trace shows both names', async () => {
    for (const email of ['qa@gxp.com', 'admin@gxp.com']) {
      const res = await dispense(uniq('B-V'), { verifier: verifierOf(email) });
      expect(res.status, `${email}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const batch = uniq('B-TRACE');
    await dispense(batch, {}, 'analyst2');
    const trace = await t.request.get(`/api/traceability/batch/${batch}`).set(H.qa);
    expect(trace.body.materials[0]).toMatchObject({ dispensedByName: 'Test Analyst Two', verifiedByName: 'Test Reviewer', coaStatus: 'Verified Pass' });
  });
});

describe('every value is stated: a missing one is 400 and nothing is recorded', () => {
  it.each(['materialName', 'materialType', 'lotNumber', 'manufacturer', 'coaNumber', 'coaStatus', 'quantityDispensed', 'potencyAssay', 'lossOnDrying', 'verifier'])(
    'without %s', async (field) => {
      const batch = uniq('B-MISSING');
      const body: Record<string, unknown> = payload();
      delete body[field];
      const res = await t.request.post(`/api/traceability/batch/${batch}/material`).set(H.analyst1).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(await rows(batch)).toHaveLength(0);
    });

  it('empty or blank values are no values; a CoA status outside the vocabulary is refused', async () => {
    const batch = uniq('B-EMPTY');
    for (const over of [{ coaStatus: '' }, { coaStatus: '  ' }, { coaStatus: 'Looks fine' }, { manufacturer: '' }, { potencyAssay: '' }, { lossOnDrying: '   ' }, { materialType: '' }, { potencyAssay: 'high' }, { lossOnDrying: 'low' }]) {
      const res = await dispense(batch, over);
      expect(res.status, JSON.stringify(over) + JSON.stringify(res.body)).toBe(400);
    }
    expect(await rows(batch)).toHaveLength(0);
  });

  it('a value that does not apply (a packaging component has no assay) is typed as N/A, explicitly', async () => {
    const batch = uniq('B-NA');
    const res = await dispense(batch, { materialType: 'Primary Packaging Material', potencyAssay: 'N/A', lossOnDrying: 'N/A' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rows(batch))[0]).toMatchObject({ potency_assay: 'N/A', loss_on_drying: 'N/A' });
  });

  it('a quarantined or rejected CoA is recorded as such, not as a pass', async () => {
    const batch = uniq('B-REJ');
    expect((await dispense(batch, { coaStatus: 'Rejected' })).status).toBe(200);
    expect((await rows(batch))[0].coa_status).toBe('Rejected');
  });

  it('server-controlled fields are refused: dispensedBy, verifiedBy, id, version, dispensedAt', async () => {
    const batch = uniq('B-FORGE');
    for (const extra of [{ dispensedBy: 'usr-qa' }, { verifiedBy: 'usr-qa' }, { id: 'BM-FORGED' }, { version: 3 }, { dispensedAt: '2020-01-01T00:00:00Z' }]) {
      expect((await dispense(batch, extra)).status, JSON.stringify(extra)).toBe(400);
    }
    expect(await rows(batch)).toHaveLength(0);
  });
});

describe('the verifier must be someone else', () => {
  it('verifier == dispenser returns 403, even with the right password, and nothing is recorded', async () => {
    const batch = uniq('B-SELF');
    const res = await dispense(batch, { verifier: verifierOf('analyst1@gxp.com') });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect(await rows(batch)).toHaveLength(0);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'BatchMaterial' AND new_value LIKE $1`, [`%${batch}%`])).n).toBe(0);
  });

  it('the same person written differently (upper case, spaces) is still the dispenser; a wrong password is not asked about', async () => {
    const batch = uniq('B-SELF2');
    const res = await dispense(batch, { verifier: verifierOf('  Analyst1@GXP.com ', { password: 'wrong-password' }) });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst1'`)).failed_attempts).toBe(0);
  });

  it('the refusal is a security event of the signed-in user', async () => {
    const before = (await one(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = 'usr-analyst2'`)).n;
    await dispense(uniq('B-SELF3'), { verifier: verifierOf('analyst2@gxp.com') }, 'analyst2');
    expect((await one(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = 'usr-analyst2'`)).n).toBe(before + 1);
  });

  it('the verifier\'s wrong password is 401, counted against the verifier and audited; the dispenser is not counted; nothing is recorded', async () => {
    const batch = uniq('B-WRONG');
    const res = await dispense(batch, { verifier: verifierOf('reviewer@gxp.com', { password: 'wrong-password' }) });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(await rows(batch)).toHaveLength(0);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-reviewer'`)).n).toBeGreaterThanOrEqual(1);
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst1'`)).failed_attempts).toBe(0);
    expect((await dispense(uniq('B-RIGHT'))).status).toBe(200); // the right password clears the count
  });

  it('an unknown verifier is 401 with the same message as a wrong password (no list of accounts)', async () => {
    const unknown = await dispense(uniq('B-UNK'), { verifier: verifierOf('nobody@gxp.com') });
    const wrong = await dispense(uniq('B-WRONG2'), { verifier: verifierOf('qa@gxp.com', { password: 'wrong-password' }) });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.split('.')[0]).toBe(wrong.body.error.split('.')[0]);
    expect((await dispense(uniq('B-RIGHT2'), { verifier: verifierOf('qa@gxp.com') })).status).toBe(200);
  });

  it('an Analyst cannot verify (403): the VERIFICATION meaning is for Reviewer, QA and Admin', async () => {
    const batch = uniq('B-ANALYST');
    const res = await dispense(batch, { verifier: verifierOf('analyst2@gxp.com') });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await rows(batch)).toHaveLength(0);
  });

  it('a verifier object with extra keys, or whose password is not a string, is 400', async () => {
    expect((await dispense(uniq('B-X'), { verifier: { ...verifierOf('qa@gxp.com'), role: 'QA' } })).status).toBe(400);
    expect((await dispense(uniq('B-Y'), { verifier: { email: 'qa@gxp.com', password: 123 } })).status).toBe(400);
    expect((await dispense(uniq('B-Z'), { verifier: 'qa@gxp.com' })).status).toBe(400);
  });
});

describe('the code has no stand-in values', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes/traceability.ts'), 'utf8');
  const screen = fs.readFileSync(path.resolve(__dirname, '../../src/components/Traceability.tsx'), 'utf8');

  it('the route does not default a material value or the verifier', () => {
    for (const literal of ["'100.00 %'", "'0.50 %'", "'Approved Manufacturer'", "|| 'Excipient'", 'verifiedBy: user.id']) {
      expect(route, literal).not.toContain(literal);
    }
    // 'Verified Pass' is one word of the CoA vocabulary the schema accepts; it must never be a fallback value.
    expect(route).not.toMatch(/(\|\||\?\?|coaStatus:)\s*'Verified Pass'/);
  });

  it('the screen asks for every value instead of sending a preset (CoA status, manufacturer, assay, LOD, material category) and for the verifier', () => {
    expect(screen).not.toMatch(/coaStatus:\s*'Verified Pass'/);
    expect(screen).not.toContain("potencyAssay: '99.8 %'");
    expect(screen).not.toContain("lossOnDrying: '0.20 %'");
    expect(screen).not.toMatch(/materialType:\s*'API/);
    for (const field of ['manufacturer', 'coaStatus', 'potencyAssay', 'lossOnDrying']) expect(screen, field).toMatch(new RegExp(`newMaterial\\.${field}`));
    expect(screen).toMatch(/verifier/i);
  });
});
