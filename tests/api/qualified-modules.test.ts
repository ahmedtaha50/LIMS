/**
 * Roadmap M37 (r2-validation): the validated-scope register.
 *
 * Before: DEV-2026-10-13-04 said the non-core modules (ELN, OOS, stability, EM, reagents, ...) have no operational qualification and
 * should be qualified or blocked; nothing in the application could block them or say which module is qualified.
 *
 * After: QA declares a module Qualified or NotQualified with an e-signature (MODULE_QUALIFICATION) bound to the record version, in
 * one transaction with its audit entry. Writes to a NotQualified module answer 403 MODULE_NOT_QUALIFIED and are recorded as a
 * security event; reads still work, other modules and the core are untouched.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { race, uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst1: await t.auth('analyst1@gxp.com') };
});

const declare = (module: string, body: Record<string, unknown>, who: keyof typeof H = 'qa') =>
  t.request.post(`/api/validation/modules/${module}/status`).set(H[who]).send({ password: 'password', reason: 'OQ executed and accepted', ...body });
const newProduct = () => t.request.post('/api/products').set(H.qa).send({ code: uniq('PRD'), name: uniq('Ibuprofen 400 mg') });
const listed = async (module: string) => (await t.request.get('/api/validation/modules').set(H.analyst1)).body.find((m: any) => m.module === module);

describe('0300_qualified_modules', () => {
  it('creates an empty register, the QA-only meaning and the two permissions', async () => {
    expect(await one('SELECT count(*)::int AS n FROM qualified_modules')).toEqual({ n: 0 });
    expect((await one("SELECT allowed_roles FROM signature_meanings WHERE code = 'MODULE_QUALIFICATION'")).allowed_roles).toEqual(['QA']);
    const rows = await sql("SELECT role_id, permission_code FROM role_permissions WHERE permission_code LIKE 'validation.%'");
    expect(rows.map(r => `${r.role_id}:${r.permission_code}`).sort()).toEqual([
      'role-admin:validation.scope', 'role-admin:validation.view', 'role-analyst:validation.view', 'role-qa:validation.scope', 'role-qa:validation.view', 'role-reviewer:validation.view',
    ]);
  });

  it('refuses a status the application would refuse', async () => {
    await expect(sql("INSERT INTO qualified_modules (id, status, reason, updated_by) VALUES ('oos', 'Maybe', 'valid reason', 'usr-qa')")).rejects.toThrow(/qualified_modules_status_check/);
    await expect(sql("INSERT INTO qualified_modules (id, status, reason, updated_by) VALUES ('oos', 'Qualified', ' ', 'usr-qa')")).rejects.toThrow(/qualified_modules_reason_check/);
  });
});

describe('the catalog', () => {
  it('lists every module as Undeclared with writes allowed, to every role', async () => {
    const res = await t.request.get('/api/validation/modules').set(H.analyst1);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(15);
    for (const m of res.body) expect(m).toMatchObject({ status: 'Undeclared', declared: false, writesAllowed: true, version: 0 });
    expect((await t.request.get('/api/validation/modules')).status).toBe(401);
  });

  it('knows a module for every first path segment of the route table, or names it as core', async () => {
    // A new route module must be put in the catalog or listed here as core: this is the decision the register forces.
    const CORE = new Set(['admin', 'api-clients', 'attachments', 'audit', 'auth', 'dashboard', 'directory', 'event-deliveries', 'event-subscriptions', 'health', 'inbox', 'lists', 'lookup', 'me', 'metrics',
      'notifications', 'permissions', 'ready', 'resolve', 'result-versions', 'samples', 'search', 'security-events', 'signatures', 'specifications', 'system', 'traceability', 'validation']);
    const { moduleOfPath } = await import('../../src/server/qualified');
    const routes: Array<{ path: string }> = JSON.parse(readFileSync(join(__dirname, '..', 'route-table.json'), 'utf8')).routes;
    const unknown = new Set<string>();
    for (const r of routes) {
      const path = r.path.replace(/^\/api/, '');
      if (!moduleOfPath(path) && !CORE.has(path.split('/')[1])) unknown.add(path.split('/')[1]);
    }
    expect([...unknown].sort()).toEqual([]);
    expect(moduleOfPath('/batches/PB-1/status')).toBe('master-data');
    expect(moduleOfPath('/samples/SMP-1')).toBeNull();
  });
});

describe('declaring a module (QA e-signature)', () => {
  it('is QA only: the analyst lacks the permission, the Admin is refused by the signature meaning, and no row is written', async () => {
    expect((await declare('oos', { status: 'NotQualified', expectedVersion: 0 }, 'analyst1')).status).toBe(403);
    const admin = await declare('oos', { status: 'NotQualified', expectedVersion: 0 }, 'admin');
    expect(admin.status).toBe(403);
    expect((await one("SELECT count(*)::int AS n FROM qualified_modules WHERE id = 'oos'")).n).toBe(0);
  });

  it('refuses a wrong password (401, nothing written), an unknown module (404) and a body key it does not accept (400)', async () => {
    expect((await declare('oos', { status: 'NotQualified', expectedVersion: 0, password: 'wrong-password' })).status).toBe(401);
    expect((await declare('nonexistent', { status: 'NotQualified', expectedVersion: 0 })).status).toBe(404);
    expect((await declare('oos', { status: 'NotQualified', expectedVersion: 0, version: 5 })).status).toBe(400);
    expect((await declare('oos', { status: 'Maybe', expectedVersion: 0 })).status).toBe(400);
    expect((await one("SELECT count(*)::int AS n FROM qualified_modules WHERE id = 'oos'")).n).toBe(0);
  });

  it('writes the row, the audit entry and a verifiable signature bound to version 1, in one step', async () => {
    const res = await declare('eln', { status: 'NotQualified', expectedVersion: 0, evidenceRef: 'OQ-ELN-001 (planned)' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.module).toMatchObject({ id: 'eln', status: 'NotQualified', version: 1, evidenceRef: 'OQ-ELN-001 (planned)' });
    expect(res.body.signature).toMatchObject({ meaningCode: 'MODULE_QUALIFICATION', recordVersion: 1, signerRole: 'QA', entityType: 'QualifiedModule', entityId: 'eln' });
    const audit = await one("SELECT user_id, action, field, old_value, new_value FROM audit_trail WHERE entity = 'QualifiedModule' AND entity_id = 'eln'");
    expect(audit).toMatchObject({ user_id: 'usr-qa', action: 'ScopeDeclaration', field: 'status', old_value: 'Undeclared', new_value: 'NotQualified' });
    const verify = await t.request.get(`/api/signatures/verify/${res.body.signature.id}`).set(H.qa);
    expect(verify.status).toBe(200);
    expect(verify.body.valid, JSON.stringify(verify.body)).toBe(true);
    expect(await listed('eln')).toMatchObject({ status: 'NotQualified', declared: true, writesAllowed: false, version: 1 });
  });

  it('uses the version predicate: a stale or missing expectedVersion is 409, and the same status again is 409', async () => {
    expect((await declare('eln', { status: 'Qualified', expectedVersion: 0 })).status).toBe(409);
    expect((await declare('eln', { status: 'Qualified', expectedVersion: 7 })).status).toBe(409);
    expect((await declare('eln', { status: 'NotQualified', expectedVersion: 1 })).status).toBe(409);
    expect((await declare('stability', { status: 'Qualified', expectedVersion: 3 })).status).toBe(409);
    expect((await listed('eln')).version).toBe(1);
  });

  it('lets only one of two concurrent declarations with the same version win', async () => {
    const codes = await race(2, () => declare('worklists', { status: 'NotQualified', expectedVersion: 0 }));
    expect(codes).toEqual([200, 409]);
    expect((await one("SELECT version FROM qualified_modules WHERE id = 'worklists'")).version).toBe(1);
    expect((await one("SELECT count(*)::int AS n FROM signatures WHERE entity_type = 'QualifiedModule' AND entity_id = 'worklists'")).n).toBe(1);
  });
});

describe('a NotQualified module', () => {
  it('refuses writes with 403 MODULE_NOT_QUALIFIED, records the refusal, and still serves reads', async () => {
    const res = await declare('master-data', { status: 'NotQualified', expectedVersion: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const refused = await newProduct();
    expect(refused.status).toBe(403);
    expect(refused.body.code ?? refused.body.error?.code).toBe('MODULE_NOT_QUALIFIED');
    expect((await t.request.put('/api/batches/PB-NONE').set(H.qa).send({ expectedVersion: 1 })).status).toBe(403);
    expect((await t.request.get('/api/products').set(H.qa)).status).toBe(200);

    const denied = await one(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = 'usr-qa' AND detail::jsonb->>'module' = 'master-data'`);
    expect(denied.n).toBeGreaterThanOrEqual(2);
  });

  it('leaves other modules and the core alone', async () => {
    const other = await t.request.post('/api/qms/records').set(H.qa).send({});
    expect(other.status, JSON.stringify(other.body)).toBe(400);
    expect((await t.request.post('/api/samples').set(H.analyst1).send({})).status).not.toBe(403);
  });

  it('writes again once QA declares it Qualified (version 2), with a second audit entry and signature', async () => {
    const res = await declare('master-data', { status: 'Qualified', expectedVersion: 1, evidenceRef: 'validation/evidence/r2-master-data.md' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.module.version).toBe(2);
    expect((await newProduct()).status).toBe(200);
    const audit = await sql("SELECT old_value, new_value FROM audit_trail WHERE entity = 'QualifiedModule' AND entity_id = 'master-data' ORDER BY sequence");
    expect(audit).toEqual([{ old_value: 'Undeclared', new_value: 'NotQualified' }, { old_value: 'NotQualified', new_value: 'Qualified' }]);
    expect((await one("SELECT count(*)::int AS n FROM signatures WHERE entity_type = 'QualifiedModule' AND entity_id = 'master-data'")).n).toBe(2);
    expect((await t.request.post('/api/audit/verify').set(H.qa).send({})).body.isValid).toBe(true);
  });

  it('takes effect on the next request without a restart', async () => {
    await declare('methods-calc', { status: 'NotQualified', expectedVersion: 0 });
    expect((await t.request.post('/api/calc/evaluate').set(H.qa).send({})).status).toBe(403);
    await declare('methods-calc', { status: 'Qualified', expectedVersion: 1 });
    expect((await t.request.post('/api/calc/evaluate').set(H.qa).send({})).status).not.toBe(403);
  });
});
