// Domain: dashboard (roadmap M13, r1-quality-fixes). Every figure is an aggregate of real rows, computed in SQL: no literals, no
// random padding, no placeholder slice. With nothing recorded the lists are empty and the screen says so. Instruments are current
// through the end of their due date (calibrationState), reagents through the end of their expiry date.
import { and, asc, count, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { batchReleases, instruments, labNotebook, oosInvestigations, reagents, samples, trainingRecords, users } from '../../db/schema';
import { calibrationState, utcToday } from '../../lib/validations/instruments';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { listOverdue } from '../oos/workflow';
import { dueReviews } from '../periodic';
import { metricsRoutes } from './metrics';
import { reagentLotCounts } from './reagents';

/** OOS statuses that end an investigation ('Approved' is today's word for closed; 'Closed' the roadmap's). */
const CLOSED_OOS = ['Approved', 'Closed'];
/** How many items of each kind the lists carry; the counts are always complete. */
const LIST_LIMIT = 100;
const TREND_MONTHS = 6;

type Urgency = 'Overdue' | 'Critical' | 'Approaching' | 'Compliant';
const URGENCY_COLOR: Record<Urgency, string> = { Overdue: '#ef4444', Critical: '#f97316', Approaching: '#eab308', Compliant: '#10b981' };
const urgencyOf = (days: number): Urgency => (days < 0 ? 'Overdue' : days <= 7 ? 'Critical' : days <= 30 ? 'Approaching' : 'Compliant');

const n = (v: unknown) => Number(v ?? 0);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The first day (UTC) of each of the last `months` calendar months, oldest first, as YYYY-MM. */
function monthKeys(now: Date, months: number): string[] {
  const keys: string[] = [];
  for (let back = months - 1; back >= 0; back--) {
    keys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7));
  }
  return keys;
}
const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const dashboardRoutes = (ctx: RouteContext) => {
  const { db, requireAuth } = ctx;
  const router = createRouter();
  // r2-tat-kpi (M34): turnaround time, the role-based key figures and the business calendar.
  router.use(metricsRoutes(ctx));

  router.get('/dashboard', requireAuth, async (_req, res) => {
    const now = new Date();
    const today = utcToday(now);

    // 1. Instruments and the calibration horizon (one row per instrument is the content of the timeline, not a count).
    const insts = await db.select().from(instruments);
    const instrumentCalibrations = insts.map(inst => {
      const { daysRemaining: d } = calibrationState(inst.calibrationDueDate, now);
      const daysRemaining = Number.isFinite(d) ? d : -1; // an unreadable due date is shown as overdue
      const urgency = urgencyOf(daysRemaining);
      return {
        id: inst.id, name: inst.name, type: inst.type, status: inst.status,
        calibrationDueDate: inst.calibrationDueDate, lastCalibrationDate: inst.lastCalibrationDate,
        daysRemaining, urgency, urgencyColor: URGENCY_COLOR[urgency],
      };
    }).sort((a, b) => a.daysRemaining - b.daysRemaining);
    const byUrgency = (u: Urgency) => instrumentCalibrations.filter(i => i.urgency === u);
    const overdueInst = byUrgency('Overdue');
    const criticalCalibrations = byUrgency('Critical');
    const approachingCalibrations = byUrgency('Approaching');
    const compliantCalibrations = byUrgency('Compliant');
    const upcomingCalibrations = [...criticalCalibrations, ...approachingCalibrations];

    // 2. What waits for a signature: samples in review, unsigned worksheets, open OOS, batches on hold.
    const pendingSampleWhere = eq(samples.state, 'Pending Review');
    const pendingElnWhere = and(eq(labNotebook.status, 'Draft'), eq(labNotebook.locked, false));
    const activeOosWhere = notInArray(oosInvestigations.status, CLOSED_OOS);
    const pendingBatchWhere = eq(batchReleases.status, 'Quarantine Hold');

    const [[sampleCount], [elnCount], [oosCount], [batchCount]] = await Promise.all([
      db.select({ n: count() }).from(samples).where(pendingSampleWhere),
      db.select({ n: count() }).from(labNotebook).where(pendingElnWhere),
      db.select({ n: count() }).from(oosInvestigations).where(activeOosWhere),
      db.select({ n: count() }).from(batchReleases).where(pendingBatchWhere),
    ]);
    const pendingSamples = await db.select({ id: samples.id, material: samples.material, batch: samples.batch, createdAt: samples.createdAt })
      .from(samples).where(pendingSampleWhere).orderBy(asc(samples.createdAt)).limit(LIST_LIMIT);
    const pendingEln = await db.select({ id: labNotebook.id, title: labNotebook.title, sampleId: labNotebook.sampleId, enteredAt: labNotebook.enteredAt })
      .from(labNotebook).where(pendingElnWhere).orderBy(asc(labNotebook.enteredAt)).limit(LIST_LIMIT);
    const activeOos = await db.select({ id: oosInvestigations.id, parameter: oosInvestigations.parameter, sampleId: oosInvestigations.sampleId, dateRaised: oosInvestigations.dateRaised })
      .from(oosInvestigations).where(activeOosWhere).orderBy(asc(oosInvestigations.dateRaised)).limit(LIST_LIMIT);
    const pendingBatches = await db.select({ id: batchReleases.id, batch: batchReleases.batch })
      .from(batchReleases).where(pendingBatchWhere).limit(LIST_LIMIT);
    // r2-oos-workflow (roadmap M26): an open investigation past the due date of its phase is overdue (src/server/oos/workflow.ts).
    const overdueOos = new Map((await listOverdue(db)).map(o => [o.id, o]));

    const counts = { samples: n(sampleCount.n), eln: n(elnCount.n), oos: n(oosCount.n), batches: n(batchCount.n) };
    const totalPendingApprovals = counts.samples + counts.eln + counts.oos + counts.batches;

    const pendingApprovalItems = [
      ...pendingSamples.map(s => ({ id: s.id, title: `Sample QA Release: ${s.material}`, category: 'Sample Review', entityType: 'Sample', batch: s.batch, date: iso(s.createdAt), urgency: 'High', actionView: 'samples' })),
      ...pendingEln.map(e => ({ id: e.id, title: `ELN Worksheet: ${e.title}`, category: 'ELN e-Signature', entityType: 'ELN', batch: e.sampleId ?? 'Protocol', date: iso(e.enteredAt), urgency: 'Medium', actionView: 'eln' })),
      ...activeOos.map(o => {
        const late = overdueOos.get(o.id);
        return {
          id: o.id, title: late ? `OOS Investigation overdue (due ${late.dueDate}, ${late.daysOverdue} d): ${o.parameter}` : `OOS Investigation: ${o.parameter}`,
          category: 'OOS / CAPA', entityType: 'OOS', batch: o.sampleId, date: o.dateRaised, urgency: late ? 'Critical' : 'High', actionView: 'oos',
        };
      }),
      ...pendingBatches.map(b => ({ id: b.id, title: `Batch Market Release: ${b.batch}`, category: 'QP Release', entityType: 'Batch', batch: b.batch, date: null, urgency: 'Critical', actionView: 'traceability' })),
    ];
    const approvalChartData = [
      { name: 'Sample Releases', count: counts.samples, fill: '#3b82f6', category: 'Samples' },
      { name: 'ELN Worksheets', count: counts.eln, fill: '#6366f1', category: 'ELN' },
      { name: 'OOS Investigations', count: counts.oos, fill: '#ef4444', category: 'Quality' },
      { name: 'Batch Approvals', count: counts.batches, fill: '#f59e0b', category: 'Batches' },
    ];

    // 3. Training: counts by status and by module, the users without the software training, the overdue and pending items.
    const trainingByStatus = await db.select({ status: trainingRecords.status, n: count() }).from(trainingRecords).groupBy(trainingRecords.status);
    const statusCount = (s: string) => n(trainingByStatus.find(r => r.status === s)?.n);
    const totalTrainingItems = trainingByStatus.reduce((acc, r) => acc + n(r.n), 0);
    const completedCount = statusCount('Completed');
    const overdueCount = statusCount('Overdue');
    const pendingCount = statusCount('Pending');
    const [needsBasic] = await db.select({ n: count() }).from(users).where(and(eq(users.active, true), eq(users.hasCompletedSoftwareTraining, false)));
    const usersNeedingBasicCount = n(needsBasic.n);
    const trainingCompliancePct = totalTrainingItems > 0 ? Math.round((completedCount / totalTrainingItems) * 100) : null;

    const moduleRows = await db.select({
      module: trainingRecords.moduleName, total: count(),
      completed: sql<number>`count(*) filter (where ${trainingRecords.status} = 'Completed')`,
      overdue: sql<number>`count(*) filter (where ${trainingRecords.status} = 'Overdue')`,
    }).from(trainingRecords).groupBy(trainingRecords.moduleName).orderBy(sql`${trainingRecords.moduleName} COLLATE "C"`);
    const trainingModuleChartData = moduleRows.map(m => ({
      module: m.module.length > 20 ? m.module.substring(0, 18) + '…' : m.module, fullModule: m.module,
      completed: n(m.completed), overdue: n(m.overdue), total: n(m.total),
    }));
    const trainingItems = (status: string) => db.select({
      id: trainingRecords.id, userId: trainingRecords.userId, userName: users.name, userRole: users.role, moduleName: trainingRecords.moduleName,
      status: trainingRecords.status, completedAt: trainingRecords.completedAt, certifiedBy: trainingRecords.certifiedBy,
    }).from(trainingRecords).leftJoin(users, eq(users.id, trainingRecords.userId)).where(eq(trainingRecords.status, status)).limit(LIST_LIMIT);
    const [overdueItems, pendingItems] = await Promise.all([trainingItems('Overdue'), trainingItems('Pending')]);
    const trainingChartData = [
      { name: 'Certified', count: completedCount, fill: '#10b981' },
      { name: 'Overdue', count: overdueCount, fill: '#ef4444' },
      { name: 'Pending Initial', count: pendingCount + usersNeedingBasicCount, fill: '#f59e0b' },
    ];

    // 4. Reagents: expired before today, current today or later.
    const [reagentCounts] = await db.select({ total: count(), expired: sql<number>`count(*) filter (where ${lt(reagents.expiryDate, today)})` }).from(reagents);
    // The lots of the inventory (r2-reagents, M30) are counted with the legacy register: active may be used today, expired is past it.
    const lotCounts = await reagentLotCounts(db, today);
    const reagentsExpired = n(reagentCounts.expired) + lotCounts.expired;
    const reagentsActive = n(reagentCounts.total) - n(reagentCounts.expired) + lotCounts.active;

    // 5. The trend: samples registered and OOS raised per calendar month (UTC), last six months. Empty when nothing happened.
    const keys = monthKeys(now, TREND_MONTHS);
    const windowStart = new Date(`${keys[0]}-01T00:00:00Z`);
    const sampleMonths = await db.select({ month: sql<string>`to_char(${samples.createdAt} at time zone 'UTC', 'YYYY-MM')`, n: count() })
      .from(samples).where(sql`${samples.createdAt} >= ${windowStart.toISOString()}::timestamptz`).groupBy(sql`1`);
    const oosMonths = await db.select({ month: sql<string>`left(${oosInvestigations.dateRaised}, 7)`, n: count() })
      .from(oosInvestigations).where(inArray(sql`left(${oosInvestigations.dateRaised}, 7)`, keys)).groupBy(sql`1`);
    const perMonth = (rows: Array<{ month: string; n: unknown }>, key: string) => n(rows.find(r => r.month === key)?.n);
    const anyActivity = sampleMonths.length > 0 || oosMonths.length > 0;
    const trendData = anyActivity
      ? keys.map(month => ({ month, name: monthLabel(month), samples: perMonth(sampleMonths, month), oos: perMonth(oosMonths, month) }))
      : [];

    // 6. OOS by parameter, all investigations.
    const oosByParameter = await db.select({ name: oosInvestigations.parameter, value: count() })
      .from(oosInvestigations).groupBy(oosInvestigations.parameter).orderBy(desc(count()), sql`${oosInvestigations.parameter} COLLATE "C"`);
    const oosChartData = oosByParameter.map(r => ({ name: r.name, value: n(r.value) }));

    const workloadData = [
      { name: 'Pending Approvals', count: totalPendingApprovals, fill: '#f59e0b' },
      { name: 'Active OOS', count: counts.oos, fill: '#ef4444' },
    ];

    // No composite or "audit ready" score: a number that blends unlike things is not a measurement (ALCOA+ accurate). Each figure below is a
    // count or share of existing records, and the screen shows when it was computed.
    const scoreBasis = `No composite score is computed. Every figure is a count or share of the records in this system as of ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;

    const complianceOverview = {
      scoreBasis,
      generatedAt: now.toISOString(),
      pendingApprovals: {
        total: totalPendingApprovals,
        sampleCount: counts.samples,
        elnCount: counts.eln,
        oosCount: counts.oos,
        batchCount: counts.batches,
        items: pendingApprovalItems,
        chartData: approvalChartData,
      },
      calibrations: {
        totalInstruments: insts.length,
        overdueCount: overdueInst.length,
        criticalCount: criticalCalibrations.length,
        approachingCount: approachingCalibrations.length,
        compliantCount: compliantCalibrations.length,
        tiersChartData: [
          { name: 'Overdue (<0d)', count: overdueInst.length, fill: URGENCY_COLOR.Overdue, tier: 'Overdue' },
          { name: 'Critical (≤7d)', count: criticalCalibrations.length, fill: URGENCY_COLOR.Critical, tier: 'Critical' },
          { name: 'Approaching (8-30d)', count: approachingCalibrations.length, fill: URGENCY_COLOR.Approaching, tier: 'Approaching' },
          { name: 'Compliant (>30d)', count: compliantCalibrations.length, fill: URGENCY_COLOR.Compliant, tier: 'Compliant' },
        ],
        timeline: instrumentCalibrations.map(i => ({
          name: i.name.length > 18 ? i.id : i.name, fullName: i.name, id: i.id, type: i.type,
          days: i.daysRemaining, fill: i.urgencyColor, status: i.status, dueDate: i.calibrationDueDate, urgency: i.urgency,
        })),
        items: instrumentCalibrations,
      },
      training: {
        compliancePct: trainingCompliancePct,
        totalItems: totalTrainingItems,
        completedCount,
        overdueCount,
        pendingCount,
        usersNeedingBasicCount,
        chartData: trainingChartData,
        moduleChartData: trainingModuleChartData,
        overdueItems: overdueItems.map(t => ({ ...t, userName: t.userName ?? t.userId })),
        pendingItems: pendingItems.map(t => ({ ...t, userName: t.userName ?? t.userId })),
      },
    };

    res.json({
      activeOos: counts.oos,
      overdueOos: overdueOos.size,
      upcomingCalibrations,
      overdueInstruments: overdueInst.length,
      pendingReviews: counts.samples,
      pendingApprovals: totalPendingApprovals,
      reagentsActive,
      reagentsExpired,
      trendData,
      oosChartData,
      workloadData,
      complianceOverview,
      // r3-periodic-archive: the periodic reviews due within 30 days or overdue (a due user-access review shows here).
      periodicReviewsDue: await dueReviews(db, now),
    });
  });

  return router;
};
