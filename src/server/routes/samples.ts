// Domain: samples. Owned by r1-results-oos (roadmap M10).
//
//   GET  /samples                 newest first, paged: ?limit (1-1000, default 200), ?cursor (the X-Next-Cursor header of the previous
//                                 page), ?state, ?batch. The body stays a list; X-Next-Cursor is absent on the last page.
//   POST /samples                 the id from the per-year counter, bound to the specification revision in force (resolveActiveSpec),
//                                 one result per parameter with the parameter's limit copied onto it, all in one transaction.
//   POST /samples/bulk-import     the same for up to 500 rows, validated as a whole, written set-based in one transaction.
//   POST /samples/:id/transition  the lifecycle (src/server/workflow/transitions.ts), its guards (src/server/workflow/guards) and the
//                                 signature (signRecord: SUBMIT_FOR_REVIEW, APPROVAL, REJECTION).
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { labNotebook, oosInvestigations, results, samples, signatures, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { limitText } from '../../lib/numeric';
import { bulkImportSchema, sampleListQuerySchema, sampleRegistrationSchema, transitionSchema } from '../../lib/validations/samples';
import type { SpecParameter } from '../../lib/validations/specifications';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { resolveActiveSpec, type ResolvedSpec } from '../lib/specs';
import { assertTransitionGuards } from '../workflow/guards';
import { validateTransition } from '../workflow/transitions';

const pad = (n: number) => String(n).padStart(5, '0');

/**
 * Reserves `count` consecutive numbers of the year's counter and returns the first. The counter row stays locked until the
 * transaction ends, so concurrent registrations queue and never share a number. The counter never falls behind the ids that exist:
 * it continues from the highest SMP-<year>-<n> when that is higher (rows written without the counter, such as the demo seed or a
 * restore of an older backup), so a gap is possible there but a duplicate is not.
 */
async function reserveSampleNumbers(ex: Executor, year: number, count: number): Promise<number> {
  const prefix = `SMP-${year}-`;
  const r = await ex.execute(sql`
    INSERT INTO counters (key, value)
    VALUES (${`sample:${year}`}, (
      SELECT COALESCE(max(substring(id FROM ${`^${prefix}([0-9]+)$`})::bigint), 0) FROM samples WHERE id LIKE ${`${prefix}%`}
    ) + ${count})
    ON CONFLICT (key) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value - ${count}) + ${count}
    RETURNING value`);
  return Number((r as any).rows[0].value) - count + 1;
}

/** SMP-<year>-<n>, n from the counter `sample:<year>` (migration 0002 started each year at its highest existing number). */
export async function nextSampleId(ex: Executor, now = new Date()): Promise<string> {
  const year = now.getFullYear();
  return `SMP-${year}-${pad(await reserveSampleNumbers(ex, year, 1))}`;
}

/** The result rows a sample starts with: one per parameter of its specification revision, with the limit copied. */
function seedResults(sampleId: string, params: readonly SpecParameter[]) {
  return params.map(p => {
    const numeric = p.limit_kind === 'RANGE' || p.limit_kind === 'NMT' || p.limit_kind === 'NLT';
    const lower = numeric && p.limit_kind !== 'NMT' ? p.lower : null;
    const upper = numeric && p.limit_kind !== 'NLT' ? p.upper : null;
    return {
      id: `res-${randomBytes(6).toString('hex')}`, sampleId, parameter: p.name, value: null, isOos: false, version: 1,
      specMin: lower, specMax: upper,
      unit: p.unit || null, limitKind: p.limit_kind, lowerText: limitText(lower, p.decimals), upperText: limitText(upper, p.decimals),
      decimals: numeric ? p.decimals : null, acceptanceText: numeric ? null : p.text,
    };
  });
}

/** The specification revision a registration is bound to, or the reason there is none. */
async function specFor(ex: Executor, material: string): Promise<{ spec: ResolvedSpec } | { error: string }> {
  const spec = await resolveActiveSpec(ex, material);
  if (!spec) return { error: `No Active specification is in force for material '${material}'. Create and approve a specification first.` };
  if (spec.parameters.length === 0) return { error: `The specification ${spec.id} (revision ${spec.revision}) of '${material}' has no parameters.` };
  return { spec };
}

/** Also used by registration from a product batch (src/server/routes/batches.ts, r2-master-data). */
export async function insertSamples(tx: Tx, user: { id: string }, rows: Array<{ material: string; batch: string; spec: ResolvedSpec }>, reason: string, now = new Date()) {
  const year = now.getFullYear();
  const first = await reserveSampleNumbers(tx, year, rows.length);
  const created = rows.map((r, i) => ({
    id: `SMP-${year}-${pad(first + i)}`, material: r.material, batch: r.batch, state: 'Logged', createdBy: user.id,
    specId: r.spec.id, specRevision: r.spec.revision,
  }));
  await tx.insert(samples).values(created);
  await tx.insert(results).values(created.flatMap((s, i) => seedResults(s.id, rows[i].spec.parameters)));
  // Audit entries are a hash chain: one per sample, in order, in this transaction.
  for (const s of created) {
    await writeAudit(tx, user.id, 'Create', 'Sample', s.id, 'field', '', JSON.stringify({ material: s.material, batch: s.batch, specId: s.specId, specRevision: s.specRevision }), reason);
  }
  return created;
}

// ---- paging -------------------------------------------------------------------------------------------------------------------

const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestError('cursor is not valid: use the X-Next-Cursor header of the previous page.');
  return { createdAt, id };
}

// ---- transitions --------------------------------------------------------------------------------------------------------------

const ACTION_TO_STATE: Record<string, string> = { submit: 'Testing', review: 'Pending Review', approve: 'Approved', reject: 'Rejected' };
/** The signature meaning of each signed move (catalog codes; the client never sends a meaning). */
const MEANING_OF: Record<string, string | undefined> = { 'Pending Review': 'SUBMIT_FOR_REVIEW', 'Approved': 'APPROVAL', 'Rejected': 'REJECTION' };

/** Everything that decides whether the move is allowed, short of the signature. Run before signing and again in the transaction. */
async function checkMove(ex: Executor, sample: typeof samples.$inferSelect, newState: string, user: any, expectedVersion: number) {
  if (sample.version !== expectedVersion) throw new ConflictError('Conflict: Sample version mismatch. Refresh and review the current state.');
  const verdict = validateTransition(sample as any, newState as any, user);
  if (!verdict.allowed) throw new BadRequestError(verdict.reason ?? 'Transition not allowed.');
  if (newState === 'Approved' || newState === 'Rejected') {
    // Four-eyes: whoever entered a result of this sample does not approve or reject it.
    const entered = await ex.select({ by: results.enteredBy }).from(results).where(eq(results.sampleId, sample.id));
    if (entered.some(r => r.by === user.id)) {
      throw new BadRequestError('Segregation of Duties (SoD) violation: You cannot review a sample for which you entered results. An independent reviewer is required.');
    }
  }
  await assertTransitionGuards(ex, sample, newState);
}

export const samplesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/samples', requireAuth, validate(sampleListQuerySchema, 'query'), async (req, res) => {
    const { limit, cursor, state, batch } = req.query as unknown as { limit: number; cursor?: string; state?: string; batch?: string };
    const where: SQL[] = [];
    if (state) where.push(eq(samples.state, state));
    if (batch) where.push(eq(samples.batch, batch));
    if (cursor) {
      const c = decodeCursor(cursor);
      where.push(or(lt(samples.createdAt, c.createdAt), and(eq(samples.createdAt, c.createdAt), lt(samples.id, c.id)))!);
    }
    const rows = await db.select().from(samples).where(where.length ? and(...where) : undefined)
      .orderBy(desc(samples.createdAt), desc(samples.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    if (rows.length > limit) res.setHeader('X-Next-Cursor', encodeCursor(page[page.length - 1]));
    res.json(page);
  });

  router.post('/samples', requireAuth, validate(sampleRegistrationSchema), async (req, res) => {
    const user = (req as any).user;
    if (user.role !== 'Analyst' && user.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Forbidden: Insufficient privileges.');
    const { material, batch } = req.body as { material: string; batch: string };
    const created = await withTransaction(db, async (tx) => {
      const found = await specFor(tx, material);
      if ('error' in found) throw new BadRequestError(`Cannot register sample: ${found.error}`);
      const [sample] = await insertSamples(tx, user, [{ material, batch, spec: found.spec }], 'System Registration');
      return sample;
    });
    res.json({ ...created, version: 1 });
  });

  router.post('/samples/bulk-import', requireAuth, validate(bulkImportSchema), async (req, res) => {
    const user = (req as any).user;
    if (user.role !== 'Analyst' && user.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Forbidden: Insufficient privileges.');
    const { items } = req.body as { items: Array<{ material: string; batch: string }> };
    const created = await withTransaction(db, async (tx) => {
      const specs = new Map<string, Awaited<ReturnType<typeof specFor>>>();
      for (const m of new Set(items.map(i => i.material))) specs.set(m, await specFor(tx, m));
      const errors: string[] = [];
      const rows: Array<{ material: string; batch: string; spec: ResolvedSpec }> = [];
      items.forEach((item, i) => {
        const found = specs.get(item.material)!;
        if ('error' in found) errors.push(`Row ${i + 1}: ${found.error}`);
        else rows.push({ ...item, spec: found.spec });
      });
      if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed: nothing was imported.', errors);
      return insertSamples(tx, user, rows, 'Bulk System Registration');
    });
    res.json({ success: true, count: created.length, samples: created.map(s => ({ ...s, version: 1 })) });
  });

  router.get('/samples/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const sample = await db.query.samples.findFirst({ where: eq(samples.id, id) });
    if (!sample) throw new NotFoundError('Sample not found');

    const sampleResults = await db.select().from(results).where(eq(results.sampleId, id)).orderBy(asc(results.parameter));
    const rawSignatures = await db.select().from(signatures).where(eq(signatures.sampleId, id)).orderBy(desc(signatures.timestamp));
    const signerIds = [...new Set(rawSignatures.map(s => s.signerId))];
    const signers = signerIds.length ? await db.select({ id: users.id, name: users.name, role: users.role, email: users.email }).from(users).where(inArray(users.id, signerIds)) : [];
    const userMap = new Map(signers.map(u => [u.id, u]));
    // The snapshot taken at signing (signRecord) is what the signature shows; older rows fall back to the user as it is now.
    const sampleSignatures = rawSignatures.map(s => {
      const signer = userMap.get(s.signerId);
      return { ...s, printedName: s.signerName ?? signer?.name ?? s.signerId, signerRole: s.signerRole ?? signer?.role ?? 'Authorized Signer', signerEmail: signer?.email ?? '' };
    });
    const sampleNotebook = await db.query.labNotebook.findMany({ where: eq(labNotebook.sampleId, id), orderBy: (notes, { asc }) => [asc(notes.enteredAt)] });
    const sampleOos = await db.select().from(oosInvestigations).where(eq(oosInvestigations.sampleId, id)).orderBy(asc(oosInvestigations.id));
    res.json({ sample, results: sampleResults, signatures: sampleSignatures, notebook: sampleNotebook, oos: sampleOos });
  });

  router.post('/samples/:id/transition', requireAuth, validate(transitionSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { action, expectedVersion, reason, password, totpCode } = req.body as { action: string; expectedVersion: number; reason?: string; password?: string; totpCode?: string };
    const newState = ACTION_TO_STATE[action];

    // Decided before the signature is asked for: a refused move costs the signer no attempt.
    const sample = await db.query.samples.findFirst({ where: eq(samples.id, id) });
    if (!sample) throw new NotFoundError('Sample not found');
    await checkMove(db, sample, newState, user, expectedVersion);

    const auditReason = reason || `Transition via ${action}`;
    const move = async (tx: Tx) => {
      const current = await lockRow(tx, samples, id);
      await checkMove(tx, current, newState, user, expectedVersion);
      const row = await updateVersioned(tx, samples, id, expectedVersion, { state: newState });
      return { from: current.state, row };
    };

    const meaningCode = MEANING_OF[newState];
    if (!meaningCode) {
      const row = await withTransaction(db, async (tx) => {
        const { from, row } = await move(tx);
        await writeAudit(tx, user.id, 'Transition', 'Sample', id, 'state', from, newState, auditReason);
        return row;
      });
      return res.json(row);
    }

    if (!password) throw new BadRequestError('Password required for electronic signature');
    const { result, signature } = await signRecord({
      db, user, meaningCode, credentials: { password, totpCode }, reason,
      entityType: 'Sample', entityId: id, sampleId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const { from, row } = await move(tx);
        return { recordVersion: row.version, audit: { action: 'Transition', field: 'state', oldValue: from, newValue: newState, reason: auditReason }, result: row };
      },
    });
    res.json({ ...result, signature });
  });

  return router;
};
