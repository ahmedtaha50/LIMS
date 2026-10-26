/**
 * Controlled documents (roadmap M28, QA-08): the lifecycle of a document version and everything that must be true for each step.
 * The routes (src/server/routes/documents.ts) only parse and call these functions.
 *
 *   Draft --submit (author, DOCUMENT_AUTHORSHIP)--> InReview --review (DOCUMENT_REVIEW)--> InReview (reviewed)
 *         --approve (DOCUMENT_APPROVAL)--> Approved --effective (QA only, DOCUMENT_EFFECTIVE)--> Effective --> Superseded | Obsolete
 *   InReview | Approved --return (reason)--> Draft (the review and approval of that cycle are void)
 *
 * The rules:
 *   - only the author edits a Draft, uploads its file and submits it; a Draft needs a file to be submitted;
 *   - author, reviewer and approver are three different people (403 SOD_VIOLATION); the person who makes a version Effective is not
 *     its author; the role is the meaning's (DOCUMENT_EFFECTIVE: QA only);
 *   - a version becomes Effective only with the three signatures of its current cycle (authorship at submitted_version, then review
 *     and approval, each by the person the row names): 409 SIGNATURES_INCOMPLETE otherwise;
 *   - making a version Effective supersedes the Effective one of the same document, consumes the change control when change control
 *     is required (r2-qms, 409 CHANGE_REQUIRED before the password), and assigns training (src/server/training/assign.ts), all in
 *     the signing transaction;
 *   - every refusal that does not need the password comes first, so it costs the signer no attempt.
 * Files live in the content-addressed blob store (src/server/blobs) and are re-hashed on every download: a file that does not match
 * is refused with 409 DOCUMENT_INTEGRITY_FAILED and an IntegrityCheckFailed audit entry. The database refuses changes to submitted
 * content and to Effective records (trigger gxp_document_versions_row_guard, migration 0200).
 */
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { signatures, users } from '../db/schema';
import { documentPrints, documents, documentVersions } from '../db/schema/documents';
import { writeAudit } from '../db/utils';
import { securityEventContext } from './auth/events';
import { recordDenied } from './authz/denied';
import { assertIndependent, SodViolationError } from './authz/sod';
import type { Db } from './core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Executor, type Tx } from './core/tx';
import { registerSignable, signRecord } from './esign';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './http/errors';
import { todayIso } from './lib/specs';
import { assertChangeAuthorised, consumeChange } from './qms';
import { assignEffectiveVersion, cancelVersionAssignments } from './training/assign';
import { refreshSoftwareFlag } from './training/status';

export type DocumentRow = typeof documents.$inferSelect;
export type VersionRow = typeof documentVersions.$inferSelect;
type Actor = { id: string; role: string };
type Credentials = { password: string; totpCode?: string };

/** The file formats a controlled document may have (detected from the first bytes by src/server/blobs/sniff.ts). */
export const DOCUMENT_FILE_KINDS = ['pdf', 'zip', 'text'];

const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';
const newId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`;
const OPEN = ['Draft', 'InReview', 'Approved'];

/** What a signed step's audit entry records: the state reached and the exact file signed (so the audit chain binds the content). */
const signedState = (status: string, v: VersionRow) => `${status} (rev ${v.revision} ${v.fileName ?? 'no file'} sha256:${v.fileSha256 ?? 'none'})`;

// A signature on a document version binds the signed step as the audit entry recorded it (state and file hash) together with the
// version's identity: a version's content may change again after a return to Draft, and its earlier signatures must still verify.
registerSignable({
  type: 'DocumentVersion',
  async canonical(ex, { id, change }) {
    if (!change) return null;
    const [row] = await ex.select({ id: documentVersions.id, documentId: documentVersions.documentId, revision: documentVersions.revision, authorId: documentVersions.authorId })
      .from(documentVersions).where(eq(documentVersions.id, id)).limit(1);
    if (!row) return null;
    return { ...row, event: { action: change.action, field: change.field, oldValue: change.oldValue, newValue: change.newValue } };
  },
});

// ---- reading ------------------------------------------------------------------------------------------------------------------

export async function findVersion(ex: Executor, id: string): Promise<VersionRow> {
  const [row] = await ex.select().from(documentVersions).where(eq(documentVersions.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Document version ${id} was not found.`);
  return row;
}

export async function findDocument(ex: Executor, id: string): Promise<DocumentRow> {
  const [row] = await ex.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Document ${id} was not found.`);
  return row;
}

/** The calendar day `months` after the instant `from` (server calendar). */
export function addMonths(from: Date, months: number): string {
  const d = new Date(from.getFullYear(), from.getMonth() + months, from.getDate());
  return todayIso(d);
}

const presentVersion = (v: VersionRow) => ({
  ...v,
  submittedAt: v.submittedAt?.toISOString() ?? null, reviewedAt: v.reviewedAt?.toISOString() ?? null, approvedAt: v.approvedAt?.toISOString() ?? null,
  effectiveAt: v.effectiveAt?.toISOString() ?? null, supersededAt: v.supersededAt?.toISOString() ?? null, obsoletedAt: v.obsoletedAt?.toISOString() ?? null,
  createdAt: v.createdAt.toISOString(),
});
export type VersionView = ReturnType<typeof presentVersion>;
export { presentVersion };

/** The register: every document with its Effective version, its open version and the periodic review date. */
export async function listDocuments(db: Db, now = new Date()) {
  const docs = await db.select().from(documents).orderBy(sql`lower(${documents.code})`);
  const versions = await db.select().from(documentVersions).where(inArray(documentVersions.status, ['Effective', ...OPEN]));
  const today = todayIso(now);
  return docs.map(d => {
    const effective = versions.find(v => v.documentId === d.id && v.status === 'Effective') ?? null;
    const open = versions.find(v => v.documentId === d.id && OPEN.includes(v.status)) ?? null;
    const reviewDue = effective?.effectiveAt ? addMonths(effective.effectiveAt, d.reviewPeriodMonths) : null;
    return {
      ...d, createdAt: d.createdAt.toISOString(),
      effective: effective && presentVersion(effective), open: open && presentVersion(open),
      reviewDue, reviewOverdue: !!reviewDue && reviewDue < today,
    };
  });
}

export async function documentDetail(db: Db, id: string) {
  const doc = await findDocument(db, id);
  const versions = await db.select().from(documentVersions).where(eq(documentVersions.documentId, id)).orderBy(desc(documentVersions.revision));
  const sigs = versions.length === 0 ? [] : await db.select({
    id: signatures.id, entityId: signatures.entityId, meaningCode: signatures.meaningCode, meaning: signatures.meaning, signerId: signatures.signerId,
    signerName: signatures.signerName, signerRole: signatures.signerRole, reason: signatures.reason, timestamp: signatures.timestamp, recordVersion: signatures.recordVersion,
  }).from(signatures).where(and(eq(signatures.entityType, 'DocumentVersion'), inArray(signatures.entityId, versions.map(v => v.id)))).orderBy(asc(signatures.timestamp));
  return { document: { ...doc, createdAt: doc.createdAt.toISOString() }, versions: versions.map(presentVersion), signatures: sigs };
}

// ---- drafting -----------------------------------------------------------------------------------------------------------------

export async function createDocument(db: Db, actor: Actor, input: { code: string; title: string; docType: string; reviewPeriodMonths?: number; changeSummary?: string }) {
  try {
    return await withTransaction(db, async (tx) => {
      const [dup] = await tx.select({ code: documents.code }).from(documents).where(sql`lower(${documents.code}) = ${input.code.toLowerCase()}`).limit(1);
      if (dup) throw new AppError(409, 'DUPLICATE', `A document with the code ${dup.code} already exists. Draft a new revision of it instead.`);
      const doc = { id: newId('DOC'), code: input.code, title: input.title, docType: input.docType, reviewPeriodMonths: input.reviewPeriodMonths ?? 24, createdBy: actor.id };
      const [d] = await tx.insert(documents).values(doc).returning();
      await writeAudit(tx, actor.id, 'Create', 'Document', d.id, 'all', '', JSON.stringify(doc), `Controlled document ${doc.code} created`);
      const ver = { id: newId('DV'), documentId: d.id, revision: 1, title: input.title, changeSummary: input.changeSummary ?? '', status: 'Draft', authorId: actor.id };
      const [v] = await tx.insert(documentVersions).values(ver).returning();
      await writeAudit(tx, actor.id, 'Create', 'DocumentVersion', v.id, 'all', '', JSON.stringify(ver), `Revision 1 of ${doc.code} drafted`);
      return { document: { ...d, createdAt: d.createdAt.toISOString() }, version: presentVersion(v) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A document with the code ${input.code} already exists.`);
    throw e;
  }
}

/** The next revision, a Draft by `actor`, starting from the Effective version's title and file. One open version per document. */
export async function reviseDocument(db: Db, actor: Actor, documentId: string) {
  try {
    return await withTransaction(db, async (tx) => {
      const doc = await lockRow(tx, documents, documentId);
      const versions = await tx.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(desc(documentVersions.revision));
      const open = versions.find(v => OPEN.includes(v.status));
      if (open) throw new AppError(409, 'OPEN_VERSION_EXISTS', `Revision ${open.revision} of ${doc.code} is ${open.status}: finish or return it first; a document has one open version at a time.`, { versionId: open.id });
      const effective = versions.find(v => v.status === 'Effective');
      if (!effective) throw new AppError(409, 'NOT_EFFECTIVE', `${doc.code} has no Effective version to revise.`);
      const ver = {
        id: newId('DV'), documentId, revision: versions[0].revision + 1, title: effective.title, changeSummary: '', status: 'Draft', authorId: actor.id,
        fileName: effective.fileName, mediaType: effective.mediaType, bytes: effective.bytes, fileSha256: effective.fileSha256,
      };
      const [v] = await tx.insert(documentVersions).values(ver).returning();
      await writeAudit(tx, actor.id, 'Create', 'DocumentVersion', v.id, 'all', '', JSON.stringify(ver), `Revision ${ver.revision} of ${doc.code} drafted from revision ${effective.revision}`);
      return presentVersion(v);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'OPEN_VERSION_EXISTS', 'Another revision of this document was drafted at the same time.');
    throw e;
  }
}

function assertDraftOfAuthor(v: VersionRow, actor: Actor) {
  if (v.status !== 'Draft') throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: revision ${v.revision} is ${v.status}; only a Draft is changed. Return it to Draft or draft a new revision.`);
  if (v.authorId !== actor.id) throw new ForbiddenError('Only the author of a Draft changes it.');
}

export async function updateDraft(db: Db, actor: Actor, id: string, input: { title?: string; changeSummary?: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const v = await lockRow(tx, documentVersions, id);
    assertDraftOfAuthor(v, actor);
    if (v.version !== input.expectedVersion) throw new ConflictError();
    const set: Partial<VersionRow> = {};
    for (const field of ['title', 'changeSummary'] as const) if (input[field] !== undefined && input[field] !== v[field]) set[field] = input[field]!;
    if (Object.keys(set).length === 0) throw new BadRequestError('Nothing changes: the values sent are the values the version already holds.');
    const row = await updateVersioned(tx, documentVersions, id, input.expectedVersion, set);
    for (const [field, value] of Object.entries(set)) {
      await writeAudit(tx, actor.id, 'Update', 'DocumentVersion', id, field, String((v as any)[field] ?? ''), String(value), `Revision ${v.revision}: ${field} edited`);
    }
    return presentVersion(row);
  });
}

/** Precondition of the upload, checked before the body is read: the version exists, is the actor's Draft, at the expected version. */
export async function assertUploadAllowed(db: Db, actor: Actor, id: string, expectedVersion: number) {
  const v = await findVersion(db, id);
  assertDraftOfAuthor(v, actor);
  if (v.version !== expectedVersion) throw new ConflictError();
  return v;
}

export async function attachFile(db: Db, actor: Actor, id: string, expectedVersion: number, file: { fileName: string; mediaType: string; bytes: number; sha256: string }) {
  return withTransaction(db, async (tx) => {
    const v = await lockRow(tx, documentVersions, id);
    assertDraftOfAuthor(v, actor);
    if (v.version !== expectedVersion) throw new ConflictError();
    const row = await updateVersioned(tx, documentVersions, id, expectedVersion, { fileName: file.fileName, mediaType: file.mediaType, bytes: file.bytes, fileSha256: file.sha256 });
    await writeAudit(tx, actor.id, 'Update', 'DocumentVersion', id, 'file', v.fileSha256 ? `${v.fileName} sha256:${v.fileSha256}` : '',
      `${file.fileName} sha256:${file.sha256}`, `Revision ${v.revision}: file ${file.fileName} (${file.bytes} bytes) attached`);
    return presentVersion(row);
  });
}

// ---- the signed steps ---------------------------------------------------------------------------------------------------------

type Step = 'submit' | 'review' | 'approve' | 'effective' | 'obsolete';
const MEANING: Record<Step, string> = {
  submit: 'DOCUMENT_AUTHORSHIP', review: 'DOCUMENT_REVIEW', approve: 'DOCUMENT_APPROVAL', effective: 'DOCUMENT_EFFECTIVE', obsolete: 'DOCUMENT_OBSOLETE',
};
const ROUTE: Record<Step, string> = Object.fromEntries((Object.keys(MEANING) as Step[]).map(s => [s, `POST /document-versions/:id/${s}`])) as Record<Step, string>;

/** Independence, audited as AUTHZ_DENIED when refused. */
async function assertIndependentOf(db: Db, req: Request, actor: Actor, step: Step, v: VersionRow, people: Array<string | null>, description: string) {
  try {
    assertIndependent(people, actor.id, { code: `document.${step}`, description }, { entity: 'DocumentVersion', entityId: v.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, actor, { route: ROUTE[step], ...(e.details as object) });
    throw e;
  }
}

/** The three signatures of the current cycle, each by the person the row names, three different people; else 409. */
export async function assertCycleSigned(ex: Executor, v: VersionRow) {
  const missing = (what: string): never => {
    throw new AppError(409, 'SIGNATURES_INCOMPLETE', `Revision ${v.revision} cannot become Effective: ${what}. A version needs the signatures of its author, an independent reviewer and an independent approver on the submitted content.`);
  };
  if (!v.submittedVersion) missing('it was never submitted');
  if (!v.reviewerId) missing('the review signature of this cycle is missing');
  if (!v.approverId) missing('the approval signature of this cycle is missing');
  if (new Set([v.authorId, v.reviewerId, v.approverId]).size !== 3) missing('author, reviewer and approver are not three different people');
  const sigs = await ex.select({ meaningCode: signatures.meaningCode, signerId: signatures.signerId }).from(signatures).where(and(
    eq(signatures.entityType, 'DocumentVersion'), eq(signatures.entityId, v.id), gte(signatures.recordVersion, v.submittedVersion!),
  ));
  const has = (meaning: string, signer: string | null) => sigs.some(s => s.meaningCode === meaning && s.signerId === signer);
  if (!has('DOCUMENT_AUTHORSHIP', v.authorId)) missing('the authorship signature of this cycle is missing');
  if (!has('DOCUMENT_REVIEW', v.reviewerId)) missing('the review signature of this cycle is missing');
  if (!has('DOCUMENT_APPROVAL', v.approverId)) missing('the approval signature of this cycle is missing');
}

const wrongState = (v: VersionRow, step: Step, need: string): never => {
  throw new AppError(409, 'ILLEGAL_TRANSITION', `Revision ${v.revision} is ${v.status}; ${step} needs a version that is ${need}.`);
};

/** Every check of a step that does not need the password. Run before the signature and again inside its transaction. */
async function precheck(ex: Executor, actor: Actor, step: Step, v: VersionRow) {
  switch (step) {
    case 'submit':
      if (v.status !== 'Draft') wrongState(v, step, 'a Draft');
      if (v.authorId !== actor.id) throw new ForbiddenError('Only the author submits a Draft: the submission is the authorship signature.');
      if (!v.fileSha256) throw new AppError(409, 'FILE_REQUIRED', `Revision ${v.revision} has no file. Attach the document before submitting it.`);
      return;
    case 'review':
      if (v.status !== 'InReview') wrongState(v, step, 'in review');
      if (v.reviewerId) throw new AppError(409, 'ALREADY_REVIEWED', `Revision ${v.revision} has already been reviewed in this cycle.`);
      return;
    case 'approve':
      if (v.status !== 'InReview') wrongState(v, step, 'in review');
      if (!v.reviewerId) throw new AppError(409, 'NOT_REVIEWED', `Revision ${v.revision} has not been reviewed: an independent review comes before approval.`);
      return;
    case 'effective':
      if (v.status !== 'Approved') wrongState(v, step, 'Approved');
      await assertCycleSigned(ex, v);
      return;
    case 'obsolete':
      if (v.status !== 'Effective') wrongState(v, step, 'Effective');
  }
}

export async function signStep(args: { db: Db; req: Request; actor: Actor; step: Step; id: string; expectedVersion: number; credentials: Credentials; reason?: string; now?: Date }) {
  const { db, req, actor, step, id, expectedVersion } = args;
  const v = await findVersion(db, id);
  await precheck(db, actor, step, v);
  if (step === 'review') await assertIndependentOf(db, req, actor, step, v, [v.authorId], 'The reviewer of a document must not be its author.');
  if (step === 'approve') await assertIndependentOf(db, req, actor, step, v, [v.authorId, v.reviewerId], 'The approver of a document must be neither its author nor its reviewer.');
  if (step === 'effective') await assertIndependentOf(db, req, actor, step, v, [v.authorId], 'The person who makes a document effective must not be its author.');
  if (v.version !== expectedVersion) throw new ConflictError();
  if (step === 'effective') await assertChangeAuthorised(db, { type: 'Document', id: v.documentId });

  return signRecord({
    db, user: actor, meaningCode: MEANING[step], credentials: args.credentials, reason: args.reason, entityType: 'DocumentVersion', entityId: id,
    context: securityEventContext(req),
    execute: async (tx) => {
      const now = args.now ?? new Date();
      const doc = await lockRow(tx, documents, v.documentId); // serialises the steps of one document (one Effective version)
      const current = await lockRow(tx, documentVersions, id);
      await precheck(tx, actor, step, current);
      if (current.version !== expectedVersion) throw new ConflictError();
      const label = `${doc.code} revision ${current.revision}`;
      let row: VersionRow;
      let audit: { action: string; field: string; oldValue: string; newValue: string; reason: string };
      switch (step) {
        case 'submit':
          row = await updateVersioned(tx, documentVersions, id, expectedVersion, {
            status: 'InReview', submittedAt: now, submittedVersion: expectedVersion + 1, reviewerId: null, reviewedAt: null, approverId: null, approvedAt: null,
          });
          audit = { action: 'Submit', field: 'status', oldValue: 'Draft', newValue: signedState('InReview', row), reason: `${label} submitted for review by its author` };
          break;
        case 'review':
          row = await updateVersioned(tx, documentVersions, id, expectedVersion, { reviewerId: actor.id, reviewedAt: now });
          audit = { action: 'Review', field: 'review', oldValue: '', newValue: signedState('Reviewed', row), reason: `${label} reviewed` };
          break;
        case 'approve':
          row = await updateVersioned(tx, documentVersions, id, expectedVersion, { status: 'Approved', approverId: actor.id, approvedAt: now });
          audit = { action: 'Approve', field: 'status', oldValue: 'InReview', newValue: signedState('Approved', row), reason: `${label} approved for issue` };
          break;
        case 'effective': {
          const [previous] = await tx.select().from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.status, 'Effective'))).limit(1);
          if (previous) {
            await updateVersioned(tx, documentVersions, previous.id, previous.version, { status: 'Superseded', supersededAt: now });
            await writeAudit(tx, actor.id, 'Supersede', 'DocumentVersion', previous.id, 'status', 'Effective', 'Superseded', `Superseded by ${label} (${id})`);
          }
          await consumeChange(tx, actor.id, { type: 'Document', id: doc.id }, `${label} made effective`);
          row = await updateVersioned(tx, documentVersions, id, expectedVersion, { status: 'Effective', effectiveBy: actor.id, effectiveAt: now });
          const assigned = await assignEffectiveVersion(tx, actor.id, row, todayIso(now));
          if (assigned.software) {
            const people = new Set([...assigned.created, ...assigned.superseded].map(a => a.userId));
            for (const userId of people) await refreshSoftwareFlag(tx, userId, actor.id, todayIso(now), `${label} became effective`);
          }
          audit = { action: 'MakeEffective', field: 'status', oldValue: 'Approved', newValue: signedState('Effective', row), reason: `${label} made effective${previous ? `; revision ${previous.revision} superseded` : ''}` };
          break;
        }
        case 'obsolete':
          row = await updateVersioned(tx, documentVersions, id, expectedVersion, { status: 'Obsolete', obsoletedBy: actor.id, obsoletedAt: now });
          await cancelVersionAssignments(tx, actor.id, id, `${label} was withdrawn (obsolete)`);
          audit = { action: 'Obsolete', field: 'status', oldValue: 'Effective', newValue: signedState('Obsolete', row), reason: args.reason?.trim() || `${label} withdrawn` };
          break;
      }
      return { recordVersion: row!.version, audit: audit!, result: presentVersion(row!) };
    },
  }).then(({ result, signature }) => ({ version: result, signature }));
}

/** InReview or Approved back to Draft, with a reason: the review and approval of the cycle are void. Not by the author. */
export async function returnToDraft(db: Db, actor: Actor, id: string, input: { reason: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const v = await lockRow(tx, documentVersions, id);
    if (!['InReview', 'Approved'].includes(v.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Revision ${v.revision} is ${v.status}; only a version in review or approved is returned to Draft.`);
    if (v.authorId === actor.id) throw new ForbiddenError('The author does not return their own version: a reviewer or approver does, with the reason.');
    if (v.version !== input.expectedVersion) throw new ConflictError();
    const row = await updateVersioned(tx, documentVersions, id, input.expectedVersion, {
      status: 'Draft', submittedAt: null, submittedVersion: null, reviewerId: null, reviewedAt: null, approverId: null, approvedAt: null,
    });
    await writeAudit(tx, actor.id, 'Return', 'DocumentVersion', id, 'status', v.status, 'Draft', input.reason);
    return presentVersion(row);
  });
}

// ---- files and controlled copies ----------------------------------------------------------------------------------------------

export async function recordIntegrityFailure(db: Db, actor: { id: string }, v: VersionRow, problem: string) {
  await withTransaction(db, tx => writeAudit(tx, actor.id, 'IntegrityCheckFailed', 'DocumentVersion', v.id, 'file_sha256', v.fileSha256 ?? '', problem,
    `Download refused: ${v.fileName} (document version ${v.id}) registered with sha256 ${v.fileSha256}; ${problem}.`));
}

/** A numbered controlled copy of an Effective version: the print log row, its audit entry and the footer text to print. */
export async function printControlledCopy(db: Db, actor: { id: string; name?: string }, id: string, input: { purpose: string; recipient?: string }, now = new Date()) {
  return withTransaction(db, async (tx: Tx) => {
    const v = await lockRow(tx, documentVersions, id);
    if (v.status !== 'Effective') throw new AppError(409, 'NOT_EFFECTIVE', `Revision ${v.revision} is ${v.status}: only the Effective version is issued as a controlled copy.`);
    const doc = await findDocument(tx, v.documentId);
    const [who] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id)).limit(1);
    const copyNumber = await nextSequence(tx, `docprint:${id}`);
    const row = { id: newId('DP'), documentVersionId: id, copyNumber, purpose: input.purpose, recipient: input.recipient || null, printedBy: actor.id, printedAt: now };
    await tx.insert(documentPrints).values(row);
    await writeAudit(tx, actor.id, 'Print', 'DocumentVersion', id, 'controlledCopy', '', String(copyNumber),
      `Controlled copy ${copyNumber} of ${doc.code} rev ${v.revision} printed: ${input.purpose}${input.recipient ? ` (for ${input.recipient})` : ''}`);
    const footer = `Controlled copy ${copyNumber} - ${doc.code} rev ${v.revision} "${v.title}" - printed ${now.toISOString()} by ${who?.name ?? actor.id}`
      + ` for ${input.purpose} - sha256 ${v.fileSha256} - valid only while revision ${v.revision} is effective; check the register before use.`;
    return { print: { ...row, printedAt: now.toISOString() }, footer };
  });
}

export async function listPrints(db: Db, id: string) {
  await findVersion(db, id);
  const rows = await db.select({ p: documentPrints, printedByName: users.name }).from(documentPrints).leftJoin(users, eq(users.id, documentPrints.printedBy))
    .where(eq(documentPrints.documentVersionId, id)).orderBy(asc(documentPrints.copyNumber));
  return rows.map(r => ({ ...r.p, printedAt: r.p.printedAt.toISOString(), printedByName: r.printedByName }));
}
