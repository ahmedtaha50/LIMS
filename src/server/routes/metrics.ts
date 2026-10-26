// Domain: turnaround time and the role-based key figures (roadmap M34, r2-tat-kpi). Mounted by dashboardRoutes (./dashboard.ts).
//
//   GET  /metrics/tat                  cycle time (median, P90), on-time %, aging of the open samples, OOS rate by parameter, right-first-time
//   GET  /metrics/kpi                  the tiles of the caller's role (count, severity, the screen they open) and dated facts (last chain check, last backup)
//   GET  /metrics/kpi/:key             the rows of one tile: the SAME predicate as its count, so the tile and its list always agree
//   GET  /tat/settings                 business calendar, holidays and SLA rules in force (built-in defaults are marked as such)
//   PUT  /tat/calendar                 weekend days and time zone                                                 master.manage, audited, versioned
//   POST /tat/holidays                 a holiday; POST /tat/holidays/:id/remove removes one                       master.manage, audited, versioned
//   PUT  /tat/sla/:priority            business days allowed for Routine, Urgent or Critical                      master.manage, audited, versioned
//   GET  /tat/samples/:id              priority, clock start and due date of a sample
//   PUT  /tat/samples/:id              set the priority (recalculates the due date from the receipt); audited, versioned
//
// Every figure is an aggregate computed in SQL from rows that exist. Cycle time is derived from the immutable audit trail (the first
// Approved or Rejected Transition of the sample) and the receipt of the custody record; nothing is estimated or stored twice.
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { businessCalendar, businessHolidays, sampleTat, tatSlaRules, TAT_PRIORITIES, type TatPriority } from '../../db/schema/tat';
import { samples } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { OOS_TERMINAL_STATUSES } from '../../lib/constants/oos';
import { calibrationState, utcToday } from '../../lib/validations/instruments';
import { type Db, type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { ConflictError, ForbiddenError, NotFoundError, BadRequestError } from '../http/errors';
import { validate } from '../http/validate';
import { isValidTimeZone } from '../lib/businessCalendar';
import { listOverdue } from '../oos/workflow';
import { DUE_SOON_HOURS, FINISHED_STATES, loadCalendar, loadSlaRules, setPriority } from '../schedules/tat';

const DEFAULT_WINDOW_DAYS = 90;
const MAX_ROWS = 200;
const num = (v: unknown) => Number(v ?? 0);
const round = (v: unknown, d = 1) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const finished = sql.raw(FINISHED_STATES.map(s => `'${s}'`).join(', '));

// ---- input ------------------------------------------------------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'is not a calendar date');
const reason = z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(500);
const priority = z.enum(TAT_PRIORITIES);

export const tatQuerySchema = z.object({ from: day.optional(), to: day.optional(), priority: priority.optional() }).strict();
export const sampleTatSchema = z.object({ priority, reason, expectedVersion: z.number().int().min(1).optional() }).strict();
export const calendarSchema = z.object({
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6).refine(a => new Set(a).size === a.length, 'Each weekend day may be listed once.'),
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'is not a known IANA time zone'),
  reason, expectedVersion: z.number().int().min(1).optional(),
}).strict();
export const holidayCreateSchema = z.object({ date: day, name: z.string().trim().min(1).max(120), reason }).strict();
export const holidayRemoveSchema = z.object({ reason, expectedVersion: z.number().int().min(1) }).strict();
export const slaSchema = z.object({ businessDays: z.number().int().min(1).max(365), reason, expectedVersion: z.number().int().min(1).optional() }).strict();
const priorityParam = z.object({ priority }).strict();

// ---- the key figures --------------------------------------------------------------------------------------------------------------

type Role = 'Admin' | 'QA' | 'Reviewer' | 'Analyst';
interface Ctx { db: Db; now: Date; today: string }
export interface TileRow { id: string; label: string; detail: string; at: string | null }
type Severity = 'bad' | 'warn' | 'info';
interface Tile {
  key: string; label: string; hint: string; severity: Severity;
  /** The screen (App view id) where the work is done. */
  view: string;
  roles: readonly Role[];
  count(c: Ctx): Promise<number>;
  rows(c: Ctx, limit: number): Promise<TileRow[]>;
}

const iso = (col: SQL) => sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const rowsOf = (r: unknown) => (r as { rows: any[] }).rows;

/** A tile over one FROM/WHERE: the count and the list are two selects of the same text, so they cannot disagree. */
function sqlTile(def: Omit<Tile, 'count' | 'rows'>, parts: (c: Ctx) => { from: SQL; where: SQL; label: SQL; detail: SQL; at: SQL | null; order: SQL }): Tile {
  return {
    ...def,
    async count(c) {
      const p = parts(c);
      return num(rowsOf(await c.db.execute(sql`SELECT count(*)::int AS n FROM ${p.from} WHERE ${p.where}`))[0].n);
    },
    async rows(c, limit) {
      const p = parts(c);
      const res = await c.db.execute(sql`SELECT x.id AS id, ${p.label} AS label, ${p.detail} AS detail, ${p.at ?? sql`NULL`} AS at
        FROM ${p.from} WHERE ${p.where} ORDER BY ${p.order} LIMIT ${limit}`);
      return rowsOf(res).map(r => ({ id: String(r.id), label: String(r.label ?? ''), detail: String(r.detail ?? ''), at: r.at ?? null }));
    },
  };
}

/** A tile whose rows come from application code (a rule that is not one SELECT); the count is the length of the list. */
function listTile(def: Omit<Tile, 'count' | 'rows'>, list: (c: Ctx) => Promise<TileRow[]>): Tile {
  return { ...def, count: async c => (await list(c)).length, rows: async (c, limit) => (await list(c)).slice(0, limit) };
}

const SAMPLE_FROM = sql`samples x LEFT JOIN sample_tat t ON t.id = x.id LEFT JOIN sample_custody c ON c.sample_id = x.id`;
const sampleParts = (where: SQL, withDue = false) => (c: Ctx) => ({
  from: SAMPLE_FROM, where,
  label: sql`x.material`,
  detail: withDue
    ? sql`'Batch ' || x.batch || ', ' || x.state || ', ' || coalesce(t.priority, 'Routine') || ', due ' || to_char(t.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'`
    : sql`'Batch ' || x.batch || ', ' || x.state`,
  at: withDue ? iso(sql`t.due_at`) : iso(sql`x.created_at`),
  order: withDue ? sql`t.due_at ASC, x.id COLLATE "C"` : sql`x.created_at ASC, x.id COLLATE "C"`,
});
const OPEN = sql`x.state NOT IN (${finished})`;

const ALL: readonly Role[] = ['Admin', 'QA', 'Reviewer', 'Analyst'];
const SUPERVISORS: readonly Role[] = ['Admin', 'QA', 'Reviewer'];

export const TILES: readonly Tile[] = [
  sqlTile({ key: 'tat.overdue', label: 'Past their due date', hint: 'Open samples whose turnaround due date has passed.', severity: 'bad', view: 'samples', roles: ALL },
    c => sampleParts(sql`${OPEN} AND t.due_at < ${c.now.toISOString()}::timestamptz`, true)(c)),
  sqlTile({ key: 'tat.due_24h', label: `Due within ${DUE_SOON_HOURS} h`, hint: `Open samples due within the next ${DUE_SOON_HOURS} hours.`, severity: 'warn', view: 'samples', roles: ALL },
    c => sampleParts(sql`${OPEN} AND t.due_at >= ${c.now.toISOString()}::timestamptz AND t.due_at < ${new Date(c.now.getTime() + DUE_SOON_HOURS * 3_600_000).toISOString()}::timestamptz`, true)(c)),
  sqlTile({ key: 'samples.logged', label: 'Registered, not started', hint: 'Samples in state Logged: waiting for testing to start.', severity: 'info', view: 'samples', roles: ['Analyst', 'Admin'] },
    sampleParts(sql`x.state = 'Logged'`)),
  sqlTile({ key: 'samples.testing', label: 'In testing', hint: 'Samples in state Testing.', severity: 'info', view: 'samples', roles: ['Analyst', 'Admin'] },
    sampleParts(sql`x.state = 'Testing'`)),
  sqlTile({ key: 'samples.pending_review', label: 'Awaiting review', hint: 'Samples in state Pending Review: waiting for an independent reviewer.', severity: 'warn', view: 'samples', roles: SUPERVISORS },
    sampleParts(sql`x.state = 'Pending Review'`)),
  sqlTile({ key: 'oos.active', label: 'Open OOS investigations', hint: 'Investigations that are not closed.', severity: 'bad', view: 'oos', roles: ALL },
    () => ({
      from: sql`oos_investigations x`, where: sql`x.status NOT IN (${sql.raw(OOS_TERMINAL_STATUSES.map(s => `'${s}'`).join(', '))})`,
      label: sql`x.parameter`, detail: sql`'Sample ' || x.sample_id || ', ' || x.status`, at: sql`x.date_raised`, order: sql`x.date_raised COLLATE "C", x.id COLLATE "C"`,
    })),
  listTile({ key: 'oos.overdue', label: 'OOS past their due date', hint: 'Open investigations past the due date of their phase.', severity: 'bad', view: 'oos', roles: SUPERVISORS },
    async c => (await listOverdue(c.db, c.today)).map(o => ({ id: o.id, label: o.parameter, detail: `Sample ${o.sampleId}, ${o.daysOverdue} day(s) overdue`, at: o.dueDate }))),
  sqlTile({ key: 'eln.unsigned', label: 'Unsigned worksheets', hint: 'Notebook entries in Draft that are not locked.', severity: 'warn', view: 'eln', roles: ['Analyst', 'Reviewer', 'Admin'] },
    () => ({
      from: sql`lab_notebook x`, where: sql`x.status = 'Draft' AND x.locked = false`,
      label: sql`x.title`, detail: sql`coalesce('Sample ' || x.sample_id, 'Protocol')`, at: iso(sql`x.entered_at`), order: sql`x.entered_at ASC, x.id COLLATE "C"`,
    })),
  sqlTile({ key: 'batches.hold', label: 'Batches on quarantine hold', hint: 'Batch releases in Quarantine Hold.', severity: 'warn', view: 'traceability', roles: ['QA', 'Admin'] },
    () => ({ from: sql`batch_releases x`, where: sql`x.status = 'Quarantine Hold'`, label: sql`x.batch`, detail: sql`'Quarantine Hold'`, at: null, order: sql`x.batch COLLATE "C"` })),
  listTile({ key: 'instruments.overdue', label: 'Instruments past calibration', hint: 'Instruments whose calibration due date has passed (current through the end of that day).', severity: 'bad', view: 'instruments', roles: ['Analyst', 'QA', 'Admin'] },
    async c => {
      const res = await c.db.execute(sql`SELECT id, name, status, calibration_due_date FROM instruments ORDER BY id COLLATE "C"`);
      return rowsOf(res)
        .map(i => ({ i, d: calibrationState(String(i.calibration_due_date), c.now).daysRemaining }))
        .filter(({ d }) => !Number.isFinite(d) || d < 0) // an unreadable due date counts as overdue, as on the dashboard
        .map(({ i }) => ({ id: String(i.id), label: String(i.name), detail: `${i.status}, calibration due ${String(i.calibration_due_date).slice(0, 10)}`, at: String(i.calibration_due_date).slice(0, 10) }));
    }),
  sqlTile({ key: 'reagents.expiring', label: 'Reagents expiring within 30 days', hint: 'Usable reagent lots (Approved, In use) and register entries whose last day of use falls within the next 30 days.', severity: 'warn', view: 'reagents', roles: ['Analyst', 'QA', 'Admin'] },
    c => ({
      from: sql`(
        SELECT l.id AS id, i.name AS name, l.lot_number AS lot_number, least(l.expiry_date, coalesce(l.in_use_expiry, l.expiry_date)) AS use_until
          FROM reagent_lots l JOIN reagent_items i ON i.id = l.item_id WHERE l.status IN ('Approved', 'InUse')
        UNION ALL SELECT r.id, r.name, r.lot_number, r.expiry_date FROM reagents r) x`,
      where: sql`x.use_until COLLATE "C" >= ${c.today}::text AND x.use_until COLLATE "C" <= ${new Date(Date.parse(`${c.today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10)}::text`,
      label: sql`x.name`, detail: sql`'Lot ' || x.lot_number || ', use until ' || x.use_until`, at: sql`x.use_until`, order: sql`x.use_until COLLATE "C", x.id COLLATE "C"`,
    })),
  sqlTile({ key: 'training.overdue', label: 'Overdue training', hint: 'Training records with status Overdue.', severity: 'bad', view: 'training', roles: ['QA', 'Admin'] },
    () => ({
      from: sql`training_records x LEFT JOIN users u ON u.id = x.user_id`, where: sql`x.status = 'Overdue'`,
      label: sql`x.module_name`, detail: sql`coalesce(u.name, x.user_id)`, at: null, order: sql`x.module_name COLLATE "C", x.id COLLATE "C"`,
    })),
];

const tileFor = (role: string) => TILES.filter(t => t.roles.includes(role as Role));

/** Dated facts for the quality unit: when the audit chain was last checked and the last backup, as they happened (never a score). */
async function systemFacts(db: Db) {
  const [chain] = rowsOf(await db.execute(sql`SELECT timestamp, outcome FROM security_events WHERE event_type = 'AUDIT_VERIFY' ORDER BY sequence DESC LIMIT 1`));
  const [backup] = rowsOf(await db.execute(sql`SELECT finished_at, status, verified FROM backup_runs ORDER BY finished_at DESC LIMIT 1`));
  return {
    lastChainVerification: chain ? { at: new Date(chain.timestamp).toISOString(), outcome: String(chain.outcome) } : null,
    lastBackup: backup ? { at: new Date(backup.finished_at).toISOString(), outcome: String(backup.status), verified: Boolean(backup.verified) } : null,
  };
}

// ---- turnaround statistics ----------------------------------------------------------------------------------------------------------

/**
 * The samples that finished in the window: finished = the FIRST Approved or Rejected Transition in the audit trail, and the sample is
 * in a finished state now. The clock starts at the receipt of the sample; a sample with no receipt record (registered before custody) starts at registration.
 */
function finishedSamples(from: Date, to: Date, only?: TatPriority) {
  return sql`(
    SELECT s.id AS sample_id, a.done_at, a.outcome, coalesce(t.priority, 'Routine') AS priority, t.due_at,
           greatest(0, extract(epoch FROM (a.done_at - coalesce(c.received_at, s.created_at))) / 3600.0) AS hours
      FROM (SELECT DISTINCT ON (entity_id) entity_id, timestamp AS done_at, new_value AS outcome
              FROM audit_trail
             WHERE entity = 'Sample' AND action = 'Transition' AND field = 'state' AND new_value IN ('Approved', 'Rejected')
             ORDER BY entity_id, sequence ASC) a
      JOIN samples s ON s.id = a.entity_id AND s.state IN (${finished})
      LEFT JOIN sample_custody c ON c.sample_id = s.id
      LEFT JOIN sample_tat t ON t.id = s.id
     WHERE a.done_at >= ${from.toISOString()}::timestamptz AND a.done_at < ${to.toISOString()}::timestamptz
       ${only ? sql`AND coalesce(t.priority, 'Routine') = ${only}` : sql``}
  ) f`;
}

const stat = (alias: string) => sql.raw(`
  count(*)::int AS completed,
  count(*) FILTER (WHERE ${alias}outcome = 'Approved')::int AS approved,
  count(*) FILTER (WHERE ${alias}due_at IS NOT NULL)::int AS with_due,
  count(*) FILTER (WHERE ${alias}due_at IS NOT NULL AND ${alias}done_at <= ${alias}due_at)::int AS on_time,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${alias}hours) AS median_hours,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY ${alias}hours) AS p90_hours`);
const shape = (r: any) => ({
  completed: num(r.completed), approved: num(r.approved), withDueDate: num(r.with_due), onTime: num(r.on_time),
  onTimePct: num(r.with_due) > 0 ? round((num(r.on_time) / num(r.with_due)) * 100) : null,
  medianHours: round(r.median_hours, 2), p90Hours: round(r.p90_hours, 2),
});

export async function tatMetrics(db: Db, q: { from?: string; to?: string; priority?: TatPriority }, now = new Date()) {
  const to = q.to ? new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000) : new Date(now.getTime() + 1);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (from >= to) throw new BadRequestError('"from" must be before "to".');
  const f = finishedSamples(from, to, q.priority);

  const [overall] = rowsOf(await db.execute(sql`SELECT ${stat('f.')} FROM ${f}`));
  const byPriority = rowsOf(await db.execute(sql`SELECT f.priority, ${stat('f.')} FROM ${f} GROUP BY f.priority ORDER BY f.priority COLLATE "C"`))
    .map(r => ({ priority: String(r.priority), ...shape(r) }));

  // Aging of what is open now: whole days since the clock started (receipt; registration for a sample not received yet).
  const aging = rowsOf(await db.execute(sql`
    SELECT bucket, count(*)::int AS n FROM (
      SELECT CASE WHEN age < 2 THEN '0-1 days' WHEN age < 4 THEN '2-3 days' WHEN age < 8 THEN '4-7 days' WHEN age < 15 THEN '8-14 days' ELSE '15+ days' END AS bucket
        FROM (SELECT floor(extract(epoch FROM (${now.toISOString()}::timestamptz - coalesce(c.received_at, s.created_at))) / 86400.0) AS age
                FROM samples s LEFT JOIN sample_custody c ON c.sample_id = s.id
                LEFT JOIN sample_tat t ON t.id = s.id
               WHERE s.state NOT IN (${finished}) ${q.priority ? sql`AND coalesce(t.priority, 'Routine') = ${q.priority}` : sql``}) a) b
    GROUP BY bucket`));
  const BUCKETS = ['0-1 days', '2-3 days', '4-7 days', '8-14 days', '15+ days'];
  const [open] = rowsOf(await db.execute(sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE t.due_at < ${now.toISOString()}::timestamptz)::int AS overdue,
           count(*) FILTER (WHERE t.due_at IS NULL)::int AS without_due
      FROM samples s LEFT JOIN sample_tat t ON t.id = s.id
     WHERE s.state NOT IN (${finished}) ${q.priority ? sql`AND coalesce(t.priority, 'Routine') = ${q.priority}` : sql``}`));

  // OOS rate by parameter: results with a value entered in the window, and how many of them were out of specification.
  const oosRate = rowsOf(await db.execute(sql`
    SELECT r.parameter, count(*)::int AS results, count(*) FILTER (WHERE r.is_oos)::int AS oos
      FROM results r
     WHERE r.value IS NOT NULL AND r.entered_at >= ${from.toISOString()}::timestamptz AND r.entered_at < ${to.toISOString()}::timestamptz
     GROUP BY r.parameter ORDER BY count(*) FILTER (WHERE r.is_oos) DESC, r.parameter COLLATE "C"`))
    .map(r => ({ parameter: String(r.parameter), results: num(r.results), oos: num(r.oos), ratePct: num(r.results) > 0 ? round((num(r.oos) / num(r.results)) * 100) : null }));

  // Right first time: approved in the window with no OOS investigation and no rejection in their history.
  const [rft] = rowsOf(await db.execute(sql`
    SELECT count(*)::int AS approved,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM oos_investigations o WHERE o.sample_id = f.sample_id)
                              AND NOT EXISTS (SELECT 1 FROM audit_trail a WHERE a.entity = 'Sample' AND a.entity_id = f.sample_id AND a.action = 'Transition' AND a.new_value = 'Rejected'))::int AS first_time
      FROM ${f} WHERE f.outcome = 'Approved'`));

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    priority: q.priority ?? null,
    ...shape(overall),
    byPriority,
    open: { total: num(open.open), overdue: num(open.overdue), withoutDueDate: num(open.without_due) },
    aging: BUCKETS.map(bucket => ({ bucket, n: num(aging.find(a => a.bucket === bucket)?.n) })),
    oosRate,
    rightFirstTime: { approved: num(rft.approved), firstTime: num(rft.first_time), pct: num(rft.approved) > 0 ? round((num(rft.first_time) / num(rft.approved)) * 100) : null },
    definitions: {
      cycleTime: 'From the receipt of the sample (registration if no receipt is recorded) to the first Approved or Rejected transition in the audit trail, in hours. Percentiles use linear interpolation (percentile_cont).',
      onTime: 'Finished samples that have a due date and finished at or before it, as a share of finished samples that have a due date. Samples without a due date are left out and counted in "open.withoutDueDate" / "completed - withDueDate".',
      rightFirstTime: 'Approved samples with no OOS investigation and no rejection in their history.',
      oosRate: 'Results with a recorded value in the window that are out of specification, per parameter.',
    },
  };
}

// ---- routes -------------------------------------------------------------------------------------------------------------------------

const holidayView = (h: typeof businessHolidays.$inferSelect) => ({ id: h.id, date: h.holidayDate, name: h.name, version: h.version });
const sampleTatView = (r: typeof sampleTat.$inferSelect) => ({
  sampleId: r.id, priority: r.priority, startedAt: r.startedAt?.toISOString() ?? null, slaBusinessDays: r.slaBusinessDays,
  dueAt: r.dueAt?.toISOString() ?? null, setBy: r.setBy, setAt: r.setAt.toISOString(), version: r.version,
});

export const metricsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/metrics/tat', requireAuth, validate(tatQuerySchema, 'query'), async (req, res) => {
    res.json(await tatMetrics(db, req.query as z.infer<typeof tatQuerySchema>));
  });

  router.get('/metrics/kpi', requireAuth, async (req, res) => {
    const user = (req as any).user;
    const c: Ctx = { db, now: new Date(), today: utcToday() };
    const tiles = await Promise.all(tileFor(user.role).map(async t => ({
      key: t.key, label: t.label, hint: t.hint, severity: t.severity, view: t.view, count: await t.count(c),
    })));
    res.json({
      role: user.role, generatedAt: c.now.toISOString(), tiles,
      facts: user.role === 'Admin' || user.role === 'QA' ? await systemFacts(db) : null,
    });
  });

  router.get('/metrics/kpi/:key', requireAuth, async (req, res) => {
    const user = (req as any).user;
    const tile = TILES.find(t => t.key === String(req.params.key));
    if (!tile) throw new NotFoundError('There is no such key figure.');
    if (!tile.roles.includes(user.role)) throw new ForbiddenError('Forbidden: this key figure is not part of your role.');
    const c: Ctx = { db, now: new Date(), today: utcToday() };
    const [total, rows] = await Promise.all([tile.count(c), tile.rows(c, MAX_ROWS)]);
    res.json({ key: tile.key, label: tile.label, view: tile.view, total, shown: rows.length, rows });
  });

  router.get('/tat/settings', requireAuth, async (_req, res) => {
    const [calendar, sla] = await Promise.all([loadCalendar(db), loadSlaRules(db)]);
    const holidays = (await db.select().from(businessHolidays)).sort((a, b) => (a.holidayDate < b.holidayDate ? -1 : 1)).map(holidayView);
    res.json({ calendar: { weekendDays: calendar.weekendDays, timeZone: calendar.timeZone, version: calendar.version, source: calendar.source, updatedAt: calendar.updatedAt }, holidays, sla });
  });

  router.put('/tat/calendar', requireAuth, validate(calendarSchema), async (req, res) => {
    const user = (req as any).user;
    const { weekendDays, timeZone, reason: why, expectedVersion } = req.body as z.infer<typeof calendarSchema>;
    if (new Set(weekendDays).size >= 7) throw new BadRequestError('Not every day of the week can be a weekend day.');
    const view = (r: { weekendDays: number[]; timeZone: string }) => JSON.stringify({ weekendDays: [...r.weekendDays].sort((a, b) => a - b), timeZone: r.timeZone });
    const row = await withTransaction(db, async (tx) => {
      const [existing] = await tx.select().from(businessCalendar).where(eq(businessCalendar.id, 'default')).for('update');
      if (!existing) {
        const created = { id: 'default', weekendDays, timeZone, updatedBy: user.id, version: 1 };
        await tx.insert(businessCalendar).values(created);
        await writeAudit(tx, user.id, 'Create', 'BusinessCalendar', 'default', 'calendar', '', view(created), why);
        return { ...created, updatedAt: new Date() };
      }
      if (expectedVersion === undefined) throw new ConflictError('Conflict: the calendar already exists. Refresh and send its version.');
      const updated = await updateVersioned(tx, businessCalendar, 'default', expectedVersion, { weekendDays, timeZone, updatedBy: user.id, updatedAt: new Date() });
      await writeAudit(tx, user.id, 'Update', 'BusinessCalendar', 'default', 'calendar', view(existing), view(updated), why);
      return updated;
    });
    res.json({ weekendDays: [...row.weekendDays].sort((a, b) => a - b), timeZone: row.timeZone, version: row.version });
  });

  router.post('/tat/holidays', requireAuth, validate(holidayCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const { date, name, reason: why } = req.body as z.infer<typeof holidayCreateSchema>;
    const row = await withTransaction(db, async (tx) => {
      const [dup] = await tx.select({ id: businessHolidays.id }).from(businessHolidays).where(eq(businessHolidays.holidayDate, date)).limit(1);
      if (dup) throw new ConflictError(`Conflict: ${date} is already a holiday.`);
      const created = { id: `HOL-${date}`, holidayDate: date, name, createdBy: user.id, version: 1 };
      await tx.insert(businessHolidays).values(created);
      await writeAudit(tx, user.id, 'Create', 'BusinessHoliday', created.id, 'holiday', '', JSON.stringify({ date, name }), why);
      return { ...created, createdAt: new Date() };
    });
    res.status(201).json(holidayView(row));
  });

  router.post('/tat/holidays/:id/remove', requireAuth, validate(holidayRemoveSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { reason: why, expectedVersion } = req.body as z.infer<typeof holidayRemoveSchema>;
    await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, businessHolidays, id);
      if (current.version !== expectedVersion) throw new ConflictError();
      await tx.delete(businessHolidays).where(and(eq(businessHolidays.id, id), eq(businessHolidays.version, expectedVersion)));
      await writeAudit(tx, user.id, 'Delete', 'BusinessHoliday', id, 'holiday', JSON.stringify({ date: current.holidayDate, name: current.name }), '', why);
    });
    res.json({ removed: id });
  });

  router.put('/tat/sla/:priority', requireAuth, validate(priorityParam, 'params'), validate(slaSchema), async (req, res) => {
    const user = (req as any).user;
    const p = String(req.params.priority) as TatPriority;
    const { businessDays, reason: why, expectedVersion } = req.body as z.infer<typeof slaSchema>;
    const row = await withTransaction(db, async (tx) => {
      const [existing] = await tx.select().from(tatSlaRules).where(eq(tatSlaRules.id, p)).for('update');
      if (!existing) {
        const created = { id: p, businessDays, updatedBy: user.id, version: 1 };
        await tx.insert(tatSlaRules).values(created);
        await writeAudit(tx, user.id, 'Create', 'TatSlaRule', p, 'businessDays', '', String(businessDays), why);
        return created;
      }
      if (expectedVersion === undefined) throw new ConflictError('Conflict: this rule already exists. Refresh and send its version.');
      const updated = await updateVersioned(tx, tatSlaRules, p, expectedVersion, { businessDays, updatedBy: user.id, updatedAt: new Date() });
      await writeAudit(tx, user.id, 'Update', 'TatSlaRule', p, 'businessDays', String(existing.businessDays), String(businessDays), why);
      return updated;
    });
    res.json({ priority: p, businessDays: row.businessDays, version: row.version });
  });

  router.get('/tat/samples/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [sample] = await db.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.id, id)).limit(1);
    if (!sample) throw new NotFoundError('Sample not found');
    const [row] = await db.select().from(sampleTat).where(eq(sampleTat.id, id)).limit(1);
    res.json(row ? { ...sampleTatView(row), state: sample.state } : { sampleId: id, state: sample.state, priority: 'Routine', startedAt: null, slaBusinessDays: null, dueAt: null, version: null, setBy: null, setAt: null, source: 'default' });
  });

  router.put('/tat/samples/:id', requireAuth, validate(sampleTatSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { priority: p, reason: why, expectedVersion } = req.body as z.infer<typeof sampleTatSchema>;
    const row = await withTransaction(db, async (tx) => {
      const sample = await lockRow(tx, samples, id);
      if ((FINISHED_STATES as readonly string[]).includes(sample.state)) throw new BadRequestError(`The sample is ${sample.state}: its priority can no longer be changed.`);
      return setPriority(tx, user.id, id, p, why, expectedVersion ?? null);
    });
    res.json(sampleTatView(row as typeof sampleTat.$inferSelect));
  });

  return router;
};
