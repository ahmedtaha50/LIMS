/**
 * Scheduler (roadmap M15): a cron registry that survives a PC being switched off.
 *
 *  - schedules live in scheduled_jobs with the time they are next due; a tick (every minute, node-cron) enqueues what is due;
 *  - a schedule that fell due while the PC was off runs ONCE at the next start (injected clock, no sleeping);
 *  - several processes ticking at once enqueue a slot once (advisory lock + the slot is the job's dedupe key);
 *  - scheduled work is done by a named, non-interactive service principal, never an anonymous 'system'.
 * The last block is the M14 acceptance: with nobody logged in, a backup appears at the schedule time and is mirrored.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';
import { tempDir } from '../upgrade/helpers';

let testDb: TestDb;
let db: any;
let sched: typeof import('../../src/server/scheduler');
let defs: typeof import('../../src/server/schedules/index');
let principal: typeof import('../../src/server/jobs/principal');
let runnerMod: typeof import('../../src/server/jobs/runner');

beforeAll(async () => {
  testDb = await useTestDb();
  ({ db } = await import('../../src/db/index'));
  sched = await import('../../src/server/scheduler');
  defs = await import('../../src/server/schedules/index');
  principal = await import('../../src/server/jobs/principal');
  runnerMod = await import('../../src/server/jobs/runner');
});

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('nextRun (5-field cron, server local time)', () => {
  const cases: Array<[string, Date, string]> = [
    ['0 2 * * *', local(2026, 10, 13, 1, 59, 30), '2026-10-13 02:00'],
    ['0 2 * * *', local(2026, 10, 13, 2, 0, 0), '2026-10-14 02:00'],            // strictly after
    ['0 2 * * *', local(2026, 10, 13, 2, 0, 1), '2026-10-14 02:00'],
    ['*/15 * * * *', local(2026, 10, 13, 10, 7), '2026-10-13 10:15'],
    ['*/15 * * * *', local(2026, 10, 13, 10, 45), '2026-10-13 11:00'],
    ['0 3 1 * *', local(2026, 10, 13, 12), '2026-11-01 03:00'],                    // monthly
    ['0 3 1 * *', local(2026, 12, 1, 3, 0), '2027-01-01 03:00'],
    ['30 4 * * 0', local(2026, 10, 13, 12), '2026-10-18 04:30'],                  // Sunday
    ['0 8-17/3 * * 1-5', local(2026, 10, 16, 18), '2026-10-19 08:00'],            // weekdays, 08 11 14 17
    ['0 8-17/3 * * 1-5', local(2026, 10, 19, 8, 0), '2026-10-19 11:00'],
    ['5,35 * * * *', local(2026, 10, 13, 10, 6), '2026-10-13 10:35'],
    ['0 0 29 2 *', local(2026, 10, 13), '2028-02-29 00:00'],                      // leap day: next one is two years off
    ['0 0 13 * 2', local(2026, 10, 13, 0, 0), '2026-10-20 00:00'],                // day-of-month OR day-of-week when both are restricted: next Tuesday
    ['0 0 13 * 2', local(2026, 10, 12, 1, 0), '2026-10-13 00:00'],
  ];
  it.each(cases)('%s after %s is %s', (expr, after, expected) => {
    expect(fmt(sched.nextRun(expr, after))).toBe(expected);
  });

  it('rejects an expression it cannot honour instead of silently never running', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '61 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a b c d e', '*/0 * * * *', '5-1 * * * *']) {
      expect(() => sched.nextRun(bad, new Date()), JSON.stringify(bad)).toThrow(/cron/i);
    }
  });

  it('property: always later than `after`, matches the fields in local time, and skips no earlier match (scanned minute by minute)', () => {
    const exprs = ['0 2 * * *', '*/7 * * * *', '15 4 * * 0', '0 */6 * * *', '30 22 1,15 * *', '0 9 * * 1-5'];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const expr of exprs) {
      const [mi, ho, dom, , dow] = expr.split(' ');
      const matches = (d: Date) => {
        const f = (spec: string, v: number, lo: number) => spec.split(',').some(part => {
          const [range, step] = part.split('/');
          const [a, b] = range === '*' ? [lo, 1e9] : range.includes('-') ? range.split('-').map(Number) : [Number(range), step ? 1e9 : Number(range)];
          return v >= a && v <= b && (v - a) % Number(step ?? 1) === 0;
        });
        const dayOk = dom === '*' && dow === '*' ? true : dom !== '*' && dow !== '*' ? f(dom, d.getDate(), 1) || f(dow, d.getDay(), 0) : dom !== '*' ? f(dom, d.getDate(), 1) : f(dow, d.getDay(), 0);
        return f(mi, d.getMinutes(), 0) && f(ho, d.getHours(), 0) && dayOk;
      };
      for (let k = 0; k < 12; k++) {
        const after = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 3 * 365 * 86_400_000));
        const next = sched.nextRun(expr, after);
        expect(next.getTime(), `${expr} after ${after.toISOString()}`).toBeGreaterThan(after.getTime());
        expect(matches(next), `${expr} -> ${next.toString()}`).toBe(true);
        expect(next.getSeconds()).toBe(0);
        // no matching minute between `after` and `next`
        const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
        for (let t = start; t < next.getTime(); t += 60_000) if (matches(new Date(t))) throw new Error(`${expr}: ${new Date(t).toString()} matches but ${next.toString()} was returned`);
      }
    }
  });
});

describe('the default schedules', () => {
  it('are valid cron expressions and name a job type each', () => {
    const names = defs.SCHEDULES.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['backup.daily', 'backup.drill', 'artifacts.cleanup']));
    expect(new Set(names).size).toBe(names.length);
    for (const s of defs.SCHEDULES) {
      expect(() => sched.nextRun(s.cron, new Date()), s.name).not.toThrow();
      expect(s.type, s.name).toMatch(/^[a-z]+(\.[a-z]+)*$|^[a-z_]+$/);
    }
  });
});

describe('the service principal', () => {
  it('is created once, cannot sign in, and its creation is audited', async () => {
    const id = await principal.ensureServicePrincipal(db);
    expect(await principal.ensureServicePrincipal(db)).toBe(id);
    const u = (await testDb.pool.query('select * from users where id = $1', [id])).rows[0];
    expect(u).toMatchObject({ role: 'Service', active: false, password_hash: null, email: null });
    const created = (await testDb.pool.query(`select user_id, reason from audit_trail where action = 'Create' and entity = 'User' and entity_id = $1`, [id])).rows;
    expect(created).toHaveLength(1);
    expect(created[0].reason).toMatch(/service principal/i);
  });
});

describe('runDueSchedules with an injected clock', () => {
  const jobsOf = async (name: string) => (await testDb.pool.query(`select * from jobs where dedupe_key like $1 order by created_at`, [`${name}@%`])).rows;
  const def = (name: string, cron = '0 2 * * *') => ({ name, cron, type: 'test.scheduled', payload: { from: name }, description: name });
  const dueAt = async (name: string, when: Date) => testDb.pool.query('update scheduled_jobs set next_due_at = $2 where name = $1', [name, when]);
  // Every call evaluates all schedules in the database, including those other tests of this file left due: look at one by name.
  const only = <T extends { name: string }>(r: { enqueued: T[] }, name: string) => r.enqueued.filter(e => e.name === name);

  it('seeds a schedule with its first due time and does not run it before then', async () => {
    const now = local(2026, 10, 13, 12);
    await sched.ensureSchedules(db, [def('t.seed')], now);
    const row = (await testDb.pool.query(`select * from scheduled_jobs where name = 't.seed'`)).rows[0];
    expect(fmt(new Date(row.next_due_at))).toBe('2026-10-14 02:00');
    expect(row).toMatchObject({ cron: '0 2 * * *', type: 'test.scheduled', enabled: true });
    expect(only(await sched.runDueSchedules(db, { now }), 't.seed')).toEqual([]);
    expect(await jobsOf('t.seed')).toEqual([]);
    // an existing row is never overwritten by the code's definition (an administrator may have changed it)
    await testDb.pool.query(`update scheduled_jobs set cron = '0 5 * * *' where name = 't.seed'`);
    await sched.ensureSchedules(db, [def('t.seed')], now);
    expect((await testDb.pool.query(`select cron from scheduled_jobs where name = 't.seed'`)).rows[0].cron).toBe('0 5 * * *');
  });

  it('a schedule that fell due while the PC was off runs once at start, as the service principal, and is then due tomorrow', async () => {
    const start = local(2026, 10, 14, 9, 30);           // the PC was off from the evening before until 09:30
    await sched.ensureSchedules(db, [def('t.off')], local(2026, 10, 13, 20));
    await dueAt('t.off', local(2026, 10, 14, 2));        // 02:00 passed while it was off
    const first = only(await sched.runDueSchedules(db, { now: start }), 't.off');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 't.off', missed: 0 });
    const jobs = await jobsOf('t.off');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'test.scheduled', status: 'pending', created_by: await principal.ensureServicePrincipal(db) });
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ from: 't.off', schedule: 't.off', scheduledFor: local(2026, 10, 14, 2).toISOString() });
    const row = (await testDb.pool.query(`select * from scheduled_jobs where name = 't.off'`)).rows[0];
    expect(fmt(new Date(row.next_due_at))).toBe('2026-10-15 02:00');
    expect(row.last_job_id).toBe(jobs[0].id);
    expect(new Date(row.last_enqueued_at).getTime()).toBe(start.getTime());

    expect((await sched.runDueSchedules(db, { now: start })).enqueued).toEqual([]);                         // same instant again: nothing at all
    expect((await sched.runDueSchedules(db, { now: local(2026, 10, 14, 23) })).enqueued).toEqual([]);
    expect((await jobsOf('t.off'))).toHaveLength(1);
  });

  it('five days of missed slots collapse into one run, which says how many were missed', async () => {
    await sched.ensureSchedules(db, [def('t.week')], local(2026, 10, 1, 12));
    await dueAt('t.week', local(2026, 10, 9, 2));
    const out = only(await sched.runDueSchedules(db, { now: local(2026, 10, 14, 9) }), 't.week');
    expect(out).toHaveLength(1);
    expect(out[0].missed).toBe(5);              // 10, 11, 12, 13 and 14 October 02:00 were also passed
    expect(await jobsOf('t.week')).toHaveLength(1);
    expect(JSON.parse((await jobsOf('t.week'))[0].payload).missed).toBe(5);
  });

  it('does not run a disabled schedule, and runs it when it is enabled again', async () => {
    await sched.ensureSchedules(db, [def('t.off-switch')], local(2026, 10, 1, 12));
    await dueAt('t.off-switch', local(2026, 10, 9, 2));
    await testDb.pool.query(`update scheduled_jobs set enabled = false where name = 't.off-switch'`);
    expect(only(await sched.runDueSchedules(db, { now: local(2026, 10, 14, 9) }), 't.off-switch')).toEqual([]);
    await testDb.pool.query(`update scheduled_jobs set enabled = true where name = 't.off-switch'`);
    expect(only(await sched.runDueSchedules(db, { now: local(2026, 10, 14, 9) }), 't.off-switch')).toHaveLength(1);
  });

  it('several processes ticking at the same moment enqueue the slot once', async () => {
    await sched.ensureSchedules(db, [def('t.race')], local(2026, 10, 1, 12));
    await dueAt('t.race', local(2026, 10, 14, 2));
    const results = await Promise.all(Array.from({ length: 8 }, () => sched.runDueSchedules(db, { now: local(2026, 10, 14, 9) })));
    expect(results.flatMap(r => only(r, 't.race'))).toHaveLength(1);
    expect(await jobsOf('t.race')).toHaveLength(1);
  });

  it('a slot whose job already exists is not enqueued twice even if the bookkeeping row was reset', async () => {
    await sched.ensureSchedules(db, [def('t.reset')], local(2026, 10, 1, 12));
    await dueAt('t.reset', local(2026, 10, 14, 2));
    await sched.runDueSchedules(db, { now: local(2026, 10, 14, 9) });
    await dueAt('t.reset', local(2026, 10, 14, 2));       // someone restored an old backup of this row
    await sched.runDueSchedules(db, { now: local(2026, 10, 14, 9, 1) });
    expect(await jobsOf('t.reset')).toHaveLength(1);
  });

  it('startScheduler runs a catch-up tick immediately and then on every tick of its source', async () => {
    await sched.ensureSchedules(db, [def('t.start')], local(2026, 10, 1, 12));
    await dueAt('t.start', local(2026, 10, 14, 2));
    let clock = local(2026, 10, 14, 9);
    let tick: (() => Promise<void>) | undefined;
    let stopped = false;
    const handle = await sched.startScheduler(db, { now: () => clock, tickSource: cb => { tick = cb; return { stop: () => { stopped = true; } }; }, defs: [] });
    expect(await jobsOf('t.start')).toHaveLength(1);       // before the first minute has passed
    expect(tick).toBeTypeOf('function');
    clock = local(2026, 10, 15, 2, 0, 20);                  // the next slot arrives
    await tick!();
    expect(await jobsOf('t.start')).toHaveLength(2);
    handle.stop();
    expect(stopped).toBe(true);
  });
});

describe('with nobody logged in, a backup appears at the schedule time and is mirrored with a matching sha256', () => {
  it('runs the default backup.daily schedule end to end', async () => {
    const dir = tempDir('bplims-sched'), mirror = tempDir('bplims-sched-mirror');
    Object.assign(process.env, { BACKUP_DIR: dir, BACKUP_MIRROR_DIR: mirror, BACKUP_PASSPHRASE: 'scheduled passphrase 2026' });
    const now = local(2026, 10, 14, 2, 0, 5);
    await sched.ensureSchedules(db, defs.SCHEDULES, local(2026, 10, 13, 12));
    const due = await sched.runDueSchedules(db, { now });
    expect(due.enqueued.map(e => e.name)).toContain('backup.daily');
    expect(due.enqueued.map(e => e.name)).not.toContain('backup.drill');       // monthly, not due

    const runner = runnerMod.startRunner({ db, pollMs: 25, sweepMs: 500, heartbeatMs: 200, leaseSeconds: 30 });
    try {
      const jobId = due.enqueued.find(e => e.name === 'backup.daily')!.jobId;
      const end = Date.now() + 60_000;
      let job: any;
      for (;;) {
        job = (await testDb.pool.query('select * from jobs where id = $1', [jobId])).rows[0];
        if (job.status === 'completed' || job.status === 'failed' || Date.now() > end) break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(job.status, job.last_error).toBe('completed');
    } finally { await runner.stop(); }

    const file = fs.readdirSync(dir).find(f => f.endsWith('.bak'))!;
    expect(file).toBeTruthy();
    const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    expect(sha(path.join(mirror, file))).toBe(sha(path.join(dir, file)));
    const run = (await testDb.pool.query(`select * from backup_runs where file_name = $1`, [file])).rows[0];
    expect(run).toMatchObject({ kind: 'scheduled', status: 'ok', mirror_ok: true, sha256: sha(path.join(dir, file)), created_by: await principal.ensureServicePrincipal(db) });
    const audit = (await testDb.pool.query(`select reason from audit_trail where action = 'BACKUP_CREATED' and entity_id = $1`, [file])).rows[0];
    expect(audit.reason).toMatch(/^Scheduled: /);
  });
});
