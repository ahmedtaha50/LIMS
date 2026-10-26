// Domain: SPC and out-of-trend trending (roadmap M39, r3-spc). Statistics are in src/lib/spc.ts, the data and baselines in
// src/server/stats. Everything here is ADVISORY: no route changes a result, a specification or a disposition.
//
//   GET  /trending/parameters?productId            numeric parameters of a product with their approved counts       (spc.view)
//   GET  /trending/series?productId&parameter...    the chart: points, limits, rule violations, capability           (spc.view)
//   GET  /trending/baselines?productId&parameter    every revision of the control limits of an attribute            (spc.view)
//   POST /trending/baselines                        compute and set a baseline: reason + e-signature, new revision   (spc.manage)
//   GET  /trending/alerts                           out-of-trend alerts                                              (spc.view)
//   POST /trending/alerts/evaluate                  evaluate every baseline now                                      (spc.manage)
//   POST /trending/alerts/:id/acknowledge           QA records the assessment                                       (spc.manage)
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { products } from '../../db/schema/master';
import { createRouter } from '../core/router';
import type { RouteContext } from '../core/context';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { acknowledgeAlert, evaluateAlerts, listAlerts } from '../stats/alerts';
import { analyse } from '../stats/analysis';
import { createBaseline, currentBaseline, listBaselines } from '../stats/baselines';
import { SERIES_LIMIT_DEFAULT } from '../stats/constants';
import {
  alertAcknowledgeSchema, alertQuerySchema, baselineCreateSchema, baselineQuerySchema, emptyBodySchema, parametersQuerySchema, seriesQuerySchema,
} from '../stats/schemas';
import { loadParameters, loadSeries } from '../stats/series';

export { alertAcknowledgeSchema, alertQuerySchema, baselineCreateSchema, baselineQuerySchema, emptyBodySchema, parametersQuerySchema, seriesQuerySchema };

const actor = (req: unknown) => (req as { user: { id: string } }).user;

export const trendingRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  const requireProduct = async (productId: string) => {
    const [p] = await db.select({ id: products.id, code: products.code, name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
    if (!p) throw new NotFoundError(`Product ${productId} was not found.`);
    return p;
  };

  router.get('/trending/parameters', requireAuth, validate(parametersQuerySchema, 'query'), async (req, res) => {
    const { productId } = req.query as z.infer<typeof parametersQuerySchema>;
    const product = await requireProduct(productId);
    res.json({ product, parameters: await loadParameters(db, productId) });
  });

  router.get('/trending/series', requireAuth, validate(seriesQuerySchema, 'query'), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof seriesQuerySchema>;
    const product = await requireProduct(q.productId);
    const series = await loadSeries(db, { ...q, limit: q.limit ?? SERIES_LIMIT_DEFAULT });
    const baseline = await currentBaseline(db, q.productId, q.parameter);
    const analysis = analyse(series.points, baseline ? { ...baseline, ruleSet: baseline.ruleSet as 'nelson' | 'westgard' } : null, q.ruleSet);
    res.json({
      advisory: 'Trending output is advisory: it never changes a result or a disposition.',
      product, parameter: q.parameter,
      baseline: baseline ? { id: baseline.id, revision: baseline.revision, ruleSet: baseline.ruleSet, n: baseline.n, createdAt: baseline.createdAt, reason: baseline.reason, exclusions: baseline.exclusions.length } : null,
      ...analysis, skippedNonNumeric: series.skippedNonNumeric, truncated: series.truncated, includesUnapproved: !!q.includeUnapproved,
    });
  });

  router.get('/trending/baselines', requireAuth, validate(baselineQuerySchema, 'query'), async (req, res) => {
    const q = req.query as z.infer<typeof baselineQuerySchema>;
    await requireProduct(q.productId);
    res.json(await listBaselines(db, q.productId, q.parameter));
  });

  router.post('/trending/baselines', requireAuth, validate(baselineCreateSchema), async (req, res) => {
    res.json(await createBaseline(db, actor(req), req.body as z.infer<typeof baselineCreateSchema>));
  });

  router.get('/trending/alerts', requireAuth, validate(alertQuerySchema, 'query'), async (req, res) => {
    res.json(await listAlerts(db, req.query as z.infer<typeof alertQuerySchema>));
  });

  router.post('/trending/alerts/evaluate', requireAuth, validate(emptyBodySchema), async (req, res) => {
    res.json(await evaluateAlerts(db, { actorId: actor(req).id }));
  });

  router.post('/trending/alerts/:id/acknowledge', requireAuth, validate(alertAcknowledgeSchema), async (req, res) => {
    res.json(await acknowledgeAlert(db, actor(req), String(req.params.id), req.body as z.infer<typeof alertAcknowledgeSchema>));
  });

  return router;
};
