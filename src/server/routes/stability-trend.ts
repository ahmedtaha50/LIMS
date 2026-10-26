// Domain: shelf-life trending of the stability programme (roadmap M39, r3-spc). Read only and advisory.
//
//   GET /stability-trend?productId&parameter[&conditionCode]   per study and condition: the points, the regression and the one-sided 95 %
//                                                              confidence bound estimate (ICH Q1E approach), and per condition the
//                                                              shortest supported estimate over the batches                (spc.view)
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { products } from '../../db/schema/master';
import { createRouter } from '../core/router';
import type { RouteContext } from '../core/context';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { stabilityTrendQuerySchema } from '../stats/schemas';
import { loadStabilityTrend } from '../stats/stability';

export { stabilityTrendQuerySchema };

export const stabilityTrendRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/stability-trend', requireAuth, validate(stabilityTrendQuerySchema, 'query'), async (req, res) => {
    const q = req.query as z.infer<typeof stabilityTrendQuerySchema>;
    const [product] = await db.select({ id: products.id, code: products.code, name: products.name }).from(products).where(eq(products.id, q.productId)).limit(1);
    if (!product) throw new NotFoundError(`Product ${q.productId} was not found.`);
    res.json({ advisory: 'A shelf-life estimate is advisory: it proposes nothing and changes no record.', product, ...(await loadStabilityTrend(db, q)) });
  });

  return router;
};
