/**
 * The maintenance jobs of the scheduler (roadmap M15): the weekly audit-chain verification that r1-audit left to the job system,
 * and the consistency of the registry (every shipped schedule names a type that has a handler: a typo would leave its jobs pending for ever).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

let testDb: TestDb;
let db: any;
let q: typeof import('../../src/server/jobs/queue');
let runnerMod: typeof import('../../src/server/jobs/runner');
let principal: string;

beforeAll(async () => {
  testDb = await useTestDb();
  ({ db } = await import('../../src/db/index'));
  q = await import('../../src/server/jobs/queue');
  runnerMod = await import('../../src/server/jobs/runner');
  principal = await (await import('../../src/server/jobs/principal')).ensureServicePrincipal(db);
});

const finished = async (id: string) => {
  const end = Date.now() + 20_000;
  for (;;) {
    const row = (await testDb.pool.query('select * from jobs where id = $1', [id])).rows[0];
    if (row.status === 'completed' || row.status === 'failed' || Date.now() > end) return row;
    await new Promise(r => setTimeout(r, 50));
  }
};

describe('the registry', () => {
  it('has a handler for every shipped schedule', async () => {
    const { defaultHandlers } = await import('../../src/server/jobs/handlers');
    const { SCHEDULES } = await import('../../src/server/schedules');
    expect(SCHEDULES.map(s => s.name)).toContain('audit.verify');
    for (const s of SCHEDULES) expect(Object.keys(defaultHandlers()), s.name).toContain(s.type);
  });
});

describe('audit.verify', () => {
  it('records a successful verification of both chains as a security event of the service principal', async () => {
    const r = runnerMod.startRunner({ db, pollMs: 25, sweepMs: 500, heartbeatMs: 200 });
    try {
      const { id } = await q.enqueue(db, { type: 'audit.verify', payload: { schedule: 'audit.verify' }, createdBy: principal });
      const job = await finished(id);
      expect(job.status, job.last_error).toBe('completed');
      const ev = (await testDb.pool.query(`select outcome, actor_id, actor_role, detail from security_events where event_type = 'AUDIT_VERIFY' order by sequence desc limit 1`)).rows[0];
      expect(ev).toMatchObject({ outcome: 'success', actor_id: principal, actor_role: 'Service' });
      expect(JSON.parse(ev.detail)).toMatchObject({ scheduled: true, audit: { compromisedSequence: null } });
    } finally { await r.stop(); }
  });

  it('fails for good, and records a failure event naming the sequence, when the audit chain was tampered with', async () => {
    const c = await testDb.pool.connect();
    try { // the owner lifts the guard for one statement: exactly what the chain exists to detect
      await c.query('alter table audit_trail disable trigger user');
      await c.query(`update audit_trail set new_value = 'forged' where sequence = 1`);
      await c.query('alter table audit_trail enable trigger user');
    } finally { c.release(); }
    const r = runnerMod.startRunner({ db, pollMs: 25, sweepMs: 500, heartbeatMs: 200 });
    try {
      const { id } = await q.enqueue(db, { type: 'audit.verify', createdBy: principal });
      const job = await finished(id);
      expect(job).toMatchObject({ status: 'failed', attempts: 1 });
      expect(job.last_error).toMatch(/audit trail is broken at sequence 1/);
      const ev = (await testDb.pool.query(`select outcome, detail from security_events where event_type = 'AUDIT_VERIFY' order by sequence desc limit 1`)).rows[0];
      expect(ev.outcome).toBe('failure');
      expect(JSON.parse(ev.detail).audit.compromisedSequence).toBe(1);
    } finally { await r.stop(); }
  });
});
