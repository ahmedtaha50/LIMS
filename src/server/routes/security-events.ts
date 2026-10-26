// Domain: audit (security events). Mounted by routes/audit.ts: the registry lists one module per domain, and the security log
// is part of the audit domain. Readable by Admin and QA only, like the audit trail.
import { requireRoles } from '../audit/access';
import { securityEventsQuery } from '../audit/schemas';
import { querySecurityEvents, securityEventTypes, verifySecurityChain } from '../audit/securityEvents';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import { emptyBody } from '../audit/schemas';

export const securityEventsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const adminOrQa = requireRoles('Admin', 'QA');

  router.get('/security-events', requireAuth, adminOrQa, validate(securityEventsQuery, 'query'), async (req, res) => {
    res.json(await querySecurityEvents(db, req.query as any));
  });

  router.get('/security-events/types', requireAuth, adminOrQa, async (_req, res) => {
    res.json({ types: await securityEventTypes(db) });
  });

  router.post('/security-events/verify', requireAuth, adminOrQa, validate(emptyBody), async (_req, res) => {
    res.json({ ...(await verifySecurityChain(db)), verifiedAt: new Date().toISOString() });
  });

  return router;
};
