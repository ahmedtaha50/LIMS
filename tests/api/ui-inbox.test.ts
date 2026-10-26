/**
 * Roadmap M24 (r2-ui-foundation): GET /api/inbox, the "my tasks" home. Role-aware (a group appears only for a user whose role may
 * act on it, per the permission matrix and the sample workflow) and SoD-aware (a record the user took part in, which the handler
 * would refuse to let them sign, is not offered to them). Real application, real PostgreSQL.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params);

async function sample(id: string, state: string, createdBy = 'usr-analyst1', enteredBy: string | null = null) {
  await sql(`INSERT INTO samples (id, material, batch, state, created_by, version) VALUES ($1, 'Inbox Material', 'IB-1', $2, $3, 1)`, [id, state, createdBy]);
  await sql(`INSERT INTO results (id, sample_id, parameter, value, entered_by, entered_at, version) VALUES ($1, $2, 'Assay (%)', '99.5', $3, now(), 1)`, [`res-${id}`, id, enteredBy]);
}

const inbox = async (email: string) => {
  const auth = await t.auth(email);
  const res = await t.request.get('/api/inbox').set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { groups: Array<{ key: string; title: string; count: number; items: Array<{ id: string; entity: string; href: string; since: string | null }> }> };
};
const group = (body: any, key: string) => body.groups.find((g: any) => g.key === key);
const ids = (body: any, key: string) => (group(body, key)?.items ?? []).map((i: any) => i.id);

beforeAll(async () => {
  t = await startTestApp();
  await sample('SMP-IB-ENTERED-BY-QA', 'Pending Review', 'usr-analyst1', 'usr-qa');
  await sample('SMP-IB-ENTERED-BY-ANALYST', 'Pending Review', 'usr-analyst1', 'usr-analyst1');
  await sample('SMP-IB-CREATED-BY-ADMIN', 'Pending Review', 'usr-admin', 'usr-analyst2');
  await sample('SMP-IB-TESTING', 'Testing');
  await sample('SMP-IB-APPROVED', 'Approved');
});

describe('review queue', () => {
  it('a QA inbox excludes the records the QA officer entered, and offers the others', async () => {
    const body = await inbox('qa@gxp.com');
    const review = ids(body, 'review');
    expect(review).toContain('SMP-IB-ENTERED-BY-ANALYST');
    expect(review).toContain('SMP-IB-CREATED-BY-ADMIN');
    expect(review).not.toContain('SMP-IB-ENTERED-BY-QA');
    expect(review).not.toContain('SMP-IB-APPROVED');
    expect(group(body, 'review').count).toBe(review.length);
  });

  it('excludes the samples the reviewer registered (the workflow refuses them too)', async () => {
    const review = ids(await inbox('admin@gxp.com'), 'review');
    expect(review).not.toContain('SMP-IB-CREATED-BY-ADMIN');
    expect(review).toContain('SMP-IB-ENTERED-BY-QA');
  });

  it('is offered only to roles the workflow lets review: an Analyst gets no review group, but the samples to test', async () => {
    const body = await inbox('analyst2@gxp.com');
    expect(group(body, 'review')).toBeUndefined();
    expect(ids(body, 'testing')).toContain('SMP-IB-TESTING');
    expect(group(body, 'testing').items.find((i: any) => i.id === 'SMP-IB-TESTING').href).toBe('#/samples/SMP-IB-TESTING');
  });

  it('lists the oldest first, and says so', async () => {
    const body = await inbox('reviewer@gxp.com');
    const g = group(body, 'review');
    expect(g.order).toBe('oldest-first');
    const since = g.items.map((i: any) => Date.parse(i.since));
    expect([...since].sort((a, b) => a - b)).toEqual(since);
  });
});

describe('specification approval', () => {
  it('a draft is offered to approvers who did not author or edit it, never to its author', async () => {
    const qa = await t.auth('qa@gxp.com');
    const created = await t.request.post('/api/specifications').set(qa).send({ material: 'Inbox Spec Material', effectiveDate: '2026-01-01' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    expect(ids(await inbox('qa@gxp.com'), 'spec-approval')).not.toContain(id);
    expect(ids(await inbox('admin@gxp.com'), 'spec-approval')).toContain(id);
    expect(group(await inbox('analyst1@gxp.com'), 'spec-approval')).toBeUndefined(); // no spec.approve
  });
});

describe('OOS and role changes', () => {
  it('shows the OOS investigations assigned to the user, and those waiting for closure to QA', async () => {
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status, assigned_to, phase, version)
               VALUES ('OOS-IB-1', 'SMP-IB-TESTING', 'res-SMP-IB-TESTING', 'Assay (%)', '2026-01-01', 'Open', 'usr-analyst2', 'Phase I', 1),
                      ('OOS-IB-2', 'SMP-IB-APPROVED', 'res-SMP-IB-APPROVED', 'Assay (%)', '2026-01-02', 'Open', 'usr-analyst1', 'Pending QA', 1)`);
    expect(ids(await inbox('analyst2@gxp.com'), 'oos-assigned')).toEqual(['OOS-IB-1']);
    expect(ids(await inbox('analyst2@gxp.com'), 'oos-closure')).toEqual([]);
    expect(ids(await inbox('qa@gxp.com'), 'oos-closure')).toEqual(['OOS-IB-2']);
  });

  it('a pending role change is offered to an independent approver, not to its requester or to the person it is for', async () => {
    await sql(`INSERT INTO user_roles (id, user_id, role_id, previous_role, status, requested_by, request_reason, request_meaning, request_record_version, request_signature_hash)
               VALUES ('urc-ib-1', 'usr-reviewer', 'role-qa', 'Reviewer', 'Pending', 'usr-admin', 'Promotion', 'REQUEST', 1, 'x')`);
    expect(ids(await inbox('admin@gxp.com'), 'role-changes')).not.toContain('urc-ib-1');
    expect(ids(await inbox('qa@gxp.com'), 'role-changes')).toContain('urc-ib-1');
    expect(group(await inbox('reviewer@gxp.com'), 'role-changes')).toBeUndefined(); // no authz.role.approve
  });
});

describe('own tasks and access', () => {
  it('an untrained user is asked to complete the software training', async () => {
    await sql(`UPDATE users SET has_completed_software_training = false WHERE id = 'usr-analyst2'`);
    expect(ids(await inbox('analyst2@gxp.com'), 'training')).toEqual(['usr-analyst2']);
    expect(group(await inbox('analyst1@gxp.com'), 'training')).toBeUndefined();
  });

  it('needs a signed-in user and takes the user from the token only', async () => {
    expect((await t.request.get('/api/inbox')).status).toBe(401);
    const a = await t.auth('analyst1@gxp.com');
    expect((await t.request.get('/api/inbox?userId=usr-qa').set(a)).status).toBe(400);
  });
});
