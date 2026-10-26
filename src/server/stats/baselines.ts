/**
 * Control-limit baselines (roadmap M39, r3-spc). A baseline is COMPUTED by the server from the approved results of a window (the client
 * sends the window, the exclusions and the reason, never the limits), so the numbers can be reproduced from the stored ids. Setting one
 * is a signed act (SPC_BASELINE_APPROVAL, bound to the new record version); the previous Approved revision becomes Superseded in the same
 * transaction, each with its audit entry. An Approved baseline is never edited. Every exclusion is named and justified.
 *
 * Refused before the password is checked (no attempt is spent): a stale expectedRevision, an unknown or repeated exclusion, a window
 * with fewer than MIN_BASELINE_POINTS points left, a series with no variation, or more points than one request may use.
 */
import { createHash, randomBytes } from 'crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { spcBaselines, type SpcExclusion } from '../../db/schema/spc';
import { products } from '../../db/schema/master';
import { writeAudit } from '../../db/utils';
import { imrLimits } from '../../lib/spc';
import type { Db } from '../core/context';
import { updateVersioned, type Executor } from '../core/tx';
import { asSigned, registerSignable, signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../http/errors';
import { MIN_BASELINE_POINTS, SERIES_LIMIT_MAX, SPC_BASELINE_APPROVAL } from './constants';
import { loadSeries, type SeriesPoint } from './series';
import type { baselineCreateSchema } from './schemas';

type Row = typeof spcBaselines.$inferSelect;

// The signature covers the limits and the data they were computed from; only the status changes after signing (to Superseded).
registerSignable({
  type: 'SpcBaseline',
  async canonical(ex, { id, change }) {
    const [b] = await ex.select().from(spcBaselines).where(eq(spcBaselines.id, id)).limit(1);
    if (!b) return null;
    return {
      id: b.id, productId: b.productId, parameter: b.parameter, revision: b.revision, ruleSet: b.ruleSet, n: b.n,
      cl: b.cl, mrBar: b.mrBar, sigma: b.sigma, ucl: b.ucl, lcl: b.lcl, dataFrom: b.dataFrom.toISOString(), dataTo: b.dataTo.toISOString(),
      resultIds: b.resultIds, exclusions: b.exclusions, dataHash: b.dataHash, reason: b.reason, status: asSigned(change, ['status'], b.status),
    };
  },
});

export const dataHashOf = (points: Array<Pick<SeriesPoint, 'resultId' | 'value'>>): string =>
  createHash('sha256').update(points.map(p => `${p.resultId}:${p.value}`).join('\n')).digest('hex');

export async function currentBaseline(ex: Executor, productId: string, parameter: string): Promise<Row | undefined> {
  const [row] = await ex.select().from(spcBaselines)
    .where(and(eq(spcBaselines.productId, productId), eq(spcBaselines.parameter, parameter), eq(spcBaselines.status, 'Approved'))).limit(1);
  return row;
}

export async function listBaselines(db: Db, productId: string, parameter: string): Promise<Row[]> {
  return db.select().from(spcBaselines).where(and(eq(spcBaselines.productId, productId), eq(spcBaselines.parameter, parameter))).orderBy(desc(spcBaselines.revision));
}

type Body = z.infer<typeof baselineCreateSchema>;

/** The points and the limits a baseline would have; throws the refusals listed above. Pure reading: used before and inside the signing transaction. */
export async function planBaseline(ex: Executor, b: Pick<Body, 'productId' | 'parameter' | 'from' | 'to' | 'exclusions'>) {
  const series = await loadSeries(ex, { productId: b.productId, parameter: b.parameter, from: b.from, to: b.to, limit: SERIES_LIMIT_MAX });
  if (series.truncated) throw new AppError(409, 'WINDOW_TOO_LARGE', `More than ${SERIES_LIMIT_MAX} results match: narrow the window.`);
  const ids = new Set(series.points.map(p => p.resultId));
  const seen = new Set<string>();
  for (const e of b.exclusions) {
    if (!ids.has(e.resultId)) throw new ValidationError(`Result ${e.resultId} is not an approved result of this attribute in the window.`, [{ path: 'exclusions', message: `Unknown result ${e.resultId}.` }]);
    if (seen.has(e.resultId)) throw new ValidationError(`Result ${e.resultId} is excluded twice.`, [{ path: 'exclusions', message: `Repeated result ${e.resultId}.` }]);
    seen.add(e.resultId);
  }
  const used = series.points.filter(p => !seen.has(p.resultId));
  if (used.length < MIN_BASELINE_POINTS) {
    throw new AppError(409, 'TOO_FEW_POINTS', `A baseline needs at least ${MIN_BASELINE_POINTS} approved results; ${used.length} remain${seen.size ? ` after ${seen.size} exclusion(s)` : ''}.`);
  }
  const limits = imrLimits(used.map(p => p.value));
  if (!(limits.mrBar! > 0)) throw new AppError(409, 'NO_VARIATION', 'The results do not vary (the moving range is 0): there are no control limits to compute.');
  const times = used.map(p => Date.parse(p.enteredAt));
  return { used, limits, dataFrom: new Date(Math.min(...times)), dataTo: new Date(Math.max(...times)), dataHash: dataHashOf(used) };
}

export async function createBaseline(db: Db, user: { id: string }, body: Body) {
  const [product] = await db.select({ id: products.id }).from(products).where(eq(products.id, body.productId)).limit(1);
  if (!product) throw new NotFoundError(`Product ${body.productId} was not found.`);
  const before = await currentBaseline(db, body.productId, body.parameter);
  if ((before?.revision ?? 0) !== body.expectedRevision) throw new ConflictError();
  const plan = await planBaseline(db, body);
  const id = `SPB-${randomBytes(5).toString('hex')}`;

  const { result, signature } = await signRecord({
    db, user, meaningCode: SPC_BASELINE_APPROVAL, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'SpcBaseline', entityId: id,
    execute: async (tx) => {
      // One writer per attribute: the check of the current revision and the insert cannot interleave.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`spc-baseline:${body.productId}:${body.parameter}`}::text))`);
      const current = await currentBaseline(tx, body.productId, body.parameter);
      if ((current?.revision ?? 0) !== body.expectedRevision) throw new ConflictError();
      const again = await planBaseline(tx, body);
      if (again.dataHash !== plan.dataHash) throw new ConflictError(); // the data moved while the signer typed: sign what was shown
      if (current) {
        await updateVersioned(tx, spcBaselines, current.id, current.version, { status: 'Superseded' });
        await writeAudit(tx, user.id, 'StatusChange', 'SpcBaseline', current.id, 'status', 'Approved', 'Superseded', `Superseded by baseline ${id} (revision ${current.revision + 1}): ${body.reason}`);
      }
      const exclusions: SpcExclusion[] = body.exclusions.map(e => ({ resultId: e.resultId, reason: e.reason }));
      const row = {
        id, productId: body.productId, parameter: body.parameter, revision: (current?.revision ?? 0) + 1, status: 'Approved', ruleSet: body.ruleSet,
        n: plan.used.length, cl: plan.limits.cl, mrBar: plan.limits.mrBar!, sigma: plan.limits.sigma, ucl: plan.limits.ucl, lcl: plan.limits.lcl,
        dataFrom: plan.dataFrom, dataTo: plan.dataTo, resultIds: plan.used.map(p => p.resultId), exclusions, dataHash: plan.dataHash,
        reason: body.reason, createdBy: user.id,
      };
      const [created] = await tx.insert(spcBaselines).values(row).returning();
      await writeAudit(tx, user.id, 'Create', 'SpcBaseline', id, 'all', '', JSON.stringify({ ...created, resultIds: `${created.resultIds.length} ids (stored on the record)` }), `Control-limit baseline revision ${created.revision} computed: ${body.reason}`);
      // The signed change names the status, so the signature stays verifiable after this revision is superseded (asSigned).
      return { recordVersion: created.version, result: created, audit: { action: 'Approve', field: 'status', oldValue: '', newValue: 'Approved', reason: body.reason } };
    },
  });
  return { baseline: result, signature };
}

export async function baselinesOfProduct(db: Db, productId: string): Promise<Row[]> {
  return db.select().from(spcBaselines).where(eq(spcBaselines.productId, productId)).orderBy(asc(spcBaselines.parameter), desc(spcBaselines.revision));
}
