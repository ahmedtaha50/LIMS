// Domain: audit. Moved from src/server/api.ts by r1-core, rebuilt by r1-audit (roadmap M08): one verifier, keyset-paged and
// filtered reads, a CSV export that is itself audited, and the per-record history.
import { randomUUID } from 'crypto';
import { desc } from 'drizzle-orm';
import { auditTrail } from '../../db/schema';
import { lockAuditChain, writeAudit } from '../../db/utils';
import { REVIEWER_BLOCKED_ENTITIES, requireRoles } from '../audit/access';
import { verifyAuditChain } from '../audit/chain';
import { queryAudit, streamAuditCsv } from '../audit/query';
import { auditExportBody, auditHistoryQuery, auditListQuery, emptyBody } from '../audit/schemas';
import { recordSecurityEvent, securityEventContext } from '../audit/securityEvents';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { withTransaction } from '../core/tx';
import { ForbiddenError } from '../http/errors';
import { validate } from '../http/validate';
import { securityEventsRoutes } from './security-events';

export const auditRoutes = (ctx: RouteContext) => {
  const { db, requireAuth } = ctx;
  const router = createRouter();
  const adminOrQa = requireRoles('Admin', 'QA');

  // Verifies the whole chain from the first row, in batches, and records the checkpoints it has proven.
  router.post('/audit/verify', requireAuth, adminOrQa, validate(emptyBody), async (req, res) => {
    const user = (req as any).user;
    const result = await verifyAuditChain(db);
    await recordSecurityEvent(db, {
      type: 'AUDIT_VERIFY', outcome: result.isValid ? 'success' : 'failure', actorId: user.id, actorRole: user.role, ...securityEventContext(req),
      detail: { totalRecords: result.totalRecords, headSequence: result.headSequence, compromisedSequence: result.compromisedSequence, reason: result.reason, checkpointsAdded: result.checkpointsAdded },
    });
    res.json({ ...result, verifiedAt: new Date().toISOString() });
  });

  router.get('/audit/head', requireAuth, adminOrQa, async (_req, res) => {
    const [head] = await db.select({ sequence: auditTrail.sequence, hash: auditTrail.hash }).from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
    res.json({ sequence: head?.sequence ?? 0, hash: head?.hash ?? null, at: new Date().toISOString() });
  });

  router.get('/audit', requireAuth, adminOrQa, validate(auditListQuery, 'query'), async (req, res) => {
    const { cursor, limit, order, ...filter } = req.query as any;
    res.json(await queryAudit(db, filter, { cursor, limit, order }));
  });

  // The History tab of one record. Reviewers may read it (reviewing the audit trail of the data under review is part of their
  // task); analysts may not, as with GET /audit.
  router.get('/audit/history', requireAuth, requireRoles('Admin', 'QA', 'Reviewer'), validate(auditHistoryQuery, 'query'), async (req, res) => {
    const user = (req as any).user;
    const { entity, entityId, refs, cursor, limit, order } = req.query as any;
    const pairs: Array<{ entity: string; entityId: string }> = [{ entity, entityId }, ...(refs ?? [])];
    if (user.role === 'Reviewer' && pairs.some(p => REVIEWER_BLOCKED_ENTITIES.has(p.entity))) {
      throw new ForbiddenError('Forbidden: the history of accounts, settings and the audit trail is restricted to Admin and QA.');
    }
    res.json(await queryAudit(db, { pairs }, { cursor, limit, order }));
  });

  // The export is an audited act: the entry is committed first (who, why, which filter, up to which sequence), then the rows
  // are streamed. The rows are those up to the sequence recorded, so the file and the entry describe the same thing.
  router.post('/audit/export', requireAuth, adminOrQa, validate(auditExportBody), async (req, res) => {
    const user = (req as any).user;
    const { reason, ...filter } = req.body;
    const { throughSequence, entry } = await withTransaction(db, async (tx) => {
      await lockAuditChain(tx);
      const [head] = await tx.select({ sequence: auditTrail.sequence }).from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
      const through = head?.sequence ?? 0;
      const written = await writeAudit(tx, user.id, 'Export', 'AuditTrail', `export-${req.id ?? randomUUID()}`, 'filters', '', JSON.stringify({ filters: filter, throughSequence: through }), reason);
      return { throughSequence: through, entry: written };
    });
    await recordSecurityEvent(db, {
      type: 'EXPORT', outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req),
      detail: { entity: 'AuditTrail', auditSequence: entry.sequence, throughSequence, filters: filter },
    });
    res.status(200)
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="audit-trail-${new Date().toISOString().replace(/[:.]/g, '-')}.csv"`)
      .set('Cache-Control', 'no-store');
    await streamAuditCsv(db, filter, throughSequence, res);
    res.end();
  });

  // The security log is part of this domain; see routes/security-events.ts.
  router.use(securityEventsRoutes(ctx));

  return router;
};
