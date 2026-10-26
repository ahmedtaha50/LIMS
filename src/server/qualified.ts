// The validated-scope register (roadmap M37, r2-validation; migration 0300_qualified_modules).
//
// A functional module is either undeclared (no row: behaves as it always has), Qualified (its operational qualification is executed and
// accepted) or NotQualified. A write (POST, PUT, PATCH, DELETE) to a NotQualified module is refused before its handler runs:
// 403 MODULE_NOT_QUALIFIED, recorded as a security event. Reads are never blocked, so the data stays visible. The core of the system
// (sign-in, samples, results, workflow, signatures, audit, backup, administration) is not in the catalog: it cannot be switched off.
//
//   GET  /validation/modules                  every catalog module with its declared status (validation.view)
//   POST /validation/modules/:module/status   declare Qualified or NotQualified; QA e-signature (MODULE_QUALIFICATION) bound to the
//                                             record version, audit entry in the same transaction (validation.scope)
//
// Not covered by the guard: writes that no HTTP request makes (scheduler, job handlers, the instrument agent's own paths) and /api/v1
// (machine tokens reach samples and results, which are core).
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { qualifiedModules } from '../db/schema/qualified';
import { signatureFields } from '../lib/validations/signatures';
import { recordDenied } from './authz/denied';
import { securityEventContext } from './auth/events';
import { asyncHandler } from './core/asyncHandler';
import type { Db, RouteContext } from './core/context';
import { createRouter } from './core/router';
import { updateVersioned } from './core/tx';
import { asSigned, registerSignable, signRecord } from './esign';
import { AppError, ConflictError, NotFoundError } from './http/errors';
import { validate } from './http/validate';

export const QUALIFICATION_MEANING = 'MODULE_QUALIFICATION';
export const QUALIFICATION_STATUSES = ['Qualified', 'NotQualified'] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

/** The modules whose scope can be declared: a key, a title and the first path segments (below /api) of their routes. */
export const MODULES: ReadonlyArray<{ key: string; title: string; segments: readonly string[] }> = [
  { key: 'eln', title: 'Electronic laboratory notebook', segments: ['eln', 'notebook-templates'] },
  { key: 'oos', title: 'Out-of-specification investigations', segments: ['oos'] },
  { key: 'stability', title: 'Stability studies', segments: ['stability'] },
  { key: 'environmental-monitoring', title: 'Environmental monitoring', segments: ['em', 'env-records'] },
  { key: 'reagents', title: 'Reagents and prepared solutions', segments: ['reagents', 'reagent-items', 'reagent-lots', 'reagent-materials', 'prepared-solutions', 'result-materials'] },
  { key: 'instruments', title: 'Instruments and instrument data', segments: ['instruments', 'instrument-files', 'instrument-imports', 'instrument-parsers', 'instrument-profiles'] },
  { key: 'documents-training', title: 'Controlled documents and training', segments: ['documents', 'document-versions', 'training'] },
  { key: 'reports', title: 'Reports and Certificates of Analysis', segments: ['reports', 'coa'] },
  { key: 'custody-labels', title: 'Custody, storage and labels', segments: ['custody'] },
  { key: 'worklists', title: 'Worklists', segments: ['worklists'] },
  { key: 'qms', title: 'Deviations, CAPA, change control and audit findings', segments: ['qms'] },
  { key: 'master-data', title: 'Products, batches and customers', segments: ['products', 'batches', 'customers'] },
  { key: 'methods-calc', title: 'Methods, calculations and test plans', segments: ['methods', 'calc', 'test-plans'] },
  { key: 'trending', title: 'SPC and out-of-trend trending', segments: ['trending', 'stability-trend'] },
  { key: 'turnaround', title: 'Turnaround time and business calendar', segments: ['tat'] },
  { key: 'periodic-archive', title: 'Periodic review, retention and archive', segments: ['periodic-reviews', 'retention', 'archive'] },
  { key: 'ai-assistant', title: 'AI assistant', segments: ['ai', 'transcribe'] },
];

const BY_SEGMENT = new Map(MODULES.flatMap(m => m.segments.map(s => [s, m.key] as const)));
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The module a request path (relative to /api, e.g. /batches/PB-1/status) belongs to, or null for the core. */
export const moduleOfPath = (path: string): string | null => BY_SEGMENT.get(path.split('/')[1] ?? '') ?? null;

/**
 * Mounted after the authorisation layer. One primary-key lookup per write to a catalog module; nothing is cached, so a declaration
 * takes effect on the next request in every process.
 */
export function moduleQualificationGuard(db: Db) {
  return asyncHandler(async function moduleQualification(req: Request, _res: Response, next: NextFunction) {
    if (!MUTATING.has(req.method)) return next();
    const module = moduleOfPath(req.path);
    if (!module) return next();
    const [row] = await db.select({ status: qualifiedModules.status }).from(qualifiedModules).where(eq(qualifiedModules.id, module)).limit(1);
    if (row?.status !== 'NotQualified') return next();
    const user = (req as any).user ?? null;
    await recordDenied(db, req, user, { module, reason: 'the module is declared NotQualified' });
    throw new AppError(403, 'MODULE_NOT_QUALIFIED',
      `The module "${module}" is not qualified for GxP use: changes to it are refused. QA must declare it Qualified (Validation, e-signature) first.`, { module });
  });
}

/** POST /validation/modules/:module/status. expectedVersion is 0 for a module that has no declaration yet. */
export const qualifiedStatusSchema = z.object({
  status: z.enum(QUALIFICATION_STATUSES, { error: `status must be one of ${QUALIFICATION_STATUSES.join(', ')}.` }),
  reason: z.string('A reason is required.').trim().min(5, 'Give the reason for the declaration (at least 5 characters).').max(1000),
  evidenceRef: z.string('evidenceRef must be text.').trim().min(1).max(500).optional(),
  expectedVersion: z.number('expectedVersion is required.').int().min(0, 'Record version mismatch. Refresh required.'),
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();

// A signature on a declaration covers the module, the status as signed and the evidence it was declared on.
registerSignable({
  type: 'QualifiedModule',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(qualifiedModules).where(eq(qualifiedModules.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, status: asSigned(change, ['status'], row.status), evidenceRef: row.evidenceRef };
  },
});

export const qualifiedRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/validation/modules', requireAuth, async (_req, res) => {
    const rows = new Map((await db.select().from(qualifiedModules)).map(r => [r.id, r]));
    res.json(MODULES.map(m => {
      const r = rows.get(m.key);
      return {
        module: m.key, title: m.title, segments: m.segments,
        status: r?.status ?? 'Undeclared', declared: !!r, writesAllowed: r?.status !== 'NotQualified',
        reason: r?.reason ?? null, evidenceRef: r?.evidenceRef ?? null, updatedBy: r?.updatedBy ?? null, updatedAt: r?.updatedAt ?? null, version: r?.version ?? 0,
      };
    }));
  });

  router.post('/validation/modules/:module/status', requireAuth, validate(qualifiedStatusSchema), async (req, res) => {
    const user = (req as any).user;
    const key = String(req.params.module);
    const { status, reason, evidenceRef, expectedVersion, password, totpCode } = req.body as z.infer<typeof qualifiedStatusSchema>;
    if (!MODULES.some(m => m.key === key)) throw new NotFoundError(`"${key}" is not a module of the validated-scope register.`);

    // Decided before the signature is asked for: a refused change costs the signer no attempt.
    const check = (row: typeof qualifiedModules.$inferSelect | undefined) => {
      if ((row?.version ?? 0) !== expectedVersion) throw new ConflictError();
      if (row?.status === status) throw new AppError(409, 'ILLEGAL_TRANSITION', `Module ${key} is already ${status}.`);
    };
    const [found] = await db.select().from(qualifiedModules).where(eq(qualifiedModules.id, key)).limit(1);
    check(found);

    const { result, signature } = await signRecord({
      db, user, meaningCode: QUALIFICATION_MEANING, credentials: { password, totpCode }, reason,
      entityType: 'QualifiedModule', entityId: key, context: securityEventContext(req),
      execute: async (tx) => {
        const [current] = await tx.select().from(qualifiedModules).where(eq(qualifiedModules.id, key)).for('update');
        check(current);
        let row: typeof qualifiedModules.$inferSelect;
        if (!current) {
          const inserted = await tx.insert(qualifiedModules).values({ id: key, status, reason, evidenceRef: evidenceRef ?? null, updatedBy: user.id, version: 1 }).onConflictDoNothing().returning();
          if (inserted.length !== 1) throw new ConflictError();
          row = inserted[0];
        } else {
          row = await updateVersioned(tx, qualifiedModules, key, expectedVersion, { status, reason, evidenceRef: evidenceRef ?? null, updatedBy: user.id, updatedAt: new Date() });
        }
        return { recordVersion: row.version, audit: { action: 'ScopeDeclaration', field: 'status', oldValue: current?.status ?? 'Undeclared', newValue: status, reason }, result: row };
      },
    });
    res.json({ module: result, signature });
  });

  return router;
};

