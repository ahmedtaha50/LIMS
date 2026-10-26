// Domain: scan lookup (roadmap M29, UX-08). Owned by r2-custody-labels; registered in src/server/routes/index.ts and given its rule in
// src/server/authz/routeTable.ts by the wave gate.
//
//   GET /resolve?code=<scanned or typed code>   the record, the address of its page and its blockers in words; 404 for a code that
//                                               names nothing (the screen shows it as an error)                       sample.view
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { resolveCode } from '../custody/resolve';
import { resolveQuerySchema } from '../custody/schemas';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

export const resolveRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/resolve', requireAuth, validate(resolveQuerySchema, 'query'), async (req, res) => {
    const code = String((req.query as { code: string }).code);
    const found = await resolveCode(db, code);
    if (!found) throw new NotFoundError(`No sample, container, storage location, instrument or reagent lot has the code "${code}".`);
    res.json(found);
  });

  return router;
};
