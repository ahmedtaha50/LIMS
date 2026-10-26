// Domain: results. Owned by r1-results-oos. The write itself is src/server/services/saveResult.ts (roadmap M10).
import { resultUpdateSchema } from '../../lib/validations/results';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { withTransaction } from '../core/tx';
import { validate } from '../http/validate';
import { saveResult } from '../services/saveResult';

export const resultsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.put('/samples/:id/results/:resultId', requireAuth, validate(resultUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const saved = await withTransaction(db, (tx, afterCommit) => saveResult({
      tx, afterCommit, io: (req as any).io, user,
      sampleId: String(req.params.id), resultId: String(req.params.resultId), input: req.body,
    }));
    res.json(saved);
  });

  return router;
};
