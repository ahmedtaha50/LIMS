// Domain: authorisation (roadmap M09). What the signed-in role may do, the matrix for access review, and the two-person flow that
// changes a user's role. Who may call each route is decided by src/server/authz/routeTable.ts before these handlers run; they
// keep requireAuth so they are protected on their own as well. Mounted by src/server/authz/middleware.ts (not routes/index.ts),
// behind the authorisation layer.
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import { matrixCsv } from '../authz/csv';
import { loadMatrix, permissionsOfRole } from '../authz/grants';
import { approveRoleChange, cancelRoleChange, listRoleChanges, rejectRoleChange, requestRoleChange } from '../authz/roleChange';
import { decideRoleChangeSchema, requestRoleChangeSchema, withdrawRoleChangeSchema } from '../authz/schemas';
import type { UserRow } from '../auth/sessions';

export const permissionsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actorOf = (req: any): UserRow => req.user;

  /** The role in force and every permission code it holds: what the screens use to show or hide an action. */
  router.get('/permissions/me', requireAuth, async (req, res) => {
    const user = actorOf(req);
    res.json({ userId: user.id, role: user.role, permissions: await permissionsOfRole(db, user.role) });
  });

  /** Every role against every permission, as JSON or (?format=csv) as the export for access review. */
  router.get('/permissions/matrix', requireAuth, async (req, res) => {
    const matrix = await loadMatrix(db);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="permission-matrix.csv"');
      return void res.send(matrixCsv(matrix));
    }
    res.json(matrix);
  });

  router.get('/permissions/role-changes', requireAuth, async (_req, res) => {
    res.json({ requests: await listRoleChanges(db) });
  });

  router.post('/permissions/role-changes', requireAuth, validate(requestRoleChangeSchema), async (req, res) => {
    const request = await requestRoleChange(db, actorOf(req), req, req.body);
    res.status(201).json({ request });
  });

  router.post('/permissions/role-changes/:id/approve', requireAuth, validate(decideRoleChangeSchema), async (req, res) => {
    res.json(await approveRoleChange(db, actorOf(req), req, String(req.params.id), req.body));
  });

  router.post('/permissions/role-changes/:id/reject', requireAuth, validate(decideRoleChangeSchema), async (req, res) => {
    res.json({ request: await rejectRoleChange(db, actorOf(req), req, String(req.params.id), req.body) });
  });

  router.post('/permissions/role-changes/:id/cancel', requireAuth, validate(withdrawRoleChangeSchema), async (req, res) => {
    res.json({ request: await cancelRoleChange(db, actorOf(req), String(req.params.id), req.body) });
  });

  return router;
};
