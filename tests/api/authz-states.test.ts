/**
 * Roadmap M09 (r1-authz): entity state machines. A closed or signed record cannot be edited (423), a state is never skipped
 * (409), and a status is only ever changed by the route that signs for it: PUT /oos/:id with a `status` key is 400.
 *
 * The terminal states are arranged with SQL where the route that reaches them has a known defect of another track; the guard
 * under test is the one in front of the route, not the route's own transition.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

async function openOos() {
  const s = await registerSample(t);
  const res = await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: s.id, resultId: s.result.id, parameter: 'Assay (%)', dateRaised: '2026-01-01' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; version: number };
}

describe('OOS investigation', () => {
  it('PUT with a status key is 400 and changes nothing (status moves only through the closure signature)', async () => {
    const oos = await openOos();
    const res = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ status: 'Approved', expectedVersion: oos.version });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('status');
    const [row] = await sql('SELECT status, version FROM oos_investigations WHERE id = $1', [oos.id]);
    expect(row).toMatchObject({ status: 'Open', version: 1 });
  });

  it('an open investigation can still be edited; once closed with a signature it is locked: PUT is 423, closing again is 423', async () => {
    const oos = await openOos();
    // r2-oos-workflow: a Confirmed OOS closure needs the Phase II investigation, and the decision is required.
    const edit = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ rootCause: 'Balance drift', phase: 'Phase II', expectedVersion: oos.version });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const close = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Balance drift', conclusion: 'Re-test within limits; CAPA raised', decision: 'Confirmed OOS', password: TEST_PASSWORD, expectedVersion: edit.body.version });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const [closed] = await sql('SELECT status, version, root_cause FROM oos_investigations WHERE id = $1', [oos.id]);

    const locked = await t.request.put(`/api/oos/${oos.id}`).set(H.qa).send({ rootCause: 'Rewritten after the fact', expectedVersion: closed.version });
    expect(locked.status, JSON.stringify(locked.body)).toBe(423);
    expect(locked.body.code).toBe('RECORD_LOCKED');
    const [after] = await sql('SELECT status, version, root_cause FROM oos_investigations WHERE id = $1', [oos.id]);
    expect(after).toEqual(closed);

    const again = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Balance drift', conclusion: 'Closed twice', decision: 'Confirmed OOS', password: TEST_PASSWORD, expectedVersion: closed.version });
    expect(again.status).toBe(423);
  });
});

describe('specification', () => {
  const insertSpec = async (status: string) => {
    const id = uniq('SPEC-ST');
    await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', $3, '[]'::jsonb)`, [id, uniq('Mat'), status]);
    return id;
  };

  it('only a Draft can be edited: Active and Obsolete are 423', async () => {
    for (const status of ['Active', 'Obsolete']) {
      const id = await insertSpec(status);
      const res = await t.request.put(`/api/specifications/${id}`).set(H.qa).send({ parameters: [], expectedVersion: 1 });
      expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(423);
      expect(res.body.code).toBe('RECORD_LOCKED');
    }
    const draft = await insertSpec('Draft');
    const ok = await t.request.put(`/api/specifications/${draft}`).set(H.qa).send({ parameters: [{ name: 'pH', limit_kind: 'RANGE', lower: 5, upper: 7, decimals: 0 }], expectedVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('approving an Active specification is an illegal transition (409), approving an Obsolete one is 423', async () => {
    const active = await insertSpec('Active');
    const a = await t.request.post(`/api/specifications/${active}/approve`).set(H.admin).send({ password: TEST_PASSWORD });
    expect(a.status, JSON.stringify(a.body)).toBe(409);
    expect(a.body.code).toBe('ILLEGAL_TRANSITION');

    const obsolete = await insertSpec('Obsolete');
    const o = await t.request.post(`/api/specifications/${obsolete}/approve`).set(H.admin).send({ password: TEST_PASSWORD });
    expect(o.status, JSON.stringify(o.body)).toBe(423);
    expect(await sql('SELECT status FROM specifications WHERE id = $1', [obsolete])).toEqual([{ status: 'Obsolete' }]);
  });
});

describe('laboratory notebook', () => {
  it('a signed worksheet is locked: editing and signing again are 423', async () => {
    const created = await t.request.post('/api/eln').set(H.analyst1).send({ title: uniq('Worksheet'), content: 'Weighed 10.00 g.' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id as string;
    const draftEdit = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'Weighed 10.01 g.', expectedVersion: 1 });
    expect(draftEdit.status, JSON.stringify(draftEdit.body)).toBe(200);

    await sql(`UPDATE lab_notebook SET status = 'Signed', locked = true WHERE id = $1`, [id]);
    const edit = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'Changed after signing', expectedVersion: 2 });
    expect(edit.status, JSON.stringify(edit.body)).toBe(423);
    expect(edit.body.code).toBe('RECORD_LOCKED');
    const sign = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD });
    expect(sign.status, JSON.stringify(sign.body)).toBe(423);
    expect((await sql('SELECT content FROM lab_notebook WHERE id = $1', [id]))[0].content).toBe('Weighed 10.01 g.');
  });
});

describe('batch release', () => {
  it('a released batch is final: a second release is 423 and the first release record is untouched', async () => {
    const batch = uniq('B-REL');
    await sql(`INSERT INTO batch_releases (id, batch, status, released_by, released_at, version) VALUES ($1, $2, 'Released', 'usr-qa', now(), 1)`, [uniq('BR'), batch]);
    const res = await t.request.post(`/api/traceability/batch/${batch}/release`).set(H.qa).send({ password: TEST_PASSWORD, reason: 'second attempt' });
    expect(res.status, JSON.stringify(res.body)).toBe(423);
    expect(res.body.code).toBe('RECORD_LOCKED');
    expect(await sql('SELECT status, version FROM batch_releases WHERE batch = $1', [batch])).toEqual([{ status: 'Released', version: 1 }]);
  });

  it('a batch that was never released is not blocked by the state guard', async () => {
    const res = await t.request.post(`/api/traceability/batch/${uniq('B-NEW')}/release`).set(H.qa).send({ password: TEST_PASSWORD });
    expect(res.status).not.toBe(423);
    expect(res.status).not.toBe(403);
  });
});

describe('instrument', () => {
  it('a retired instrument cannot be calibrated back into service: 423; an active one can', async () => {
    const insert = (status: string) => {
      const id = uniq('INST-ST');
      return sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'Balance', 'Weighing', $2, '2030-01-01', '2025-01-01') RETURNING id`, [id, status]).then(r => r[0].id as string);
    };
    const retired = await insert('Retired');
    const res = await t.request.post(`/api/instruments/${retired}/calibrate`).set(H.qa).send({ newDueDate: '2031-01-01', password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(423);
    expect((await sql('SELECT status, calibration_due_date FROM instruments WHERE id = $1', [retired]))[0]).toEqual({ status: 'Retired', calibration_due_date: '2030-01-01' });

    const active = await insert('Active');
    const ok = await t.request.post(`/api/instruments/${active}/calibrate`).set(H.qa).send({ newDueDate: '2031-01-01', password: TEST_PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('the state machine definitions', () => {
  it('are internally consistent: declared states, no way out of a terminal state, editable states are not terminal', async () => {
    const { ENTITY_STATES } = await import('../../src/server/workflow/entityStates');
    expect(Object.keys(ENTITY_STATES).sort()).toEqual(['batchRelease', 'eln', 'instrument', 'oos', 'specification']);
    for (const [name, m] of Object.entries(ENTITY_STATES)) {
      expect(m.states, name).toContain(m.initial);
      for (const [from, tos] of Object.entries(m.transitions)) {
        expect(m.states, `${name}: ${from}`).toContain(from);
        for (const to of tos) expect(m.states, `${name}: ${from} -> ${to}`).toContain(to);
      }
      expect(m.terminal.length, name).toBeGreaterThan(0);
      for (const s of m.terminal) {
        expect(m.states, `${name}: ${s}`).toContain(s);
        expect(m.transitions[s] ?? [], `${name}: ${s} is terminal`).toEqual([]);
        expect(m.editable, `${name}: ${s}`).not.toContain(s);
      }
      for (const s of m.editable) expect(m.states, `${name}: ${s}`).toContain(s);
    }
  });

  it('assertTransition and assertEditable answer 423 for a terminal state and 409 for any other illegal move', async () => {
    const es = await import('../../src/server/workflow/entityStates');
    expect(es.canTransition('specification', 'Draft', 'Active')).toBe(true);
    expect(es.canTransition('specification', 'Active', 'Draft')).toBe(false);
    expect(es.isTerminal('oos', 'Approved')).toBe(true);
    expect(es.isTerminal('oos', 'Open')).toBe(false);
    expect(() => es.assertTransition('specification', 'Draft', 'Active')).not.toThrow();
    expect(() => es.assertTransition('specification', 'Obsolete', 'Active')).toThrowError(expect.objectContaining({ status: 423, code: 'RECORD_LOCKED' }));
    expect(() => es.assertTransition('specification', 'Active', 'Active')).toThrowError(expect.objectContaining({ status: 409, code: 'ILLEGAL_TRANSITION' }));
    expect(() => es.assertTransition('specification', 'Draft', 'Nonsense')).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() => es.assertEditable('eln', 'Draft')).not.toThrow();
    expect(() => es.assertEditable('eln', 'Signed')).toThrowError(expect.objectContaining({ status: 423, code: 'RECORD_LOCKED' }));
    expect(() => es.assertEditable('eln', 'No such state')).toThrowError(expect.objectContaining({ status: 423 }));
  });
});
