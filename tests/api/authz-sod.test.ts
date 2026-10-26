/**
 * Roadmap M09 (r1-authz): record-level segregation of duties. Approving a specification needs the privilege (an Analyst gets 403)
 * AND independence from the record (a QA officer who authored or edited the draft gets 403). Both refusals are audited.
 *
 * Note on the positive control: an independent approver passes the authorisation layer. Whether the approval then commits
 * depends on the handler, and on a fresh database it still fails on the signatures.sample_id foreign key (top defect 3, owned by
 * r1-esign and r1-spec), so this file asserts "not refused by authorisation", not "200".
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});

async function draftSpec(by: 'qa' | 'analyst1' | 'admin') {
  const res = await t.request.post('/api/specifications').set(H[by]).send({ material: uniq('SoD'), effectiveDate: '2026-01-01' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; version: number };
}
const approve = (id: string, by: string) => t.request.post(`/api/specifications/${id}/approve`).set(H[by]).send({ password: TEST_PASSWORD });
const status = async (id: string) => (await t.db.pool.query('SELECT status FROM specifications WHERE id = $1', [id])).rows[0].status as string;
const denials = async (entityId: string) =>
  (await t.db.pool.query(`SELECT outcome, actor_id, detail FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND detail LIKE $1 ORDER BY sequence`, [`%${entityId}%`])).rows;

describe('specification approval', () => {
  it('a QA officer who authored the draft cannot approve it: 403 SOD_VIOLATION, audited, record unchanged', async () => {
    const spec = await draftSpec('qa');
    const res = await approve(spec.id, 'qa');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect(res.body.error).toMatch(/independent|segregation/i);
    expect(await status(spec.id)).toBe('Draft');

    const events = await denials(spec.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'denied', actor_id: 'usr-qa' });
    expect(JSON.parse(events[0].detail)).toMatchObject({ rule: 'spec.approve', entity: 'Specification', entityId: spec.id });
  });

  it('an Analyst cannot approve at all: 403 PERMISSION_DENIED, audited', async () => {
    const spec = await draftSpec('qa');
    const res = await approve(spec.id, 'analyst1');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(await status(spec.id)).toBe('Draft');
    const events = await denials(spec.id);
    expect(events.map(e => e.actor_id)).toEqual(['usr-analyst1']);
    expect(JSON.parse(events[0].detail)).toMatchObject({ permission: 'spec.approve' });
  });

  it('someone who edited the draft is not independent either', async () => {
    const spec = await draftSpec('analyst1');
    const edit = await t.request.put(`/api/specifications/${spec.id}`).set(H.qa).send({ parameters: [{ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 0 }], expectedVersion: spec.version });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const res = await approve(spec.id, 'qa');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
  });

  it('a different Admin or QA officer passes the authorisation layer', async () => {
    const spec = await draftSpec('qa');
    const res = await approve(spec.id, 'admin');
    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(await denials(spec.id)).toHaveLength(0);

    const analystSpec = await draftSpec('analyst1');
    const byQa = await approve(analystSpec.id, 'qa');
    expect(byQa.status, JSON.stringify(byQa.body)).not.toBe(403);
    expect(await denials(analystSpec.id)).toHaveLength(0);
  });
});

describe('assertIndependent', () => {
  const rule = { code: 'spec.approve', description: 'The approver must not have created or edited the specification.' };

  it('refuses an actor who is among the participants and accepts anyone else', async () => {
    const { assertIndependent } = await import('../../src/server/authz/sod');
    expect(() => assertIndependent(['usr-a', 'usr-b'], 'usr-a', rule)).toThrowError(/independent/i);
    expect(() => assertIndependent([null, undefined, 'usr-b'], 'usr-c', rule)).not.toThrow();
    expect(() => assertIndependent([], 'usr-c', rule)).not.toThrow();
    try { assertIndependent(['usr-a'], 'usr-a', rule); } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.code).toBe('SOD_VIOLATION');
      expect(e.details).toMatchObject({ rule: 'spec.approve' });
    }
  });

  it('reads the participants of a record from the audit trail, using the actions its rule names', async () => {
    const { auditParticipants, assertIndependentOfRecord } = await import('../../src/server/authz/sod');
    const { db } = await import('../../src/db/index');
    const spec = await draftSpec('analyst1');
    await t.request.put(`/api/specifications/${spec.id}`).set(H.qa).send({ parameters: [{ name: 'pH', limit_kind: 'RANGE', lower: 5, upper: 7, decimals: 0 }], expectedVersion: spec.version });
    expect([...(await auditParticipants(db, 'Specification', spec.id, ['Create', 'Update']))].sort()).toEqual(['usr-analyst1', 'usr-qa']);
    expect([...(await auditParticipants(db, 'Specification', spec.id, ['Create']))]).toEqual(['usr-analyst1']);

    await expect(assertIndependentOfRecord(db, 'spec.approve', spec.id, 'usr-qa')).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
    await expect(assertIndependentOfRecord(db, 'spec.approve', spec.id, 'usr-admin')).resolves.toBeUndefined();
    await expect(assertIndependentOfRecord(db, 'rule.that.does.not.exist', spec.id, 'usr-admin')).rejects.toThrow(/unknown segregation-of-duties rule/i);
  });
});
