// Domain: stability studies (roadmap M31, r2-stability; before that M13, r1-quality-fixes). The programme's other routes (protocols,
// conditions, chambers, the pull calendar and the pull) are in src/server/stability/routes.ts.
//
//   GET  /stability       every study, with its protocol revision (none for a study written before M31) and its timepoint counts
//   POST /stability       a study of a master batch under an Approved protocol revision; its timepoints are generated with it
//   PUT  /stability/:id   only the end of a study: Completed (every timepoint finished) or Aborted, with a reason. Product, batch and
//                         condition are no longer edited (they come from the protocol and the batch). A finished study is final (423).
import { createRouter } from '../core/router';
import { type RouteContext } from '../core/context';
import { validate } from '../http/validate';
import { studyCloseSchema, studyCreateSchema } from '../stability/schemas';
import { closeStudy, createStudy, listStudies } from '../stability/studies';

export const stabilityRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/stability', requireAuth, validate(studyCreateSchema), async (req, res) => {
    res.json(await createStudy(db, (req as any).user, req.body as import('zod').infer<typeof studyCreateSchema>));
  });

  router.put('/stability/:id', requireAuth, validate(studyCloseSchema), async (req, res) => {
    res.json(await closeStudy(db, (req as any).user, String(req.params.id), req.body as import('zod').infer<typeof studyCloseSchema>));
  });

  router.get('/stability', requireAuth, async (_req, res) => {
    res.json(await listStudies(db));
  });

  return router;
};
