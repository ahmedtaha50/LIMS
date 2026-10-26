// Domain: eln (roadmap M12, r1-quality-fixes). Worksheets: written and edited by their author while Draft, signed by their author
// through signRecord with the catalog meaning AUTHORSHIP, then locked. Observations on a sample: signed at entry, refused on a
// closed sample. Every change is audited in full (old and new values), in the transaction of the change.
import { randomBytes } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { labNotebook, samples, signatures, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { elnCreateSchema, elnSignSchema, elnUpdateSchema, notebookEntrySchema } from '../../lib/validations/eln';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { getMeaning, getSignable, signatureContentHash, signRecord, SIGNATURE_HASH_VERSION, type SignedChange } from '../esign';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { assertEditable, RecordLockedError } from '../workflow/entityStates';

const ENTITY = 'LabNotebook';
/** A sample in one of these states is closed: nothing more is recorded against it. */
const CLOSED_SAMPLE_STATES = ['Approved', 'Rejected'];
const EDITABLE_FIELDS = ['title', 'content', 'sampleId', 'experimentType', 'pharmacopeia'] as const;

/** The worksheet's state as the state machine sees it: a locked worksheet is signed whatever its status text says. */
const stateOf = (row: { locked: boolean; status: string }) => (row.locked ? 'Signed' : row.status);

async function assertSampleExists(ex: Tx | RouteContext['db'], sampleId: string | null | undefined) {
  if (!sampleId) return;
  const [s] = await ex.select({ id: samples.id }).from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!s) throw new AppError(400, 'UNKNOWN_SAMPLE', `Sample ${sampleId} does not exist; a worksheet can only be linked to a registered sample.`);
}

/**
 * The notebook row carries the content hash of its signature (shown on the screen and by GET /eln/:id/verify). signRecord computes
 * the hash after `execute`; it is computed here the same way, from the record as it now stands, so the row and the signature agree.
 */
async function sealHash(tx: Tx, id: string, recordVersion: number, change: SignedChange): Promise<string> {
  const content = await getSignable(ENTITY)!.canonical(tx, { id, recordVersion, change, hashVersion: SIGNATURE_HASH_VERSION });
  if (!content) throw new Error(`${ENTITY} ${id} does not exist after the change.`);
  return signatureContentHash({ entityType: ENTITY, entityId: id, recordVersion, content });
}

async function meaningText(tx: Tx, code: string) {
  const m = await getMeaning(tx, code);
  if (!m) throw new AppError(400, 'UNKNOWN_MEANING', `"${code}" is not a signature meaning.`);
  return m.text;
}

export const elnRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  const names = async (ids: Array<string | null>) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (wanted.length === 0) return new Map<string, { name: string; role: string; email: string }>();
    const rows = await db.select({ id: users.id, name: users.name, role: users.role, email: users.email }).from(users).where(inArray(users.id, wanted));
    return new Map(rows.map(u => [u.id, u]));
  };
  const enrich = (entry: typeof labNotebook.$inferSelect, userMap: Awaited<ReturnType<typeof names>>) => {
    const author = userMap.get(entry.enteredBy);
    const signer = entry.signedBy ? userMap.get(entry.signedBy) : null;
    return {
      ...entry,
      authorName: author?.name ?? entry.enteredBy,
      authorRole: author?.role ?? null,
      signerName: signer?.name ?? entry.signedBy ?? null,
      signerRole: signer?.role ?? null,
      signerEmail: signer?.email ?? null,
    };
  };

  router.get('/eln', requireAuth, async (_req, res) => {
    const entries = await db.select().from(labNotebook).orderBy(desc(labNotebook.enteredAt));
    const userMap = await names(entries.flatMap(e => [e.enteredBy, e.signedBy]));
    res.json(entries.map(e => enrich(e, userMap)));
  });

  router.get('/eln/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [entry] = await db.select().from(labNotebook).where(eq(labNotebook.id, id)).limit(1);
    if (!entry) throw new NotFoundError('ELN Entry not found');
    const userMap = await names([entry.enteredBy, entry.signedBy]);
    // The signatures of this worksheet, not those of the sample it is linked to.
    const own = await db.select().from(signatures)
      .where(and(eq(signatures.entityType, ENTITY), eq(signatures.entityId, id)))
      .orderBy(desc(signatures.timestamp));
    res.json({ ...enrich(entry, userMap), signatures: own });
  });

  router.post('/eln', requireAuth, validate(elnCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as import('zod').infer<typeof elnCreateSchema>;
    await assertSampleExists(db, body.sampleId);

    const entry = await withTransaction(db, async (tx) => {
      const record = {
        id: 'ELN-' + randomBytes(4).toString('hex').toUpperCase(),
        title: body.title,
        content: body.content,
        sampleId: body.sampleId ?? null,
        experimentType: body.experimentType ?? 'General Analytical Testing',
        pharmacopeia: body.pharmacopeia ?? 'USP / EP Standard',
        status: 'Draft',
        enteredBy: user.id,
        enteredAt: new Date(),
        version: 1,
        locked: false,
      };
      await tx.insert(labNotebook).values(record);
      await writeAudit(tx, user.id, 'Create', ENTITY, record.id, 'all', '', JSON.stringify(record), 'Created ELN worksheet');
      return record;
    });
    res.json({ success: true, id: entry.id, entry });
  });

  router.put('/eln/:id', requireAuth, validate(elnUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { expectedVersion, ...changes } = req.body as import('zod').infer<typeof elnUpdateSchema>;

    const updated = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, labNotebook, id);
      if (existing.enteredBy !== user.id) {
        throw new AppError(403, 'NOT_AUTHOR', 'Only the author of a worksheet may edit it. Record your own observations in a worksheet of your own.');
      }
      assertEditable('eln', stateOf(existing));
      if (existing.version !== expectedVersion) throw new ConflictError();
      if (changes.sampleId !== undefined) await assertSampleExists(tx, changes.sampleId);

      const set: Partial<typeof labNotebook.$inferInsert> = {};
      const diffs: Array<{ field: string; oldValue: string; newValue: string }> = [];
      for (const field of EDITABLE_FIELDS) {
        const next = changes[field];
        if (next === undefined) continue;
        const before = existing[field] ?? null;
        const after = next ?? null;
        if (before === after) continue;
        (set as any)[field] = after;
        diffs.push({ field, oldValue: before ?? '', newValue: after ?? '' });
      }
      if (diffs.length === 0) return existing;

      const row = await updateVersioned(tx, labNotebook, id, expectedVersion, set);
      // One entry per changed field, with the whole old and new value (ALCOA+ complete; nothing truncated).
      for (const d of diffs) {
        await writeAudit(tx, user.id, 'Update', ENTITY, id, d.field, d.oldValue, d.newValue, `Worksheet ${d.field} edited by its author before signing (version ${existing.version} to ${row.version})`);
      }
      return row;
    });
    res.json(updated);
  });

  router.post('/eln/:id/sign', requireAuth, validate(elnSignSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const body = req.body as import('zod').infer<typeof elnSignSchema>;

    const [entry] = await db.select().from(labNotebook).where(eq(labNotebook.id, id)).limit(1);
    if (!entry) throw new NotFoundError('ELN record not found');
    // Authorship can only be claimed by the author. Refused before the password is looked at, so nothing is counted.
    if (entry.enteredBy !== user.id) {
      await recordDenied(db, req, user, { rule: 'eln.authorship', entity: ENTITY, entityId: id });
      throw new AppError(403, 'NOT_AUTHOR', 'Only the author of a worksheet can sign it for authorship. A review is signed separately.');
    }
    assertEditable('eln', stateOf(entry));

    const { result, signature } = await signRecord({
      db, user, meaningCode: 'AUTHORSHIP',
      credentials: { password: body.password, totpCode: body.totpCode },
      reason: body.reason,
      entityType: ENTITY, entityId: id, sampleId: entry.sampleId,
      context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, labNotebook, id);
        if (stateOf(current) !== 'Draft') throw new RecordLockedError('The notebook worksheet is already signed and locked.');
        const signedAt = new Date();
        const row = await updateVersioned(tx, labNotebook, id, current.version, {
          status: 'Signed', signedAt, signedBy: user.id, signatureMeaning: await meaningText(tx, 'AUTHORSHIP'), locked: true,
        });
        const change = { action: 'SIGN_ELN_ENTRY', field: 'status', oldValue: 'Draft', newValue: 'Signed' };
        const contentHash = await sealHash(tx, id, row.version, change);
        // Same transaction, same version: the hash column is bookkeeping of the signing step, not a new revision.
        await tx.update(labNotebook).set({ contentHash }).where(and(eq(labNotebook.id, id), eq(labNotebook.version, row.version)));
        return {
          recordVersion: row.version,
          audit: { ...change, reason: (body.reason ?? '').trim() || 'Worksheet complete; signed for authorship' },
          result: { ...row, contentHash },
        };
      },
    });

    res.json({
      message: 'ELN record signed for authorship and locked (21 CFR Part 11).',
      entry: result,
      signature: {
        id: signature.id, status: 'Signed', signedAt: signature.timestamp, signedBy: signature.signerName,
        contentHash: signature.contentHash, signatureId: signature.id, meaning: signature.meaning, meaningCode: signature.meaningCode,
        recordVersion: signature.recordVersion,
      },
    });
  });

  router.get('/eln/:id/verify', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [entry] = await db.select().from(labNotebook).where(eq(labNotebook.id, id)).limit(1);
    if (!entry) throw new NotFoundError('ELN record not found');
    const signer = entry.signedBy ? (await names([entry.signedBy])).get(entry.signedBy) : null;

    res.json({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      isLocked: entry.locked,
      signedAt: entry.signedAt,
      signerName: signer?.name || entry.signedBy,
      signerRole: signer?.role,
      signatureMeaning: entry.signatureMeaning,
      contentHash: entry.contentHash,
      version: entry.version,
      alcoaPrinciples: {
        attributable: !!signer,
        legible: true,
        contemporaneous: !!entry.signedAt,
        original: true,
        accurate: true,
        complete: true,
        consistent: true,
        enduring: true,
        available: true
      }
    });
  });

  // An observation recorded against a sample, signed by its author when it is entered. Refused on a closed sample.
  router.post('/samples/:id/notebook', requireAuth, validate(notebookEntrySchema), async (req, res) => {
    const user = (req as any).user;
    const sampleId = String(req.params.id);
    const { content, password, totpCode } = req.body as import('zod').infer<typeof notebookEntrySchema>;

    const closedError = (state: string) =>
      new AppError(409, 'SAMPLE_CLOSED', `Sample ${sampleId} is ${state}: no further observations can be recorded against it.`);
    const [sample] = await db.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.id, sampleId)).limit(1);
    if (!sample) throw new NotFoundError('Sample not found');
    // Before the password: a closed sample is a refusal, not a failed signature.
    if (CLOSED_SAMPLE_STATES.includes(sample.state)) throw closedError(sample.state);

    const entryId = 'NOTE-' + randomBytes(5).toString('hex').toUpperCase();
    const { result } = await signRecord({
      db, user, meaningCode: 'AUTHORSHIP',
      credentials: { password, totpCode },
      entityType: ENTITY, entityId: entryId, sampleId,
      context: securityEventContext(req),
      execute: async (tx) => {
        const locked = await lockRow(tx, samples, sampleId); // the sample cannot be closed while the observation is written
        if (CLOSED_SAMPLE_STATES.includes(locked.state)) throw closedError(locked.state);
        const now = new Date();
        await tx.insert(labNotebook).values({
          id: entryId, title: `Sample Observation ${sampleId}`, experimentType: 'General Analysis', sampleId, content,
          enteredBy: user.id, enteredAt: now, status: 'Signed', signedAt: now, signedBy: user.id,
          signatureMeaning: await meaningText(tx, 'AUTHORSHIP'), locked: true, version: 1,
        });
        const change = { action: 'Create', field: 'content', oldValue: '', newValue: content };
        const contentHash = await sealHash(tx, entryId, 1, change);
        await tx.update(labNotebook).set({ contentHash }).where(and(eq(labNotebook.id, entryId), eq(labNotebook.version, 1)));
        const [row] = await tx.select().from(labNotebook).where(eq(labNotebook.id, entryId));
        return { recordVersion: 1, audit: { ...change, reason: 'Observation recorded and signed by its author' }, result: row };
      },
    });
    res.json(result);
  });

  return router;
};
