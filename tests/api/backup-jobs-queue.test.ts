/**
 * Durable job queue (roadmap M15), against real PostgreSQL and real operating-system processes.
 *
 *  - FOR UPDATE SKIP LOCKED claims: two server processes run each job exactly once;
 *  - a lease with a heartbeat: a worker killed mid-job leaves a 'running' row that a sweeper requeues and another worker
 *    finishes (attempts = 2); a zombie that wakes up later cannot overwrite the new owner's result;
 *  - bounded retries with back-off (a failing job is not requeued for ever: the old nack() looped on a poison message);
 *  - unguessable job ids and an owner on every job.
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

const ROOT = path.resolve(__dirname, '..', '..');
let testDb: TestDb;
let db: any;
let q: typeof import('../../src/server/jobs/queue');
let runnerMod: typeof import('../../src/server/jobs/runner');

beforeAll(async () => {
  testDb = await useTestDb();
  ({ db } = await import('../../src/db/index'));
  q = await import('../../src/server/jobs/queue');
  runnerMod = await import('../../src/server/jobs/runner');
  await testDb.pool.query('create table test_exec (job_id text not null, pid int not null, at timestamptz not null default now())');
});

const OWNER = 'usr-analyst1';
const state = async (id: string) => (await testDb.pool.query('select * from jobs where id = $1', [id])).rows[0];
const waitFor = async <T>(what: string, probe: () => Promise<T | null | false | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
};
const quick = { pollMs: 25, sweepMs: 200, heartbeatMs: 100, leaseSeconds: 2, backoffSeconds: () => 0 };

describe('enqueue', () => {
  it('gives every job an unguessable id and an owner, and stores nothing secret-looking in the id', async () => {
    const a = await q.enqueue(db, { type: 'test.noop', payload: { x: 1 }, createdBy: OWNER });
    const b = await q.enqueue(db, { type: 'test.noop', payload: { x: 1 }, createdBy: OWNER });
    expect(a.id).toMatch(/^job-[0-9a-f]{24}$/);
    expect(a.id).not.toBe(b.id);
    expect(await state(a.id)).toMatchObject({ type: 'test.noop', status: 'pending', attempts: 0, created_by: OWNER, locked_by: null });
    expect(JSON.parse((await state(a.id)).payload)).toEqual({ x: 1 });
    await testDb.pool.query(`update jobs set status = 'failed' where id = any($1)`, [[a.id, b.id]]); // out of the way of the claims below
  });

  it('refuses a job without an owner', async () => {
    await expect(q.enqueue(db, { type: 'test.noop', createdBy: '' })).rejects.toThrow(/createdBy/);
  });

  it('answers the existing job while another with the same dedupe key is waiting or running, and a new one after it finished', async () => {
    const first = await q.enqueue(db, { type: 'test.noop', createdBy: OWNER, dedupeKey: 'dd-1' });
    const again = await q.enqueue(db, { type: 'test.noop', createdBy: OWNER, dedupeKey: 'dd-1' });
    expect(again).toEqual({ id: first.id, created: false });
    expect(first.created).toBe(true);
    const claimed = await q.claimNext(db, 'w-dedupe', ['test.noop']);
    expect(claimed?.id).toBe(first.id);
    expect((await q.enqueue(db, { type: 'test.noop', createdBy: OWNER, dedupeKey: 'dd-1' })).id).toBe(first.id); // running
    await q.completeJob(db, { id: first.id, workerId: 'w-dedupe' }, {});
    const next = await q.enqueue(db, { type: 'test.noop', createdBy: OWNER, dedupeKey: 'dd-1' });
    expect(next.created).toBe(true);
    expect(next.id).not.toBe(first.id);
    await testDb.pool.query(`update jobs set status = 'failed' where id = $1`, [next.id]);
  });

  it('does not hand out a job before its run_at', async () => {
    const later = await q.enqueue(db, { type: 'test.later', createdBy: OWNER, runAt: new Date(Date.now() + 60_000) });
    const soon = await q.enqueue(db, { type: 'test.later', createdBy: OWNER, runAt: new Date(Date.now() - 1000) });
    const got = await q.claimNext(db, 'w-later', ['test.later']);
    expect(got?.id).toBe(soon.id);
    expect(await q.claimNext(db, 'w-later', ['test.later'])).toBeNull();
    expect((await state(later.id)).status).toBe('pending');
    await q.completeJob(db, { id: soon.id, workerId: 'w-later' }, {});
    await testDb.pool.query(`update jobs set status = 'failed' where id = $1`, [later.id]);
  });
});

describe('claim', () => {
  it('hands each of 30 jobs to exactly one of 10 concurrent claimers (SKIP LOCKED)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add((await q.enqueue(db, { type: 'test.race', createdBy: OWNER })).id);
    const got: string[] = [];
    await Promise.all(Array.from({ length: 10 }, async (_, w) => {
      for (;;) {
        const job = await q.claimNext(db, `w-race-${w}`, ['test.race']);
        if (!job) return;
        got.push(job.id);
        await q.completeJob(db, { id: job.id, workerId: `w-race-${w}` }, {});
      }
    }));
    expect(got).toHaveLength(30);
    expect(new Set(got)).toEqual(ids);
  });

  it('counts the attempt when the job is claimed', async () => {
    const { id } = await q.enqueue(db, { type: 'test.attempt', createdBy: OWNER });
    const job = await q.claimNext(db, 'w-att', ['test.attempt']);
    expect(job).toMatchObject({ id, attempts: 1, status: 'running', lockedBy: 'w-att' });
    expect((await state(id)).heartbeat_at).not.toBeNull();
    await q.completeJob(db, { id, workerId: 'w-att' }, {});
  });
});

describe('the runner', () => {
  it('runs the handler with the parsed payload, stores the result and completes the job', async () => {
    const { id } = await q.enqueue(db, { type: 'test.ok', payload: { n: 41 }, createdBy: OWNER });
    const r = runnerMod.startRunner({ db, ...quick, handlers: { 'test.ok': async (payload: any) => ({ answer: payload.n + 1 }) } });
    try {
      const row = await waitFor('completion', async () => { const s = await state(id); return s.status === 'completed' ? s : null; });
      expect(row.attempts).toBe(1);
      expect(JSON.parse(row.result)).toEqual({ answer: 42 });
      expect(row.finished_at).not.toBeNull();
      expect(row.locked_by).toBe(r.workerId); // who ran it stays on record; it is cleared only when the job goes back to pending
    } finally { await r.stop(); }
  });

  it('retries a failing job with back-off and gives up after max_attempts, keeping the last error; a poison job is not requeued for ever', async () => {
    const flaky = await q.enqueue(db, { type: 'test.flaky', createdBy: OWNER, maxAttempts: 3 });
    const poison = await q.enqueue(db, { type: 'test.poison', createdBy: OWNER, maxAttempts: 3 });
    let calls = 0, poisonCalls = 0;
    const r = runnerMod.startRunner({ db, ...quick, handlers: {
      'test.flaky': async () => { if (++calls < 3) throw new Error(`transient ${calls}`); return 'ok'; },
      'test.poison': async () => { poisonCalls++; throw new Error('always'); },
    } });
    try {
      await waitFor('flaky done', async () => (await state(flaky.id)).status === 'completed');
      expect(await state(flaky.id)).toMatchObject({ attempts: 3, last_error: 'transient 2' });
      await waitFor('poison failed', async () => (await state(poison.id)).status === 'failed');
      await new Promise(res => setTimeout(res, 400));
      expect(poisonCalls).toBe(3);
      expect(await state(poison.id)).toMatchObject({ status: 'failed', attempts: 3, last_error: 'always', locked_by: r.workerId });
    } finally { await r.stop(); }
  });

  it('applies back-off before a retry', async () => {
    const { id } = await q.enqueue(db, { type: 'test.backoff', createdBy: OWNER, maxAttempts: 2 });
    const r = runnerMod.startRunner({ db, ...quick, backoffSeconds: () => 30, handlers: { 'test.backoff': async () => { throw new Error('later'); } } });
    try {
      const row = await waitFor('requeue', async () => { const s = await state(id); return s.status === 'pending' && s.attempts === 1 ? s : null; });
      expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    } finally { await r.stop(); }
    await testDb.pool.query(`update jobs set status = 'failed' where id = $1`, [id]);
  });

  it('claims only the types it has a handler for: a job of a type this process does not know stays pending for one that does', async () => {
    const { id } = await q.enqueue(db, { type: 'test.nobody-handles-this', createdBy: OWNER, maxAttempts: 5 });
    const r = runnerMod.startRunner({ db, ...quick, handlers: { 'test.something-else': async () => 'x' } });
    try {
      await new Promise(res => setTimeout(res, 400));
      expect(await state(id)).toMatchObject({ status: 'pending', attempts: 0, locked_by: null });
    } finally { await r.stop(); }
    expect((await q.claimNext(db, 'w-typed', ['test.nobody-handles-this']))?.id).toBe(id);
    await q.completeJob(db, { id, workerId: 'w-typed' }, {});
  });

  it('a PermanentJobError is not retried', async () => {
    const { id } = await q.enqueue(db, { type: 'test.permanent', createdBy: OWNER, maxAttempts: 5 });
    const r = runnerMod.startRunner({ db, ...quick, handlers: { 'test.permanent': async () => { throw new runnerMod.PermanentJobError('the sample is not Approved'); } } });
    try {
      const row = await waitFor('failure', async () => { const s = await state(id); return s.status === 'failed' ? s : null; });
      expect(row).toMatchObject({ attempts: 1, last_error: 'the sample is not Approved' });
    } finally { await r.stop(); }
  });
});

describe('a worker that dies or stalls', () => {
  it('a zombie that finishes after its lease was taken over cannot overwrite the new owner', async () => {
    const { id } = await q.enqueue(db, { type: 'test.zombie', createdBy: OWNER });
    expect((await q.claimNext(db, 'w-zombie', ['test.zombie']))?.id).toBe(id);
    await testDb.pool.query(`update jobs set heartbeat_at = now() - interval '1 hour' where id = $1`, [id]);
    expect(await q.sweepStale(db, { leaseSeconds: 5, backoffSeconds: () => 0 })).toEqual({ requeued: [id], failed: [] });
    expect((await q.claimNext(db, 'w-new', ['test.zombie']))?.id).toBe(id);
    await expect(q.completeJob(db, { id, workerId: 'w-zombie' }, { result: 'stale' })).rejects.toThrow(/lease/i);
    expect(await q.heartbeat(db, id, 'w-zombie')).toBe(false);
    expect(await q.heartbeat(db, id, 'w-new')).toBe(true);
    await q.completeJob(db, { id, workerId: 'w-new' }, { result: 'fresh' });
    expect(await state(id)).toMatchObject({ status: 'completed', attempts: 2, result: 'fresh' });
  });

  it('a stale job that has used all its attempts is failed by the sweeper, not requeued', async () => {
    const { id } = await q.enqueue(db, { type: 'test.exhausted', createdBy: OWNER, maxAttempts: 1 });
    await q.claimNext(db, 'w-x', ['test.exhausted']);
    await testDb.pool.query(`update jobs set heartbeat_at = now() - interval '1 hour' where id = $1`, [id]);
    expect(await q.sweepStale(db, { leaseSeconds: 5 })).toEqual({ requeued: [], failed: [id] });
    expect(await state(id)).toMatchObject({ status: 'failed', locked_by: 'w-x' });
    expect((await state(id)).last_error).toMatch(/lease|abandon|stopped/i);
  });

  it('killing the process mid-job leaves a running row that is reclaimed and completed with attempts = 2', async () => {
    const { id } = await q.enqueue(db, { type: 'test.hang-once', createdBy: OWNER });
    const child = spawnWorker('victim', { hang: true });
    try {
      await waitFor('the victim to start the job', async () => (await testDb.pool.query('select 1 from test_exec where job_id = $1', [id])).rowCount);
      expect((await state(id)).status).toBe('running');
      child.kill('SIGKILL');
      await new Promise(res => child.once('exit', res));
      expect((await state(id)).status).toBe('running'); // nobody has noticed yet: this is the state the old queue left for ever
    } finally { child.kill('SIGKILL'); }

    const r = runnerMod.startRunner({ db, ...quick, handlers: { 'test.hang-once': async () => 'finished by the second worker' } });
    try {
      const row = await waitFor('reclaim and completion', async () => { const s = await state(id); return s.status === 'completed' ? s : null; }, 20_000);
      expect(row.attempts).toBe(2);
      expect(row.result).toBe('finished by the second worker');
      expect(row.locked_by).toBe(r.workerId);
    } finally { await r.stop(); }
  });
});

describe('two server processes', () => {
  it('execute each of 60 jobs exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push((await q.enqueue(db, { type: 'test.once', createdBy: OWNER })).id);
    const a = spawnWorker('A', {}), b = spawnWorker('B', {});
    try {
      await waitFor('all jobs done', async () => (await testDb.pool.query(`select count(*)::int as n from jobs where id = any($1) and status = 'completed'`, [ids])).rows[0].n === 60, 30_000);
    } finally { a.kill('SIGKILL'); b.kill('SIGKILL'); }
    const runs = (await testDb.pool.query('select job_id, pid from test_exec where job_id = any($1)', [ids])).rows;
    expect(runs).toHaveLength(60);
    expect(new Set(runs.map(r => r.job_id)).size).toBe(60);
    expect(new Set(runs.map(r => r.pid)).size).toBe(2); // both processes took part
    const attempts = (await testDb.pool.query('select distinct attempts from jobs where id = any($1)', [ids])).rows;
    expect(attempts).toEqual([{ attempts: 1 }]);
  });
});

/** A separate operating-system process running a worker against the same database. */
function spawnWorker(label: string, o: { hang?: boolean }): ChildProcess {
  const code = `
    import { sql } from 'drizzle-orm';
    import { db } from ${JSON.stringify(path.join(ROOT, 'src/db/index.ts'))};
    import { startRunner } from ${JSON.stringify(path.join(ROOT, 'src/server/jobs/runner.ts'))};
    const mark = (ctx) => db.execute(sql\`insert into test_exec (job_id, pid) values (\${ctx.job.id}, \${process.pid})\`);
    const handlers = {
      ${o.hang ? "'test.hang-once': async (_p, ctx) => { await mark(ctx); await new Promise(() => {}); }," : "'test.once': async (_p, ctx) => { await mark(ctx); await new Promise(r => setTimeout(r, 15)); return 'done'; },"}
    };
    startRunner({ db, handlers, pollMs: 25, sweepMs: 1000, heartbeatMs: 100, leaseSeconds: 2, backoffSeconds: () => 0, concurrency: 2 });
    console.log('worker ${label} started');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  return child;
}
