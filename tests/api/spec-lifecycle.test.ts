/**
 * Roadmap M11 (r1-spec): the specification lifecycle over HTTP, against the real application and PostgreSQL.
 *
 *   create / revise     a Draft with an author; a new revision clones the Active one; the revision number is the server's
 *   edit                parameters and effective date on a Draft; the OCC counter (version) moves, the revision does not
 *   approve             signRecord (SPECIFICATION_APPROVAL); the author may not approve; QA or Admin with training only; the old
 *                       revision is superseded in the same transaction; samples in progress block it unless QA signs an exception
 *   effective date      a future-dated revision does not replace the current one before its date
 *
 * The route table of src/server/authz/routeTable.ts has to list the body keys of the two routes as this track defines them (the
 * table belongs to r1-authz: docs/changes/r1-spec.gate.patch). Until the gate applies it, `openRouteTable()` sets those two entries
 * to what the patch sets, so the tests exercise the routes as they will be; tests/api/spec-route-table.test.ts fails while the
 * table is not patched.
 */
import { generateSync } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { race, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;

const pad = (n: number) => String(n).padStart(2, '0');
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const P = (over: Record<string, unknown> = {}) => ({ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, ...over });

async function openRouteTable() {
  const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
  const v = await import('../../src/lib/validations/specifications');
  const rules = ROUTE_RULES as Record<string, { body?: unknown }>;
  if ((v as any).specificationUpdateSchema) rules['PUT /specifications/:id'].body = (v as any).specificationUpdateSchema;
  if ((v as any).specificationApproveSchema) rules['POST /specifications/:id/approve'].body = (v as any).specificationApproveSchema;
}

let userSeq = 0;
async function newUser(role: string, over: { trained?: boolean } = {}) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++userSeq;
  const id = `usr-sp${process.pid}-${n}`;
  const email = `sp${process.pid}.${n}@gxp.test`;
  await sql(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `uid-${id}`, `Spec ${role} ${n}`, role, email, generatePasswordHash(TEST_PASSWORD), over.trained ?? true],
  );
  return { id, email, auth: await t.auth(email) };
}

beforeAll(async () => {
  t = await startTestApp();
  await openRouteTable();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});

const create = (by: string | { auth: any }, body: Record<string, unknown>) => t.request.post('/api/specifications').set(typeof by === 'string' ? H[by] : by.auth).send(body);
const edit = (by: string, spec: { id: string; version: number }, body: Record<string, unknown>) => t.request.put(`/api/specifications/${spec.id}`).set(H[by]).send({ expectedVersion: spec.version, ...body });
const approve = (by: string | { auth: any }, spec: { id: string; version: number }, body: Record<string, unknown> = {}) =>
  t.request.post(`/api/specifications/${spec.id}/approve`).set(typeof by === 'string' ? H[by] : by.auth).send({ password: TEST_PASSWORD, expectedVersion: spec.version, ...body });
const row = async (id: string) => (await sql('SELECT * FROM specifications WHERE id = $1', [id]))[0];
const fresh = async (id: string) => { const r = await row(id); return { id, version: r.version as number }; };
const auditOf = (id: string) => sql(`SELECT action, field, old_value, new_value, reason, user_id FROM audit_trail WHERE entity = 'Specification' AND entity_id = $1 ORDER BY sequence`, [id]);

/** A first revision, made and approved through the API (analyst1 writes it, QA approves). */
async function firstRevision(material: string, params: unknown[] = [P()], date = day(0)) {
  const c = await create('analyst1', { material, effectiveDate: date });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const e = await edit('analyst1', c.body, { parameters: params });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  const a = await approve('qa', e.body);
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return fresh(c.body.id);
}
/** A new Draft revision of an Active one. */
async function revise(fromId: string, material: string, date = day(0), by = 'analyst1') {
  const c = await create(by, { material, effectiveDate: date, reviseFrom: fromId });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body as { id: string; version: number; revisionLabel: number };
}

describe('creating', () => {
  it('makes a Draft with revision 1, version 1, its author and a Create audit entry', async () => {
    const material = uniq('Create');
    const res = await create('analyst1', { material, effectiveDate: day(3) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ material, status: 'Draft', version: 1, revisionLabel: 1, effectiveDate: day(3), createdBy: 'usr-analyst1', approvedBy: null, parameters: [] });
    expect(await auditOf(res.body.id)).toEqual([expect.objectContaining({ action: 'Create', user_id: 'usr-analyst1' })]);
  });

  it('takes no field the server controls: version, revision, author, status are a 400 and nothing is written', async () => {
    const material = uniq('Strict');
    for (const extra of [{ version: 5 }, { revisionLabel: 9 }, { revision_label: 9 }, { createdBy: 'usr-qa' }, { status: 'Active' }, { id: 'SPEC-X' }]) {
      const res = await create('analyst1', { material, effectiveDate: day(0), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error).toContain(Object.keys(extra)[0]);
    }
    expect(await sql('SELECT 1 FROM specifications WHERE material = $1', [material])).toHaveLength(0);
  });

  it('refuses an effective date that is not a real date', async () => {
    for (const bad of ['tomorrow', '2026-02-30', '31/12/2026']) {
      expect((await create('analyst1', { material: uniq('Bad'), effectiveDate: bad })).status, bad).toBe(400);
    }
  });

  it('refuses a second specification of a material that already has an Active one, unless it is a revision of it', async () => {
    const material = uniq('Revise');
    const a = await firstRevision(material);
    const res = await create('analyst1', { material, effectiveDate: day(0) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEC_REVISE_REQUIRED');
    expect(res.body.error).toContain(a.id);
    expect(await sql('SELECT 1 FROM specifications WHERE material = $1', [material])).toHaveLength(1);
  });

  it('refuses a spelling that differs from an existing material only in case or spacing', async () => {
    const material = uniq('Spelling');
    await firstRevision(material);
    for (const other of [material.toUpperCase(), `  ${material.toLowerCase()} `]) {
      const res = await create('analyst1', { material: other, effectiveDate: day(0) });
      expect(res.status, other).toBe(409);
      expect(res.body.code, other).toBe('SPEC_MATERIAL_SPELLING');
      expect(res.body.error).toContain(material);
    }
  });

  it('clones the Active revision into a new Draft: revision + 1, the same limits, the new author', async () => {
    const material = uniq('Clone');
    const a = await firstRevision(material, [P(), P({ name: 'Impurity (%)', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2 })]);
    const d = await revise(a.id, material, day(1), 'analyst2');
    expect(d).toMatchObject({ status: 'Draft', version: 1, revisionLabel: 2, createdBy: 'usr-analyst2', effectiveDate: day(1) });
    const parent = await row(a.id);
    const child = await row(d.id);
    expect(child.parameters).toEqual(parent.parameters);
    expect(child.parameters).toHaveLength(2);
    expect((await row(a.id)).status).toBe('Active'); // the Active one is untouched until the clone is approved
  });

  it('refuses to revise a Draft, a specification of another material, or one that does not exist', async () => {
    const material = uniq('BadRevise');
    const a = await firstRevision(material);
    const draft = await revise(a.id, material);
    const other = await firstRevision(uniq('Other'));
    expect((await create('analyst1', { material, effectiveDate: day(0), reviseFrom: draft.id })).status).toBe(409); // a Draft already exists, and it is not a source
    expect((await create('analyst1', { material: uniq('X'), effectiveDate: day(0), reviseFrom: other.id })).status).toBe(409);
    expect((await create('analyst1', { material, effectiveDate: day(0), reviseFrom: 'SPEC-NOPE' })).status).toBe(404);
  });

  it('allows one open Draft per material: five simultaneous requests give one Draft and four conflicts', async () => {
    const material = uniq('Race');
    const a = await firstRevision(material);
    const statuses = await race(5, () => create('analyst1', { material, effectiveDate: day(0), reviseFrom: a.id }));
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(await sql(`SELECT revision_label FROM specifications WHERE material = $1 ORDER BY revision_label`, [material])).toEqual([{ revision_label: 1 }, { revision_label: 2 }]);
  });

  it('numbers the first revisions of new materials created at once 1 each, and never repeats a number within a material', async () => {
    const material = uniq('RaceNew');
    const statuses = await race(5, () => create('analyst1', { material, effectiveDate: day(0) }));
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(await sql(`SELECT revision_label FROM specifications WHERE material = $1`, [material])).toEqual([{ revision_label: 1 }]);
  });
});

describe('editing a Draft', () => {
  it('three edits then the approval: the revision is previous + 1 while the version counts every write', async () => {
    const material = uniq('ThreeEdits');
    const a = await firstRevision(material);
    expect((await row(a.id)).revision_label).toBe(1);
    const d = await revise(a.id, material);
    let spec: { id: string; version: number } = { id: d.id, version: d.version };
    for (const upper of [101, 103, 104]) {
      const res = await edit('analyst1', spec, { parameters: [P({ upper })] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.version).toBe(spec.version + 1);
      expect(res.body.revisionLabel).toBe(2);
      spec = { id: d.id, version: res.body.version };
    }
    expect(spec.version).toBe(4);
    const ap = await approve('qa', spec);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const r = await row(d.id);
    expect({ status: r.status, revision: r.revision_label, version: r.version }).toEqual({ status: 'Active', revision: 2, version: 5 });
    const prev = await row(a.id);
    expect({ status: prev.status, revision: prev.revision_label }).toEqual({ status: 'Obsolete', revision: 1 });
  });

  it('writes one Update audit entry per edit with the old and the new limits, in the same transaction (a conflict writes none)', async () => {
    const d = await create('analyst1', { material: uniq('Audit'), effectiveDate: day(0) });
    const ok = await edit('analyst1', d.body, { parameters: [P()] });
    expect(ok.status).toBe(200);
    const entries = await auditOf(d.body.id);
    expect(entries.map(e => e.action)).toEqual(['Create', 'Update']);
    expect(entries[1]).toMatchObject({ field: 'parameters', user_id: 'usr-analyst1' });
    expect(JSON.parse(entries[1].old_value)).toEqual([]);
    expect(JSON.parse(entries[1].new_value)[0]).toMatchObject({ name: 'Assay (%)', limit_kind: 'RANGE', lower: 98, upper: 102 });
    const stale = await edit('analyst1', d.body, { parameters: [P({ upper: 110 })] }); // still version 1
    expect(stale.status).toBe(409);
    expect(await auditOf(d.body.id)).toHaveLength(2);
    expect((await row(d.body.id)).parameters[0].upper).toBe(102);
  });

  it('stores the limits in the new shape with min and max beside them for readers that know only those', async () => {
    const d = await create('analyst1', { material: uniq('Mirror'), effectiveDate: day(0) });
    await edit('analyst1', d.body, { parameters: [P(), P({ name: 'Total', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 1 }), P({ name: 'Min', limit_kind: 'NLT', lower: 95, upper: null, decimals: 0 })] });
    const stored = (await row(d.body.id)).parameters;
    expect(stored.map((p: any) => [p.limit_kind, p.lower, p.upper, p.min, p.max])).toEqual([['RANGE', 98, 102, 98, 102], ['NMT', null, 0.5, null, 0.5], ['NLT', 95, null, 95, null]]);
  });

  it('changes the effective date of a Draft on its own, and audits it', async () => {
    const d = await create('analyst1', { material: uniq('Date'), effectiveDate: day(-5) });
    const res = await edit('analyst1', d.body, { effectiveDate: day(7) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ effectiveDate: day(7), version: 2 });
    expect((await auditOf(d.body.id)).at(-1)).toMatchObject({ action: 'Update', field: 'effective_date', old_value: day(-5), new_value: day(7) });
  });

  describe('refuses what a laboratory cannot test against, with a 400 that names the parameter and writes nothing', () => {
    const cases: Array<[string, unknown[], RegExp]> = [
      ['a lower limit above the upper limit', [P({ lower: 105, upper: 98 })], /lower limit .* above .*upper/i],
      ['two parameters of one name', [P(), P({ name: ' assay (%) ' })], /duplicate parameter name/i],
      ['an empty name', [P({ name: '' })], /name is required/i],
      ['a numeric limit with no decimals', [P({ decimals: null })], /decimals .*required/i],
      ['a limit with more decimals than declared', [P({ lower: 98.05 })], /more decimals than/i],
      ['an unknown kind', [P({ limit_kind: 'ABOUT' })], /./],
      ['the old min and max shape', [{ name: 'Assay', min: 98, max: 102 }], /./],
      ['an unknown key', [P({ note: 'x' })], /note/],
    ];
    it.each(cases)('%s', async (_name, parameters, message) => {
      const d = await create('analyst1', { material: uniq('Invalid'), effectiveDate: day(0) });
      const res = await edit('analyst1', d.body, { parameters });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toMatch(message);
      expect(await auditOf(d.body.id)).toHaveLength(1);
      expect((await row(d.body.id)).version).toBe(1);
    });
  });

  it('refuses a body with nothing to change, and the keys the server controls', async () => {
    const d = await create('analyst1', { material: uniq('Keys'), effectiveDate: day(0) });
    expect((await edit('analyst1', d.body, {})).status).toBe(400);
    for (const extra of [{ status: 'Active' }, { revisionLabel: 7 }, { createdBy: 'usr-qa' }, { version: 9 }]) {
      expect((await edit('analyst1', d.body, { parameters: [], ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('an Active specification is locked (423): it is replaced by a revision, not edited', async () => {
    const a = await firstRevision(uniq('Locked'));
    const res = await edit('analyst1', a, { parameters: [P({ upper: 150 })] });
    expect(res.status).toBe(423);
    expect((await row(a.id)).parameters[0].upper).toBe(102);
  });

  it('simultaneous edits with one version: one wins, the others get 409', async () => {
    const d = await create('analyst1', { material: uniq('OCC'), effectiveDate: day(0) });
    const statuses = await race(5, () => edit('analyst1', d.body, { parameters: [P()] }));
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect((await row(d.body.id)).version).toBe(2);
  });
});

describe('approving', () => {
  it('the author cannot approve their own Draft: 403, and nothing changes', async () => {
    const d = await create('qa', { material: uniq('Own'), effectiveDate: day(0) });
    const e = await edit('qa', d.body, { parameters: [P()] });
    const res = await approve('qa', e.body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect((await row(d.body.id)).status).toBe('Draft');
    expect(await sql(`SELECT 1 FROM signatures WHERE entity_type = 'Specification' AND entity_id = $1`, [d.body.id])).toHaveLength(0);
  });

  it('the recorded author counts even where the audit trail names nobody (the check does not rest on the trail alone)', async () => {
    const id = uniq('SPEC-OWN');
    await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters, created_by) VALUES ($1, $2, 1, $3, 'Draft', $4::jsonb, 'usr-qa')`,
      [id, uniq('NoTrail'), day(0), JSON.stringify([P()])]);
    const res = await approve('qa', { id, version: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect((await row(id)).status).toBe('Draft');
    // The refusal is a security event, like every other independence refusal, and it cost the signer no password attempt.
    const events = await sql(`SELECT actor_id FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND detail::jsonb->>'entityId' = $1`, [id]);
    expect(events).toEqual([{ actor_id: 'usr-qa' }]);
    expect(await sql(`SELECT 1 FROM audit_trail WHERE action = 'SignatureFailed' AND entity_id = $1`, [id])).toHaveLength(0);
  });

  it('an Analyst or a Reviewer cannot approve at all', async () => {
    const d = await create('analyst1', { material: uniq('Role'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    for (const by of ['analyst2', 'reviewer']) {
      const res = await approve(by, e.body);
      expect(res.status, by).toBe(403);
      expect(res.body.code, by).toBe('PERMISSION_DENIED');
    }
    expect((await row(d.body.id)).status).toBe('Draft');
  });

  it('QA with the software training approves: 200, a Specification signature row, the approver recorded, one Approve audit entry', async () => {
    const d = await create('analyst1', { material: uniq('Approve'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    const res = await approve('qa', e.body, { reason: 'Limits agree with the monograph' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: d.body.id, status: 'Active', revisionLabel: 1, approvedBy: 'usr-qa', version: 3 });
    expect(res.body.signature).toMatchObject({ meaningCode: 'SPECIFICATION_APPROVAL', signerId: 'usr-qa', recordVersion: 3 });
    // No credential comes back. (Keys, not text: the signature's authMethod is the word "password", which is also the test password.)
    expect(JSON.stringify(res.body)).not.toMatch(/"(password|passwordHash|password_hash|totpCode|totpSecret|totp_secret)"\s*:/i);

    const sigs = await sql(`SELECT * FROM signatures WHERE entity_type = 'Specification' AND entity_id = $1`, [d.body.id]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({
      meaning_code: 'SPECIFICATION_APPROVAL', signer_id: 'usr-qa', signer_role: 'QA', sample_id: null, record_version: 3, hash_version: 2, auth_method: 'password',
      reason: 'Limits agree with the monograph',
    });
    const [entry] = await sql('SELECT action, entity, entity_id, field, old_value, new_value FROM audit_trail WHERE id = $1', [sigs[0].audit_entry_id]);
    expect(entry).toEqual({ action: 'Approve', entity: 'Specification', entity_id: d.body.id, field: 'status', old_value: 'Draft', new_value: 'Active' });
    expect((await row(d.body.id)).approved_by).toBe('usr-qa');

    const verify = await t.request.get(`/api/signatures/verify/${sigs[0].id}`).set(H.qa);
    expect(verify.body).toMatchObject({ valid: true, status: 'valid', contentHashMatches: true, chainIntact: true });
  });

  it('the signature covers the limits: changing them in the database afterwards makes it fail verification', async () => {
    const a = await firstRevision(uniq('Seal'));
    const [sig] = await sql(`SELECT id FROM signatures WHERE entity_type = 'Specification' AND entity_id = $1`, [a.id]);
    await sql(`UPDATE specifications SET parameters = jsonb_set(parameters, '{0,upper}', '999') WHERE id = $1`, [a.id]);
    const verify = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(verify.body).toMatchObject({ valid: false, status: 'record-modified', contentHashMatches: false });
  });

  it('an Admin who did not write it may approve as well', async () => {
    const d = await create('qa', { material: uniq('Admin'), effectiveDate: day(0) });
    const e = await edit('qa', d.body, { parameters: [P()] });
    const res = await approve('admin', e.body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.approvedBy).toBe('usr-admin');
  });

  it('refuses a signer without the software training (403), leaving the Draft and no signature', async () => {
    const untrained = await newUser('QA', { trained: false });
    const d = await create('analyst1', { material: uniq('Untrained'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    const res = await approve(untrained, e.body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TRAINING_REQUIRED');
    expect((await row(d.body.id)).status).toBe('Draft');
    expect(await sql(`SELECT 1 FROM signatures WHERE entity_id = $1`, [d.body.id])).toHaveLength(0);
  });

  it('three wrong passwords leave three SignatureFailed entries and a lock that survives; the Draft stays a Draft', async () => {
    const qa = await newUser('QA');
    const d = await create('analyst1', { material: uniq('Wrong'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    for (let i = 0; i < 3; i++) {
      const res = await approve(qa, e.body, { password: 'not-the-password' });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body.code).toBe('INVALID_PASSWORD');
    }
    expect(await sql(`SELECT 1 FROM audit_trail WHERE action = 'SignatureFailed' AND entity_id = $1 AND user_id = $2`, [d.body.id, qa.id])).toHaveLength(3);
    const locked = await approve(qa, e.body);
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('SIGNING_LOCKED');
    expect((await row(d.body.id)).status).toBe('Draft');
  });

  it('a signer with an authenticator needs the code; the code is stored as the method', async () => {
    const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const qa = await newUser('QA');
    await sql('UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = $2', [SECRET, qa.id]); // after the sign-in, which would have asked for it
    const d = await create('analyst1', { material: uniq('Totp'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    const without = await approve(qa, e.body);
    expect(without.status).toBe(401);
    expect(without.body.code).toBe('MFA_CODE_REQUIRED');
    const ok = await approve(qa, e.body, { totpCode: generateSync({ secret: SECRET, epoch: Math.floor(Date.now() / 1000) }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await sql(`SELECT auth_method FROM signatures WHERE entity_id = $1`, [d.body.id]))[0].auth_method).toBe('password+totp');
  });

  it('refuses the version the approver did not see: 409, nothing signed, nothing changed', async () => {
    const d = await create('analyst1', { material: uniq('Stale'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] }); // version 2
    await edit('analyst1', e.body, { parameters: [P({ upper: 103 })] }); // version 3, after the approver looked
    const res = await approve('qa', e.body); // signs version 2
    expect(res.status).toBe(409);
    expect((await row(d.body.id)).status).toBe('Draft');
    expect(await sql(`SELECT 1 FROM signatures WHERE entity_id = $1`, [d.body.id])).toHaveLength(0);
    expect((await auditOf(d.body.id)).map(a => a.action)).not.toContain('Approve');
  });

  it('refuses a Draft that has no parameters, naming what is missing', async () => {
    const d = await create('analyst1', { material: uniq('Empty'), effectiveDate: day(0) });
    const res = await approve('qa', d.body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPEC_INCOMPLETE');
    expect(res.body.error).toMatch(/at least one parameter/i);
    expect((await row(d.body.id)).status).toBe('Draft');
  });

  it('refuses stored limits that no longer pass the schema (a clone of a v0.1.0 specification has no decimals), until they are declared', async () => {
    const material = uniq('Legacy');
    const old = uniq('SPEC-LEGACY');
    await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', 'Active', '[{"name":"Assay","min":98,"max":102}]'::jsonb)`, [old, material]);
    const d = await revise(old, material);
    expect((await row(d.id)).parameters[0]).toMatchObject({ name: 'Assay', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: null });
    const refused = await approve('qa', { id: d.id, version: d.version });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/Assay.*decimals/i);
    const fixed = await edit('analyst1', d, { parameters: [P({ name: 'Assay', unit: '', decimals: 1 })] });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((await approve('qa', fixed.body)).status).toBe(200);
  });

  it('refuses an effective date in the past (it would make the revision effective for days when the old one was in use); the author can correct it', async () => {
    const d = await create('analyst1', { material: uniq('Past'), effectiveDate: day(-1) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    const res = await approve('qa', e.body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPEC_EFFECTIVE_DATE_PAST');
    const fixed = await edit('analyst1', e.body, { effectiveDate: day(0) });
    expect((await approve('qa', fixed.body)).status).toBe(200);
  });

  it('supersedes the revision it replaces in the same transaction: the old one is Obsolete, audited, and no longer selectable', async () => {
    const material = uniq('Supersede');
    const a = await firstRevision(material);
    const d = await revise(a.id, material);
    const e = await edit('analyst1', d, { parameters: [P({ upper: 103 })] });
    const res = await approve('qa', e.body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const prev = await row(a.id);
    expect(prev).toMatchObject({ status: 'Obsolete', version: a.version + 1 });
    const trail = await auditOf(a.id);
    expect(trail.at(-1)).toMatchObject({ action: 'StatusChange', field: 'status', old_value: 'Active', new_value: 'Obsolete', user_id: 'usr-qa' });
    expect(trail.at(-1)!.reason).toContain('revision 2');
    expect((await sql(`SELECT count(*)::int AS n FROM specifications WHERE material = $1 AND status = 'Active'`, [material]))[0].n).toBe(1);
    // The superseded revision is final: it cannot be edited or approved again.
    expect((await edit('analyst1', { id: a.id, version: prev.version }, { parameters: [] })).status).toBe(423);
    expect((await approve('admin', { id: a.id, version: prev.version })).status).toBe(423);
  });

  it('approves nothing twice: five simultaneous approvals give one signature and four refusals', async () => {
    const d = await create('analyst1', { material: uniq('Twice'), effectiveDate: day(0) });
    const e = await edit('analyst1', d.body, { parameters: [P()] });
    const statuses = await race(5, () => approve('qa', e.body));
    expect(statuses.filter(s => s === 200)).toHaveLength(1);
    expect(statuses.filter(s => s !== 200).every(s => s === 409 || s === 423)).toBe(true);
    expect(await sql(`SELECT 1 FROM signatures WHERE entity_type = 'Specification' AND entity_id = $1`, [d.body.id])).toHaveLength(1);
  });

  it('is one transaction: when the signature cannot be written, the approval, the supersession and their audit entries are all gone', async () => {
    const material = uniq('Atomic');
    const old = uniq('SPEC-ATOM-OLD');
    const draft = uniq('SPEC-ATOM-NEW');
    await sql(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters, created_by)
               VALUES ($1, $3, 1, 1, '2026-01-01', 'Active', $4::jsonb, 'usr-analyst1'), ($2, $3, 1, 2, $5, 'Draft', $4::jsonb, 'usr-analyst1')`,
      [old, draft, material, JSON.stringify([P()]), day(0)]);
    await sql(`CREATE FUNCTION spec_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '${draft}' THEN RAISE EXCEPTION 'spec test: signature refused'; END IF; RETURN NEW; END $$`);
    await sql(`CREATE TRIGGER spec_test_refuse BEFORE INSERT ON signatures FOR EACH ROW EXECUTE FUNCTION spec_test_refuse()`);
    try {
      const auditBefore = (await sql('SELECT count(*)::int AS n FROM audit_trail'))[0].n;
      const res = await approve('qa', { id: draft, version: 1 });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(await row(draft)).toMatchObject({ status: 'Draft', version: 1, approved_by: null });
      expect(await row(old)).toMatchObject({ status: 'Active', version: 1 });
      expect((await sql('SELECT count(*)::int AS n FROM audit_trail'))[0].n).toBe(auditBefore);
    } finally {
      await sql('DROP TRIGGER spec_test_refuse ON signatures');
      await sql('DROP FUNCTION spec_test_refuse()');
    }
  });
});

describe('the effective date', () => {
  it('a revision dated in the future is approved but does not replace the current one before its date', async () => {
    const material = uniq('Future');
    const a = await firstRevision(material);
    const d = await revise(a.id, material, day(10));
    const e = await edit('analyst1', d, { parameters: [P({ upper: 104 })] });
    const res = await approve('qa', e.body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(d.id)).status).toBe('Active');
    expect((await row(a.id)).status).toBe('Active'); // still the one in use
    const list = (await t.request.get('/api/specifications').set(H.analyst1)).body as Array<{ id: string; effectiveness: string }>;
    expect(list.find(s => s.id === d.id)?.effectiveness).toBe('Scheduled');
    expect(list.find(s => s.id === a.id)?.effectiveness).toBe('Effective');
  });

  it('refuses a revision dated before one that is already scheduled (the older one would take over on its date): 409, nothing changes', async () => {
    const material = uniq('Overtaken');
    const a = await firstRevision(material);
    const r2 = await revise(a.id, material, day(10));
    const e2 = await edit('analyst1', r2, { parameters: [P({ upper: 104 })] });
    expect((await approve('qa', e2.body)).status).toBe(200); // revision 2 scheduled for day +10
    const r3 = await revise(a.id, material, day(0));
    const e3 = await edit('analyst1', r3, { parameters: [P({ upper: 103 })] });
    const res = await approve('qa', e3.body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEC_LATER_REVISION_SCHEDULED');
    expect(res.body.error).toContain(day(10));
    expect((await row(r3.id)).status).toBe('Draft');
    expect((await row(a.id)).status).toBe('Active');
    // Dated on or after the scheduled one, it is approvable.
    const later = await edit('analyst1', e3.body, { effectiveDate: day(10) });
    expect((await approve('qa', later.body)).status).toBe(200);
  });

  it('a revision effective today supersedes the earlier ones, and the list says so', async () => {
    const material = uniq('Today');
    const a = await firstRevision(material);
    const d = await revise(a.id, material);
    const e = await edit('analyst1', d, { parameters: [P({ upper: 105 })] });
    await approve('qa', e.body);
    const list = (await t.request.get('/api/specifications').set(H.analyst1)).body as Array<{ id: string; effectiveness: string; status: string }>;
    expect(list.find(s => s.id === d.id)?.effectiveness).toBe('Effective');
    expect(list.find(s => s.id === a.id)).toMatchObject({ status: 'Obsolete', effectiveness: 'Superseded' });
  });
});

describe('samples in progress', () => {
  const sample = (material: string, state: string) => sql(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ($1, $2, $3, $4, 'usr-analyst1')`, [uniq('SMP-SP'), material, uniq('B'), state]);
  async function pending(material: string) {
    const a = await firstRevision(material);
    const d = await revise(a.id, material);
    const e = await edit('analyst1', d, { parameters: [P({ upper: 103 })] });
    return { a, d, e: e.body as { id: string; version: number } };
  }

  it('blocks the supersession while samples of the material are Logged or Testing: 409, and the list says how many beforehand', async () => {
    const material = uniq('InFlight');
    await sample(material, 'Logged'); await sample(material, 'Testing'); await sample(material, 'Approved');
    const { a, e } = await pending(material);
    const list = (await t.request.get('/api/specifications').set(H.qa)).body as Array<{ id: string; approval?: { supersedes: string[]; samplesInProgress: number } }>;
    expect(list.find(s => s.id === e.id)?.approval).toEqual({ supersedes: [a.id], samplesInProgress: 2 });
    const res = await approve('qa', e);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEC_SAMPLES_IN_PROGRESS');
    expect(res.body.details).toMatchObject({ samplesInProgress: 2 });
    expect((await row(e.id)).status).toBe('Draft');
    expect((await row(a.id)).status).toBe('Active');
  });

  it('QA can sign an exception with a reason; it is part of the signature and the audit entry', async () => {
    const material = uniq('Exception');
    await sample(material, 'Testing');
    const { a, e } = await pending(material);
    const res = await approve('qa', e, { exceptionReason: 'SMP in progress will be finished on the old limits' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(a.id)).status).toBe('Obsolete');
    const [sig] = await sql(`SELECT reason, audit_entry_id FROM signatures WHERE entity_id = $1`, [e.id]);
    expect(sig.reason).toContain('SMP in progress will be finished on the old limits');
    expect(sig.reason).toMatch(/exception/i);
    const [entry] = await sql('SELECT reason FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(entry.reason).toContain('SMP in progress will be finished on the old limits');
  });

  it('an exception from an Administrator is refused (the quality unit decides), and one with nothing to except is refused too', async () => {
    const material = uniq('ExceptionRole');
    await sample(material, 'Logged');
    const { e } = await pending(material);
    const byAdmin = await approve('admin', e, { exceptionReason: 'Samples finish on the old limits' });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.code).toBe('SPEC_EXCEPTION_ROLE');
    expect((await row(e.id)).status).toBe('Draft');

    const material2 = uniq('ExceptionNone');
    const p2 = await pending(material2);
    const none = await approve('qa', p2.e, { exceptionReason: 'There is nothing in progress, really' });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('SPEC_EXCEPTION_NOT_NEEDED');
    expect((await row(p2.e.id)).status).toBe('Draft');
  });

  it('does not block the first approval of a material, or a revision dated in the future (nothing is superseded yet)', async () => {
    const material = uniq('NoBlock');
    await sample(material, 'Logged');
    const first = await firstRevision(material); // no revision to replace
    expect((await row(first.id)).status).toBe('Active');
    const d = await revise(first.id, material, day(5));
    const e = await edit('analyst1', d, { parameters: [P({ upper: 104 })] });
    expect((await approve('qa', e.body)).status).toBe(200);
    expect((await row(first.id)).status).toBe('Active');
  });
});

describe('what the rest of the application still reads', () => {
  it('lists specifications with the revision, author and approver names, the limits in the new shape, and no secret', async () => {
    const a = await firstRevision(uniq('List'));
    const list = (await t.request.get('/api/specifications').set(H.reviewer)).body as any[];
    const mine = list.find(s => s.id === a.id);
    expect(mine).toMatchObject({ status: 'Active', revisionLabel: 1, createdBy: 'usr-analyst1', createdByName: 'Test Analyst One', approvedBy: 'usr-qa', approvedByName: 'Test QA Officer', effectiveness: 'Effective' });
    expect(mine.parameters[0]).toEqual({ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null });
  });

  it('shows the limits of a specification v0.1.0 stored as limits of the new kinds', async () => {
    const id = uniq('SPEC-OLDSHAPE');
    await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', 'Active', '[{"name":"pH","min":5,"max":7.5,"unit":""}]'::jsonb)`, [id, uniq('OldShape')]);
    const mine = ((await t.request.get('/api/specifications').set(H.reviewer)).body as any[]).find(s => s.id === id);
    expect(mine.parameters).toEqual([{ name: 'pH', unit: '', limit_kind: 'RANGE', lower: 5, upper: 7.5, decimals: null, text: null }]);
  });

  it('registering a sample against an approved revision still seeds each result with its limits', async () => {
    const material = uniq('Register');
    await firstRevision(material, [P(), P({ name: 'Total', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 1 })]);
    const res = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const results = await sql(`SELECT parameter, spec_min, spec_max FROM results WHERE sample_id = $1 ORDER BY parameter`, [res.body.id]);
    expect(results).toEqual([{ parameter: 'Assay (%)', spec_min: 98, spec_max: 102 }, { parameter: 'Total', spec_min: null, spec_max: 0.5 }]);
  });
});
