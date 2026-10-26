/**
 * Scheduler (roadmap M15). node-cron wakes it every minute; what is DUE is decided from scheduled_jobs.next_due_at against the
 * clock, not from "did the timer fire". So a PC that was switched off over a due time simply finds the schedule overdue when the
 * server starts and runs it once (the catch-up tick runs before the first minute passes), however many slots were missed.
 *
 *   - one advisory lock per tick: of several server processes only one evaluates the schedules, and the slot of a job is also its
 *     dedupe key, so a slot is enqueued once even if the bookkeeping row were reset;
 *   - the work is done by a job, attributed to the service principal (src/server/jobs/principal.ts);
 *   - cron fields are evaluated in the server's local time.
 */
import { sql } from 'drizzle-orm';
import { log, serializeError } from './core/logger';
import type { Db } from './core/context';
import { enqueue } from './jobs/queue';
import { ensureServicePrincipal } from './jobs/principal';
import { SCHEDULES, type ScheduleDef } from './schedules';

/** Key of the advisory lock a tick holds (audit chain 7001, migrations 7002, security events 7003, identity bootstrap 7010). */
export const SCHEDULER_LOCK = 7020;

// ---- cron ------------------------------------------------------------------------------------------------------------

interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const RANGES = { minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 7] } as const;

function parseField(text: string, name: keyof typeof RANGES, expr: string): Set<number> {
  const [lo, hi] = RANGES[name];
  const fail = (why: string): never => { throw new Error(`Invalid cron expression "${expr}": ${name} ${why}`); };
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!m) return fail(`"${part}" is not understood`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return fail('step must be at least 1');
    let a: number, b: number;
    if (m[1] === '*') { a = lo; b = name === 'dow' ? 6 : hi; }
    else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(Number); }
    else { a = Number(m[1]); b = m[2] === undefined ? a : hi; }
    if (a < lo || b > hi || a > b) return fail(`${m[1]} is outside ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(name === 'dow' && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression "${expr}": five fields are needed (minute hour day-of-month month day-of-week)`);
  const [mi, ho, dom, mo, dow] = parts;
  return {
    minute: parseField(mi, 'minute', expr), hour: parseField(ho, 'hour', expr), dom: parseField(dom, 'dom', expr),
    month: parseField(mo, 'month', expr), dow: parseField(dow, 'dow', expr), domStar: dom.startsWith('*'), dowStar: dow.startsWith('*'),
  };
}

/** Standard cron: when both day-of-month and day-of-week are restricted, either may match. */
function dayMatches(f: CronFields, d: Date): boolean {
  const byDom = f.dom.has(d.getDate()), byDow = f.dow.has(d.getDay());
  if (f.domStar && f.dowStar) return true;
  if (f.domStar) return byDow;
  if (f.dowStar) return byDom;
  return byDom || byDow;
}

/**
 * The first time strictly after `after` that matches the expression, in the server's local time. A time that does not exist
 * (inside the hour a spring-forward skips) is read as the instant right after the gap, so a run is not lost on that day.
 */
export function nextRun(expr: string, after: Date): Date {
  const f = parseCron(expr);
  const hours = [...f.hour].sort((a, b) => a - b), minutes = [...f.minute].sort((a, b) => a - b);
  for (let i = 0; i < 366 * 9; i++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
    if (!f.month.has(day.getMonth() + 1) || !dayMatches(f, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (t.getTime() > after.getTime()) return t;
      }
    }
  }
  throw new Error(`Invalid cron expression "${expr}": it never matches (checked nine years ahead)`);
}

// ---- the registry ----------------------------------------------------------------------------------------------------

const rowsOf = (res: unknown): any[] => (res as { rows: any[] }).rows;

/** Adds the schedules that have no row yet, due at their next time after `now`. Existing rows are left as they are. */
export async function ensureSchedules(db: Db, defs: ScheduleDef[] = SCHEDULES, now = new Date()): Promise<void> {
  for (const d of defs) {
    await db.execute(sql`
      INSERT INTO scheduled_jobs (name, cron, type, payload, description, next_due_at)
      VALUES (${d.name}, ${d.cron}, ${d.type}, ${d.payload ? JSON.stringify(d.payload) : null}, ${d.description}, ${nextRun(d.cron, now)})
      ON CONFLICT (name) DO NOTHING`);
  }
}

export interface DueRun { name: string; jobId: string; scheduledFor: Date; /** further slots that also passed and were collapsed into this run */ missed: number }

/**
 * Enqueues a job for every enabled schedule whose time has come, and moves its next due time past `now`. Several slots that passed
 * (the PC was off) become ONE job. `now` is a parameter so a test can play any clock.
 */
export async function runDueSchedules(db: Db, o: { now?: Date } = {}): Promise<{ enqueued: DueRun[] }> {
  const now = o.now ?? new Date();
  const actor = await ensureServicePrincipal(db);
  return db.transaction(async (tx) => {
    const got = rowsOf(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK}) AS ok`))[0].ok;
    if (!got) return { enqueued: [] }; // another process is evaluating the schedules right now
    const due = rowsOf(await tx.execute(sql`SELECT * FROM scheduled_jobs WHERE enabled AND next_due_at <= ${now} ORDER BY next_due_at FOR UPDATE SKIP LOCKED`));
    const enqueued: DueRun[] = [];
    for (const row of due) {
      const scheduledFor = new Date(row.next_due_at); // execute() returns the text form of a timestamp
      let missed = 0;
      for (let slot = nextRun(row.cron, scheduledFor); slot.getTime() <= now.getTime() && missed < 10_000; slot = nextRun(row.cron, slot)) missed++;
      const base = row.payload ? JSON.parse(row.payload) : {};
      const job = await enqueue(tx, {
        type: row.type, createdBy: actor, dedupeKey: `${row.name}@${scheduledFor.toISOString()}`,
        payload: { ...base, schedule: row.name, scheduledFor: scheduledFor.toISOString(), missed },
      });
      const moved = rowsOf(await tx.execute(sql`
        UPDATE scheduled_jobs SET next_due_at = ${nextRun(row.cron, now)}, last_enqueued_at = ${now}, last_job_id = ${job.id}, version = version + 1, updated_at = now()
        WHERE name = ${row.name} AND version = ${row.version} RETURNING name`));
      if (moved.length !== 1) throw new Error(`Schedule ${row.name} was changed while it was being run.`);
      if (job.created) enqueued.push({ name: row.name, jobId: job.id, scheduledFor, missed });
    }
    return { enqueued };
  });
}

// ---- running it ------------------------------------------------------------------------------------------------------

export interface TickHandle { stop(): void }
/** Calls `tick` once a minute. The default is node-cron; a test passes its own. */
export type TickSource = (tick: () => Promise<void>) => TickHandle | Promise<TickHandle>;

const nodeCronTicks: TickSource = async (tick) => {
  const cron = (await import('node-cron')).default;
  const task = cron.schedule('* * * * *', () => { void tick(); });
  return { stop: () => { task.stop(); } };
};

export interface SchedulerOptions {
  now?: () => Date;
  tickSource?: TickSource;
  /** The schedules to register at start. Default: the shipped ones. */
  defs?: ScheduleDef[];
  /** Called with the jobs a tick enqueued (the process nudges its runner). */
  onEnqueued?: (runs: DueRun[]) => void;
}

/** Registers the schedules, runs the catch-up tick at once, then ticks every minute until stop(). */
export async function startScheduler(db: Db, o: SchedulerOptions = {}): Promise<TickHandle> {
  const clock = o.now ?? (() => new Date());
  await ensureServicePrincipal(db);
  await ensureSchedules(db, o.defs ?? SCHEDULES, clock());
  const tick = async () => {
    try {
      const { enqueued } = await runDueSchedules(db, { now: clock() });
      if (enqueued.length) {
        log.info({ schedules: enqueued.map(e => ({ name: e.name, job: e.jobId, missed: e.missed })) }, 'scheduled jobs enqueued');
        o.onEnqueued?.(enqueued);
      }
    } catch (err) { log.error({ err: serializeError(err) }, 'scheduler tick failed'); }
  };
  await tick(); // a schedule that fell due while the PC was off runs now
  return (o.tickSource ?? nodeCronTicks)(tick);
}
