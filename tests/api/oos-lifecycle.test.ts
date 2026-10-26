/**
 * Roadmap M10 (r1-results-oos): the OOS investigation lifecycle.
 *
 *   vocabulary   status Open | Closed (v0.1.0's 'Approved' reads as Closed), phase Phase I | Phase II | Pending QA while open,
 *                decision on closure
 *   POST /oos    strict; one open investigation per result (409); the date raised is the server's
 *   close        signed through signRecord (OOS_CLOSURE): a wrong password is counted and audited and survives the failed request
 *   PUT          moves the phase forward only (Phase I -> Phase II -> Pending QA, or Phase I -> Pending QA); needs the gate patch
 *                that gives the route table oosUpdateSchema (docs/changes/r1-results-oos.md)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function open() {
  const s = await registerSample(t);
  const res = await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: s.id, resultId: s.result.id });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...s, oos: res.body as { id: string; version: number; status: string; phase: string; dateRaised: string; parameter: string } };
}

describe('POST /oos', () => {
  it('opens an investigation in Phase I, takes the parameter from the result and the date from the server, and audits it', async () => {
    const { oos } = await open();
    expect(oos).toMatchObject({ status: 'Open', phase: 'Phase I', parameter: 'Assay (%)', dateRaised: today() });
    expect(await sql("SELECT action, user_id FROM audit_trail WHERE entity = 'OOS' AND entity_id = $1", [oos.id])).toEqual([{ action: 'Create', user_id: 'usr-analyst1' }]);
  });

  it('a second open investigation for the same result is 409', async () => {
    const s = await open();
    const again = await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: s.id, resultId: s.result.id });
    expect(again.status).toBe(409);
  });

  it('a result that does not belong to the sample is 400; an unknown key is 400', async () => {
    const a = await registerSample(t);
    const b = await registerSample(t);
    expect((await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: a.id, resultId: b.result.id })).status).toBe(400);
    expect((await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: a.id, resultId: a.result.id, status: 'Closed' })).status).toBe(400);
  });
});

describe('closure', () => {
  // r2-oos-workflow: the decision is required; Confirmed OOS follows Phase II, and Invalidated needs a confirmed assignable cause and a
  // retest (tests/api/oos-workflow.test.ts).
  const toPhase2 = async (oos: { id: string; version: number }) => {
    const res = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ phase: 'Phase II', expectedVersion: oos.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.version as number;
  };

  it('writes Closed with the decision, signed with OOS_CLOSURE on the OOS record, and the signature verifies', async () => {
    const { oos, id: sampleId } = await open();
    const version = await toPhase2(oos);
    const res = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Degradation during storage', conclusion: 'Confirmed; batch to be rejected, CAPA raised', decision: 'Confirmed OOS', password: 'password', expectedVersion: version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await sql('SELECT status, decision, root_cause FROM oos_investigations WHERE id = $1', [oos.id])).toEqual([{ status: 'Closed', decision: 'Confirmed OOS', root_cause: 'Degradation during storage' }]);
    const [sig] = await sql("SELECT id, meaning_code, entity_type, entity_id, sample_id FROM signatures WHERE entity_type = 'OOS' AND entity_id = $1", [oos.id]);
    expect(sig).toMatchObject({ meaning_code: 'OOS_CLOSURE', sample_id: sampleId });
    const v = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(v.body).toMatchObject({ valid: true, status: 'valid' });
    const list = await t.request.get('/api/oos').set(H.qa);
    const shown = list.body.find((o: any) => o.id === oos.id);
    expect(shown.signature?.id).toBe(sig.id);
  });

  it('a wrong password is counted and audited, and the counter is not rolled back with the failed closure', async () => {
    const { oos } = await open();
    const version = await toPhase2(oos);
    const res = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Dilution error by the analyst', conclusion: 'Confirmed; batch rejected', decision: 'Confirmed OOS', password: 'wrong', expectedVersion: version });
    expect(res.status).toBe(401);
    expect((await sql("SELECT failed_attempts FROM users WHERE id = 'usr-qa'"))[0].failed_attempts).toBe(1);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-qa'")).toEqual([{ n: 1 }]);
    expect((await sql('SELECT status FROM oos_investigations WHERE id = $1', [oos.id]))[0].status).toBe('Open');
    await sql("UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-qa'");
  });

  it('an unknown decision is 400', async () => {
    const { oos } = await open();
    const res = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Dilution error', conclusion: 'Invalidated; retest', decision: 'Whatever', password: 'password', expectedVersion: oos.version });
    expect(res.status).toBe(400);
  });

  it('a legacy closed investigation (status Approved) is treated as terminal', async () => {
    const { oos } = await open();
    await sql("UPDATE oos_investigations SET status = 'Approved' WHERE id = $1", [oos.id]);
    const res = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Dilution error', conclusion: 'Invalidated; retest', password: 'password', expectedVersion: oos.version });
    expect(res.status).toBe(423);
  });
});

describe('PUT /oos/:id phases (needs the route-table gate patch)', () => {
  it('moves the phase forward and audits it; a backwards move is 409', async () => {
    const { oos } = await open();
    const p2 = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ phase: 'Phase II', expectedVersion: oos.version });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.phase).toBe('Phase II');
    const back = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ phase: 'Phase I', expectedVersion: p2.body.version });
    expect(back.status).toBe(409);
    const qa = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ phase: 'Pending QA', expectedVersion: p2.body.version });
    expect(qa.status).toBe(200);
    const audits = await sql("SELECT field, old_value, new_value FROM audit_trail WHERE entity = 'OOS' AND entity_id = $1 AND field = 'phase' ORDER BY sequence", [oos.id]);
    expect(audits).toEqual([{ field: 'phase', old_value: 'Phase I', new_value: 'Phase II' }, { field: 'phase', old_value: 'Phase II', new_value: 'Pending QA' }]);
  });

  it('assignedTo must be an active user', async () => {
    const { oos } = await open();
    const res = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ assignedTo: 'usr-nobody', expectedVersion: oos.version });
    expect(res.status).toBe(400);
  });
});
