// Domain: capture profiles of instruments (roadmap M21). Owned by r2-instrument-integration.
//
//   GET  /instrument-parsers                  the parsers a profile can use
//   GET  /instrument-profiles                 every profile, with its instrument
//   POST /instrument-profiles                 a new profile (Draft): instrument, folder, file-name pattern, parser, mapping
//   PUT  /instrument-profiles/:id             edits a profile. The mapping decides which number becomes which result, so editing an
//                                             Approved profile makes it Draft again (its approval is cleared) and it is watched no more
//   POST /instrument-profiles/dry-run         parses text with a parser and mapping and returns the rows, or the readable error
//   POST /instrument-profiles/:id/approve     e-signed INSTRUMENT_PROFILE_APPROVAL (QA, Admin), never by anyone who wrote or edited the
//                                             profile (403 SOD_VIOLATION). The signature is bound to the profile version it approved
//   POST /instrument-profiles/:id/retire      a profile that is no longer used (final), with a reason
//
// Every write is audited in its own transaction, carries the version predicate, and keeps a revision of the content (append-only):
// what a signature covers stays verifiable after a later edit. The watched folder is checked here and again each time it is scanned.
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { instrumentProfileRevisions, instrumentProfiles, instruments, PROFILE_PARSERS } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { signatureFields } from '../../lib/validations/signatures';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, auditParticipants, SodViolationError } from '../authz/sod';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { registerSignable, signRecord } from '../esign';
import { watchDirProblem, GLOB_PATTERN } from '../connectors/paths';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../http/errors';
import { validate } from '../http/validate';
import { checkMapping, parseInstrumentFile, parserList, ParseError } from '../parsers';

// ---- request schemas (strict; id, status, version, approval and creator are the server's) ----------------------------------------

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);
const expectedVersion = z.number('expectedVersion must be a number').int().positive('Record version mismatch. Refresh required.');
const reason = z.string('A reason is required.').trim().min(5, 'A clear reason is required (at least 5 characters, ALCOA+).').max(1000);
const parser = z.enum(PROFILE_PARSERS, { error: `parser must be one of ${PROFILE_PARSERS.join(', ')}.` });
const glob = z.string().trim().regex(GLOB_PATTERN, 'The file-name pattern may contain letters, digits, space, . _ - and the wildcards * and ? (no folder).');
const mapping = z.record(z.string(), z.unknown(), { error: 'mapping must be an object.' });

export const instrumentProfileCreateSchema = z.object({
  instrumentId: text('instrumentId', 100), name: text('Profile name', 100), parser, watchDir: text('Watch folder', 500), glob: glob.default('*'), mapping: mapping.default({}),
}).strict();
export const instrumentProfileUpdateSchema = z.object({
  expectedVersion, name: text('Profile name', 100).optional(), parser: parser.optional(), watchDir: text('Watch folder', 500).optional(),
  glob: glob.optional(), mapping: mapping.optional(), reason,
}).strict().refine(b => ['name', 'parser', 'watchDir', 'glob', 'mapping'].some(k => (b as Record<string, unknown>)[k] !== undefined), { message: 'Nothing to change.' });
export const instrumentProfileApproveSchema = z.object({
  expectedVersion, password: signatureFields.password, totpCode: signatureFields.totpCode, reason: signatureFields.reason,
}).strict();
export const instrumentProfileRetireSchema = z.object({ expectedVersion, reason }).strict();
export const instrumentProfileDryRunSchema = z.object({ parser, mapping: mapping.default({}), content: z.string({ error: 'content is required.' }).min(1, 'content is required.').max(200_000, 'content is too long for a dry run (at most 200 000 characters).') }).strict();

// ---- what a signature covers ------------------------------------------------------------------------------------------------------

type Profile = typeof instrumentProfiles.$inferSelect;
const contentOf = (p: Pick<Profile, 'instrumentId' | 'name' | 'parser' | 'watchDir' | 'glob' | 'mapping'>) => (
  { instrumentId: p.instrumentId, name: p.name, parser: p.parser, watchDir: p.watchDir, glob: p.glob, mapping: p.mapping }
);

// A signature on a profile covers the content of the revision it was made on (instrument, folder, pattern, parser, mapping).
registerSignable({
  type: 'InstrumentProfile',
  async canonical(ex, { id, recordVersion }) {
    const [rev] = await ex.select().from(instrumentProfileRevisions)
      .where(and(eq(instrumentProfileRevisions.profileId, id), eq(instrumentProfileRevisions.version, recordVersion))).limit(1);
    return rev ? { id, version: recordVersion, ...rev.snapshot } : null;
  },
});

// ---- helpers -----------------------------------------------------------------------------------------------------------------------

const auditValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function snapshot(tx: Tx, p: Profile, userId: string) {
  await tx.insert(instrumentProfileRevisions).values({
    id: `IPV-${randomBytes(6).toString('hex')}`, profileId: p.id, version: p.version, snapshot: contentOf(p), changedBy: userId,
  });
}

function checkContent(c: { parser: string; watchDir: string; mapping: unknown }) {
  const dir = watchDirProblem(c.watchDir);
  if (dir) throw new ValidationError(dir, [{ path: 'watchDir', message: dir }]);
  const m = checkMapping(c.parser, c.mapping);
  if (!m.ok) throw new ValidationError(m.issues.map(i => `${i.path}: ${i.message}`).join(', '), m.issues);
  return m.mapping;
}

const present = (p: Profile & { instrumentName?: string | null }) => ({
  ...p, createdAt: p.createdAt.toISOString(), approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
});

export const instrumentProfilesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/instrument-parsers', requireAuth, (_req, res) => { res.json(parserList()); });

  router.get('/instrument-profiles', requireAuth, async (_req, res) => {
    const rows = await db.select({ p: instrumentProfiles, instrumentName: instruments.name }).from(instrumentProfiles)
      .innerJoin(instruments, eq(instruments.id, instrumentProfiles.instrumentId)).orderBy(asc(instrumentProfiles.id));
    res.json(rows.map(r => ({ ...present(r.p), instrumentName: r.instrumentName })));
  });

  router.post('/instrument-profiles', requireAuth, validate(instrumentProfileCreateSchema), async (req, res) => {
    const user = (req as any).user as { id: string };
    const b = req.body as z.infer<typeof instrumentProfileCreateSchema>;
    const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, b.instrumentId)).limit(1);
    if (!inst) throw new ValidationError(`Instrument ${b.instrumentId} does not exist.`, [{ path: 'instrumentId', message: 'Unknown instrument.' }]);
    const checked = checkContent(b);
    const row = await withTransaction(db, async (tx) => {
      const [taken] = await tx.select({ id: instrumentProfiles.id }).from(instrumentProfiles).where(eq(instrumentProfiles.name, b.name)).limit(1);
      if (taken) throw new AppError(409, 'PROFILE_EXISTS', `A capture profile named "${b.name}" already exists.`);
      const [created] = await tx.insert(instrumentProfiles).values({
        id: `IPR-${randomBytes(6).toString('hex')}`, instrumentId: b.instrumentId, name: b.name, parser: b.parser, watchDir: b.watchDir, glob: b.glob,
        mapping: checked, status: 'Draft', createdBy: user.id, version: 1,
      }).returning();
      await snapshot(tx, created, user.id);
      await writeAudit(tx, user.id, 'Create', 'InstrumentProfile', created.id, 'all', '', JSON.stringify(contentOf(created)), `Capture profile ${b.name} defined (draft, not yet approved)`);
      return created;
    });
    res.status(201).json(present(row));
  });

  router.put('/instrument-profiles/:id', requireAuth, validate(instrumentProfileUpdateSchema), async (req, res) => {
    const user = (req as any).user as { id: string };
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof instrumentProfileUpdateSchema>;
    const row = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, instrumentProfiles, id);
      if (current.status === 'Retired') throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: capture profile ${current.name} is retired.`);
      if (current.version !== b.expectedVersion) throw new ConflictError();
      const next = {
        name: b.name ?? current.name, parser: b.parser ?? current.parser, watchDir: b.watchDir ?? current.watchDir, glob: b.glob ?? current.glob,
        mapping: (b.mapping ?? current.mapping) as Record<string, unknown>,
      };
      next.mapping = checkContent(next);
      if (next.name !== current.name) {
        const [taken] = await tx.select({ id: instrumentProfiles.id }).from(instrumentProfiles).where(eq(instrumentProfiles.name, next.name)).limit(1);
        if (taken) throw new AppError(409, 'PROFILE_EXISTS', `A capture profile named "${next.name}" already exists.`);
      }
      const wasApproved = current.status === 'Approved';
      const updated = await updateVersioned(tx, instrumentProfiles, id, b.expectedVersion, {
        ...next, status: 'Draft', approvedBy: null, approvedAt: null,
      });
      await snapshot(tx, updated, user.id);
      for (const field of ['name', 'parser', 'watchDir', 'glob', 'mapping'] as const) {
        if (auditValue(current[field]) === auditValue(updated[field])) continue;
        await writeAudit(tx, user.id, 'Update', 'InstrumentProfile', id, field, auditValue(current[field]), auditValue(updated[field]), b.reason);
      }
      if (wasApproved) {
        await writeAudit(tx, user.id, 'Update', 'InstrumentProfile', id, 'status', 'Approved', 'Draft', `Approval withdrawn by the edit: ${b.reason}. The profile is not watched until it is approved again.`);
      }
      return updated;
    });
    res.json(present(row));
  });

  router.post('/instrument-profiles/dry-run', requireAuth, validate(instrumentProfileDryRunSchema), async (req, res) => {
    const b = req.body as z.infer<typeof instrumentProfileDryRunSchema>;
    const checked = checkMapping(b.parser, b.mapping);
    if (!checked.ok) throw new ValidationError(checked.issues.map(i => `${i.path}: ${i.message}`).join(', '), checked.issues);
    try {
      const rows = parseInstrumentFile(b.parser, checked.mapping, b.content);
      res.json({ ok: true, rowCount: rows.length, rows: rows.slice(0, 50).map(({ line, sampleRef, parameter, value, unit }) => ({ line, sampleRef, parameter, value, unit })) });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      res.json({ ok: false, rowCount: 0, rows: [], error: e.message });
    }
  });

  router.post('/instrument-profiles/:id/approve', requireAuth, validate(instrumentProfileApproveSchema), async (req: Request, res) => {
    const user = (req as any).user as { id: string; role: string };
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof instrumentProfileApproveSchema>;
    const [profile] = await db.select().from(instrumentProfiles).where(eq(instrumentProfiles.id, id)).limit(1);
    if (!profile) throw new NotFoundError('Capture profile not found.');
    if (profile.status !== 'Draft') throw new AppError(409, 'PROFILE_NOT_DRAFT', `Capture profile ${profile.name} is ${profile.status}: only a draft is approved.`);
    if (profile.version !== b.expectedVersion) throw new ConflictError();
    // Independence first, so a refused approver loses no signature attempt: nobody who wrote or edited the profile approves it.
    try {
      assertIndependent(await auditParticipants(db, 'InstrumentProfile', id, ['Create', 'Update']), user.id,
        { code: 'instrument.profile.approve', description: 'The person who approves a capture profile must not be the person who defined or last edited it.' },
        { entity: 'InstrumentProfile', entityId: id });
    } catch (e) {
      if (e instanceof SodViolationError) await recordDenied(db, req, user, { route: req.path, ...(e.details as object) });
      throw e;
    }
    checkContent(profile);

    const { result, signature } = await signRecord({
      db, user, meaningCode: 'INSTRUMENT_PROFILE_APPROVAL', credentials: { password: b.password, totpCode: b.totpCode }, reason: b.reason,
      entityType: 'InstrumentProfile', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, instrumentProfiles, id);
        if (current.status !== 'Draft') throw new AppError(409, 'PROFILE_NOT_DRAFT', `Capture profile ${current.name} is ${current.status}: only a draft is approved.`);
        const row = await updateVersioned(tx, instrumentProfiles, id, b.expectedVersion, { status: 'Approved', approvedBy: user.id, approvedAt: new Date() });
        await snapshot(tx, row, user.id);
        return {
          recordVersion: row.version,
          audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Approved', reason: b.reason || `Capture profile ${row.name} approved: its folder, parser and mapping may capture results` },
          result: row,
        };
      },
    });
    res.json({ profile: present(result), signature });
  });

  router.post('/instrument-profiles/:id/retire', requireAuth, validate(instrumentProfileRetireSchema), async (req, res) => {
    const user = (req as any).user as { id: string };
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof instrumentProfileRetireSchema>;
    const row = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, instrumentProfiles, id);
      if (current.status === 'Retired') throw new AppError(409, 'PROFILE_RETIRED', `Capture profile ${current.name} is already retired.`);
      if (current.version !== b.expectedVersion) throw new ConflictError();
      const updated = await updateVersioned(tx, instrumentProfiles, id, b.expectedVersion, { status: 'Retired', approvedBy: null, approvedAt: null });
      await snapshot(tx, updated, user.id);
      await writeAudit(tx, user.id, 'Retire', 'InstrumentProfile', id, 'status', current.status, 'Retired', b.reason);
      return updated;
    });
    res.json(present(row));
  });

  return router;
};
