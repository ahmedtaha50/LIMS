/**
 * Out-of-trend alerts (roadmap M39, r3-spc). For every attribute with an Approved baseline, the approved results are run through the
 * baseline's rule set; a violation at a result entered AFTER the baseline's data window becomes one alert (one per baseline, result and
 * rule, so the evaluation can run any number of times). The scheduler runs it (src/server/schedules/oot.ts), QA can run it on demand,
 * and `evaluateSample` is the call a result-approval flow makes for one sample.
 *
 * ADVISORY. Nothing here writes to a result, a sample, a specification or a release: an alert is a prompt for an assessment, which QA
 * records by acknowledging it with a note (and, where warranted, opening a deviation through the QMS as for any other signal).
 */
import { randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { spcAlerts, spcBaselines } from '../../db/schema/spc';
import { results } from '../../db/schema/samples';
import { writeAudit } from '../../db/utils';
import { RULE_LABELS } from '../../lib/spc';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { ConflictError } from '../http/errors';
import { ensureServicePrincipal } from '../jobs/principal';
import { analyse } from './analysis';
import { SERIES_LIMIT_MAX } from './constants';
import { loadSeries } from './series';

type Baseline = typeof spcBaselines.$inferSelect;

async function evaluateBaseline(db: Db, b: Baseline, actorId: string): Promise<{ evaluated: number; raised: string[] }> {
  const series = await loadSeries(db, { productId: b.productId, parameter: b.parameter, limit: SERIES_LIMIT_MAX });
  const analysis = analyse(series.points, { id: b.id, revision: b.revision, ruleSet: b.ruleSet as 'nelson' | 'westgard', n: b.n, cl: b.cl, mrBar: b.mrBar, sigma: b.sigma, ucl: b.ucl, lcl: b.lcl });
  const raised: string[] = [];
  const after = b.dataTo.getTime();
  for (const p of analysis.points) {
    if (!p.approved || Date.parse(p.enteredAt) <= after) continue;
    for (const v of p.violations) {
      const detail = `${v.label}. Result ${p.resultId} (sample ${p.sampleId}, batch ${p.batch}) = ${p.value}${p.unit ? ` ${p.unit}` : ''}, ${p.z === null ? '' : `${p.z.toFixed(2)} sigma from the centre line `}of baseline revision ${b.revision} (${b.cl.toFixed(4)}; limits ${b.lcl.toFixed(4)} to ${b.ucl.toFixed(4)}). Advisory: the result and its disposition are unchanged.`;
      const id = await withTransaction(db, async (tx) => {
        const row = {
          id: `OOT-${randomBytes(5).toString('hex')}`, baselineId: b.id, productId: b.productId, parameter: b.parameter, resultId: p.resultId, sampleId: p.sampleId,
          batch: p.batch, rule: v.rule, severity: v.severity, value: p.value, z: p.z ?? 0, detail, status: 'Open', detectedBy: actorId,
        };
        const [ins] = await tx.insert(spcAlerts).values(row).onConflictDoNothing({ target: [spcAlerts.baselineId, spcAlerts.resultId, spcAlerts.rule] }).returning({ id: spcAlerts.id });
        if (!ins) return null;
        await writeAudit(tx, actorId, 'Create', 'SpcAlert', ins.id, 'all', '', JSON.stringify(row), `Out-of-trend signal (${RULE_LABELS[v.rule as keyof typeof RULE_LABELS]}) on ${b.parameter}`);
        return ins.id;
      });
      if (id) raised.push(id);
    }
  }
  return { evaluated: analysis.points.filter(p => p.approved).length, raised };
}

/** Evaluates every Approved baseline, or only those of the attributes of one sample. Returns what was read and the alerts raised now. */
export async function evaluateAlerts(db: Db, opts: { actorId?: string; sampleId?: string } = {}): Promise<{ baselines: number; evaluated: number; raised: string[] }> {
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  let baselines = await db.select().from(spcBaselines).where(eq(spcBaselines.status, 'Approved'));
  if (opts.sampleId) {
    const params = new Set((await db.select({ p: results.parameter }).from(results).where(eq(results.sampleId, opts.sampleId))).map(r => r.p));
    baselines = baselines.filter(b => params.has(b.parameter));
  }
  baselines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let evaluated = 0; const raised: string[] = [];
  for (const b of baselines) {
    const r = await evaluateBaseline(db, b, actorId);
    evaluated += r.evaluated; raised.push(...r.raised);
  }
  return { baselines: baselines.length, evaluated, raised };
}

export async function listAlerts(db: Db, q: { status?: string; productId?: string }) {
  const where = [q.status ? eq(spcAlerts.status, q.status) : undefined, q.productId ? eq(spcAlerts.productId, q.productId) : undefined].filter(Boolean) as any[];
  return db.select().from(spcAlerts).where(where.length ? and(...where) : undefined).orderBy(desc(spcAlerts.detectedAt), desc(spcAlerts.id)).limit(500);
}

/** QA records the assessment. Version-checked and audited in one transaction; the alert is closed, nothing else changes. */
export async function acknowledgeAlert(db: Db, user: { id: string }, id: string, body: { note: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const existing = await lockRow(tx, spcAlerts, id);
    if (existing.version !== body.expectedVersion) throw new ConflictError();
    if (existing.status !== 'Open') throw new ConflictError(`Alert ${id} is already ${existing.status}.`);
    const updated = await updateVersioned(tx, spcAlerts, id, body.expectedVersion, { status: 'Acknowledged', acknowledgedBy: user.id, acknowledgedAt: new Date(), acknowledgement: body.note });
    await writeAudit(tx, user.id, 'Acknowledge', 'SpcAlert', id, 'status', 'Open', 'Acknowledged', body.note);
    return updated;
  });
}
