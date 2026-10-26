/**
 * The controlled Certificate of Analysis (roadmap M25): issue, re-issue, void and copies. Every write is one transaction with its audit
 * entries, and the issue, re-issue and void are e-signatures (signRecord) bound to the document version they produce.
 *
 *   coaProblems      why a certificate cannot be issued now: the sample is not Approved, a guard of the move to Approved fails (all
 *                    results entered, history intact, reintegrations approved, raw data intact, system suitability, no open OOS), or
 *                    a release blocker applies to the sample (QMS deviation about the batch, audit-trail review). Empty when it can.
 *   issueCoa         POST /coa/:sampleId           COA-<year>-<n> from the gap-free counter coa:<year>, issue version 1
 *   reissueCoa       POST /coa/documents/:id/reissue  the same number, the next issue version; the current one Superseded with the reason
 *   voidCoa          POST /coa/documents/:id/void  signed withdrawal (COA_VOID, reason required)
 *   requestCopy      POST /coa/documents/:id/copies  a controlled copy made by the coa.render job (./runs.ts)
 *
 * Everything that can be refused without the password is refused first (404, 409, 403 SOD_VIOLATION), so a refusal costs the signer
 * no attempt; the same checks run again inside the signing transaction, after the sample row is locked.
 */
import { createHash, randomBytes } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { results, samples, signatures } from '../../db/schema';
import { resultVersions } from '../../db/schema/rawdata';
import { coaDocuments, reportRuns, type CoaStatus } from '../../db/schema/reports';
import { writeAudit } from '../../db/utils';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, SodViolationError } from '../authz/sod';
import type { Db } from '../core/context';
import { lockRow, nextSequence, updateVersioned, type Executor, type Tx } from '../core/tx';
import { canonicalJson, signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { enqueue } from '../jobs/queue';
import { RELEASE_BLOCKERS } from '../release-blockers';
import { TRANSITION_GUARDS } from '../workflow/guards';
import { buildCoaSnapshot, type CoaSnapshot } from './snapshot';
import './entities';

export const COA_ENTITY = 'CoaDocument';
export const COA_RENDER_JOB = 'coa.render';

type SampleRow = typeof samples.$inferSelect;
type DocRow = typeof coaDocuments.$inferSelect;
export interface Problem { check: string; message: string }
interface Credentials { password: string; totpCode?: string }

const ISSUE_RULE = { code: 'coa.issue', description: 'The person who authorises a certificate must not have registered the sample or entered its results.' };

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const snapshotHash = (snapshot: unknown) => sha256Hex(canonicalJson(snapshot));

/** Why `sample` cannot have a certificate now; empty when it can. */
export async function coaProblems(ex: Executor, sample: SampleRow): Promise<Problem[]> {
  if (sample.state !== 'Approved') return [{ check: 'state', message: `Sample ${sample.id} is ${sample.state}; a Certificate of Analysis is issued only for an Approved sample.` }];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (check: string, message: string) => { if (!seen.has(message)) { seen.add(message); problems.push({ check, message }); } };
  for (const guard of TRANSITION_GUARDS['Approved'] ?? []) {
    const message = await guard.check(ex, sample);
    if (message) add(guard.name, message);
  }
  // The release blockers, applied to this sample alone: a CoA certifies one sample, so the other samples of the batch do not block it.
  for (const blocker of RELEASE_BLOCKERS) {
    for (const message of await blocker.check(ex, sample.batch, [{ id: sample.id, state: sample.state }])) add(`release:${blocker.name}`, message);
  }
  return problems;
}

function refuse(sample: SampleRow, problems: Problem[]): never {
  if (problems[0]?.check === 'state') throw new AppError(409, 'SAMPLE_NOT_APPROVED', problems[0].message);
  throw new AppError(409, 'COA_BLOCKED', `A Certificate of Analysis cannot be issued for ${sample.id}: ${problems.map(p => p.message).join(' ')}`, problems);
}

async function loadSample(ex: Executor, sampleId: string): Promise<SampleRow> {
  const [s] = await ex.select().from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!s) throw new NotFoundError(`Sample ${sampleId} was not found.`);
  return s;
}

async function loadDocument(ex: Executor, id: string): Promise<DocRow> {
  const [d] = await ex.select().from(coaDocuments).where(eq(coaDocuments.id, id)).limit(1);
  if (!d) throw new NotFoundError(`Certificate ${id} was not found.`);
  return d;
}

const currentOf = async (ex: Executor, sampleId: string, lock = false) => {
  const q = ex.select().from(coaDocuments).where(and(eq(coaDocuments.sampleId, sampleId), eq(coaDocuments.status, 'Issued'))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
};

/** Who took part in the sample: registered it, or entered or corrected one of its results. */
async function sampleParticipants(ex: Executor, sample: SampleRow): Promise<string[]> {
  const entered = await ex.selectDistinct({ id: results.enteredBy }).from(results).where(eq(results.sampleId, sample.id));
  const versions = await ex.selectDistinct({ id: resultVersions.enteredBy }).from(resultVersions).where(eq(resultVersions.sampleId, sample.id));
  return [sample.createdBy, ...entered.map(r => r.id), ...versions.map(r => r.id)].filter((v): v is string => !!v);
}

async function assertIssuerIndependent(db: Db, req: Request, user: { id: string; role: string }, sample: SampleRow) {
  try {
    assertIndependent(await sampleParticipants(db, sample), user.id, ISSUE_RULE, { sampleId: sample.id });
  } catch (err) {
    if (err instanceof SodViolationError) await recordDenied(db, req, user as any, { rule: ISSUE_RULE.code, entity: 'Sample', entityId: sample.id });
    throw err;
  }
}

const pad = (n: number) => String(n).padStart(4, '0');
const newId = () => `coa-${randomBytes(8).toString('hex')}`;

/** Inserts the document and queues its original PDF, inside the signing transaction. */
async function insertDocument(tx: Tx, user: { id: string }, sample: SampleRow, d: {
  id: string; number: string; issueVersion: number; supersedes: CoaSnapshot['supersedes']; now: Date;
}): Promise<{ doc: DocRow; jobId: string }> {
  const label = `${d.number}-v${d.issueVersion}`;
  const snapshot = await buildCoaSnapshot(tx, sample.id, { certificate: { number: d.number, issueVersion: d.issueVersion, label }, supersedes: d.supersedes, issuedAt: d.now });
  const [doc] = await tx.insert(coaDocuments).values({
    id: d.id, sampleId: sample.id, number: d.number, issueVersion: d.issueVersion, label, status: 'Issued',
    specId: sample.specId, specRevision: snapshot.specification?.revision ?? sample.specRevision ?? null,
    snapshot: snapshot as unknown as Record<string, unknown>, snapshotSha256: snapshotHash(snapshot),
    issuedBy: user.id, issuedAt: d.now, supersedesId: d.supersedes?.id ?? null, version: 1,
  }).returning();
  const job = await enqueue(tx, { type: COA_RENDER_JOB, payload: { documentId: d.id, purpose: 'Original' }, createdBy: user.id, dedupeKey: `coa-original:${d.id}` });
  return { doc, jobId: job.id };
}

export interface IssueOutcome { document: ReturnType<typeof presentDocument>; jobId: string; signatureId: string }

/** POST /coa/:sampleId */
export async function issueCoa(db: Db, req: Request, user: { id: string; role: string }, sampleId: string, body: Credentials & { reason?: string }): Promise<IssueOutcome> {
  const sample = await loadSample(db, sampleId);
  const problems = await coaProblems(db, sample);
  if (problems.length) refuse(sample, problems);
  const current = await currentOf(db, sampleId);
  if (current) throw new AppError(409, 'COA_ALREADY_ISSUED', `${current.label} is the issued certificate of ${sampleId}. A change is a re-issue (a new version, signed, with its reason).`);
  await assertIssuerIndependent(db, req, user, sample);

  const id = newId();
  const { result, signature } = await signRecord({
    db, user, meaningCode: 'COA_AUTHORISATION', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: COA_ENTITY, entityId: id, sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const locked = await lockRow(tx, samples, sampleId);
      const again = await coaProblems(tx, locked);
      if (again.length) refuse(locked, again);
      const issued = await currentOf(tx, sampleId, true);
      if (issued) throw new AppError(409, 'COA_ALREADY_ISSUED', `${issued.label} is the issued certificate of ${sampleId}.`);
      const now = new Date();
      const year = now.getUTCFullYear();
      const number = `COA-${year}-${pad(await nextSequence(tx, `coa:${year}`))}`;
      const out = await insertDocument(tx, user, locked, { id, number, issueVersion: 1, supersedes: null, now });
      return {
        recordVersion: out.doc.version,
        audit: { action: 'Issue', field: 'status', oldValue: '', newValue: 'Issued', reason: body.reason?.trim() || `Certificate ${out.doc.label} issued for sample ${sampleId}` },
        result: out,
      };
    },
  });
  return { document: presentDocument(result.doc), jobId: result.jobId, signatureId: signature.id };
}

/** POST /coa/documents/:id/reissue */
export async function reissueCoa(db: Db, req: Request, user: { id: string; role: string }, documentId: string, body: Credentials & { reason: string; expectedVersion: number }): Promise<IssueOutcome & { superseded: ReturnType<typeof presentDocument> }> {
  const old = await loadDocument(db, documentId);
  if (old.status !== 'Issued') throw new AppError(409, 'COA_NOT_CURRENT', `${old.label} is ${old.status}; only the issued certificate is re-issued.`);
  if (old.version !== body.expectedVersion) throw new ConflictError();
  const sample = await loadSample(db, old.sampleId);
  const problems = await coaProblems(db, sample);
  if (problems.length) refuse(sample, problems);
  await assertIssuerIndependent(db, req, user, sample);

  const id = newId();
  const reason = body.reason.trim();
  const { result, signature } = await signRecord({
    db, user, meaningCode: 'COA_AUTHORISATION', credentials: { password: body.password, totpCode: body.totpCode }, reason,
    entityType: COA_ENTITY, entityId: id, sampleId: old.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const locked = await lockRow(tx, samples, old.sampleId);
      const again = await coaProblems(tx, locked);
      if (again.length) refuse(locked, again);
      const current = await lockRow(tx, coaDocuments, documentId);
      if (current.status !== 'Issued') throw new AppError(409, 'COA_NOT_CURRENT', `${current.label} is ${current.status}; only the issued certificate is re-issued.`);
      const now = new Date();
      const superseded = await updateVersioned(tx, coaDocuments, documentId, body.expectedVersion, {
        status: 'Superseded', supersededById: id, supersededBy: user.id, supersededAt: now, supersededReason: reason,
      });
      await writeAudit(tx, user.id, 'Supersede', COA_ENTITY, documentId, 'status', 'Issued', 'Superseded', reason);
      const out = await insertDocument(tx, user, locked, {
        id, number: current.number, issueVersion: current.issueVersion + 1, supersedes: { id: current.id, label: current.label, reason }, now,
      });
      return {
        recordVersion: out.doc.version,
        audit: { action: 'Issue', field: 'status', oldValue: '', newValue: 'Issued', reason },
        result: { ...out, superseded },
      };
    },
  });
  return { document: presentDocument(result.doc), superseded: presentDocument(result.superseded), jobId: result.jobId, signatureId: signature.id };
}

/** POST /coa/documents/:id/void */
export async function voidCoa(db: Db, req: Request, user: { id: string; role: string }, documentId: string, body: Credentials & { reason: string; expectedVersion: number }) {
  const doc = await loadDocument(db, documentId);
  if (doc.status !== 'Issued') throw new AppError(409, 'COA_NOT_CURRENT', `${doc.label} is ${doc.status}; only the issued certificate is voided.`);
  if (doc.version !== body.expectedVersion) throw new ConflictError();
  const reason = body.reason.trim();
  const { result } = await signRecord({
    db, user, meaningCode: 'COA_VOID', credentials: { password: body.password, totpCode: body.totpCode }, reason,
    entityType: COA_ENTITY, entityId: documentId, sampleId: doc.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const current = await lockRow(tx, coaDocuments, documentId);
      if (current.status !== 'Issued') throw new AppError(409, 'COA_NOT_CURRENT', `${current.label} is ${current.status}; only the issued certificate is voided.`);
      const row = await updateVersioned(tx, coaDocuments, documentId, body.expectedVersion, { status: 'Voided', voidedBy: user.id, voidedAt: new Date(), voidReason: reason });
      return { recordVersion: row.version, audit: { action: 'Void', field: 'status', oldValue: 'Issued', newValue: 'Voided', reason }, result: row };
    },
  });
  return { document: presentDocument(result) };
}

/**
 * POST /coa/documents/:id/copies: a controlled copy for the requester, made by a job. While the original does not exist yet (its job
 * is pending, or it failed), the request queues the original instead (one at a time), so the original is always copy 1.
 */
export async function requestCopy(db: Db, user: { id: string }, documentId: string): Promise<{ jobId: string; purpose: 'Original' | 'Copy' }> {
  const doc = await loadDocument(db, documentId);
  if (!doc.pdfSha256) {
    const job = await enqueue(db, { type: COA_RENDER_JOB, payload: { documentId, purpose: 'Original' }, createdBy: doc.issuedBy, dedupeKey: `coa-original:${documentId}` });
    return { jobId: job.id, purpose: 'Original' };
  }
  const job = await enqueue(db, { type: COA_RENDER_JOB, payload: { documentId, purpose: 'Copy' }, createdBy: user.id });
  return { jobId: job.id, purpose: 'Copy' };
}

// ---- reading -------------------------------------------------------------------------------------------------------------------

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function presentDocument(d: DocRow) {
  return {
    id: d.id, sampleId: d.sampleId, number: d.number, issueVersion: d.issueVersion, label: d.label, status: d.status as CoaStatus, version: d.version,
    specId: d.specId, specRevision: d.specRevision, snapshotSha256: d.snapshotSha256,
    issuedBy: d.issuedBy, issuedAt: d.issuedAt.toISOString(), supersedesId: d.supersedesId,
    supersededById: d.supersededById, supersededBy: d.supersededBy, supersededAt: isoOrNull(d.supersededAt), supersededReason: d.supersededReason,
    voidedBy: d.voidedBy, voidedAt: isoOrNull(d.voidedAt), voidReason: d.voidReason, pdfSha256: d.pdfSha256, originalRunId: d.originalRunId,
  };
}

/** The signatures on a document (issue, void), oldest first, as they were made. */
export async function documentSignatures(ex: Executor, documentId: string) {
  const rows = await ex.select().from(signatures).where(and(eq(signatures.entityType, COA_ENTITY), eq(signatures.entityId, documentId))).orderBy(asc(signatures.timestamp));
  return rows.map(s => ({
    id: s.id, meaningCode: s.meaningCode, meaning: s.meaning, signerName: s.signerName ?? s.signerId, signerRole: s.signerRole ?? '',
    timestamp: s.timestamp.toISOString(), reason: s.reason ?? '', recordVersion: s.recordVersion,
  }));
}

const withSignatures = async (ex: Executor, d: DocRow) => ({ ...presentDocument(d), signatures: await documentSignatures(ex, d.id) });

/** GET /coa/:sampleId: the documents of a sample, newest first, the current one, and what blocks an issue now. */
export async function sampleCoa(db: Db, sampleId: string) {
  const sample = await loadSample(db, sampleId);
  const docs = await db.select().from(coaDocuments).where(eq(coaDocuments.sampleId, sampleId)).orderBy(desc(coaDocuments.issuedAt), desc(coaDocuments.issueVersion));
  const documents = await Promise.all(docs.map(d => withSignatures(db, d)));
  const problems = await coaProblems(db, sample);
  const current = documents.find(d => d.status === 'Issued') ?? null;
  return { sampleId, state: sample.state, eligible: problems.length === 0 && !current, problems, current, documents };
}

/** GET /coa/documents: the register, newest first (at most 200), filtered by batch, sample or status. */
export async function listDocuments(db: Db, f: { batch?: string; sampleId?: string; status?: string }) {
  const where = [
    f.batch ? eq(samples.batch, f.batch) : undefined,
    f.sampleId ? eq(coaDocuments.sampleId, f.sampleId) : undefined,
    f.status ? eq(coaDocuments.status, f.status) : undefined,
  ].filter(Boolean);
  const rows = await db.select({ d: coaDocuments, batch: samples.batch, material: samples.material }).from(coaDocuments)
    .innerJoin(samples, eq(samples.id, coaDocuments.sampleId))
    .where(where.length ? and(...where as any) : undefined)
    .orderBy(desc(coaDocuments.issuedAt)).limit(200);
  return rows.map(r => ({ ...presentDocument(r.d), batch: r.batch, material: r.material }));
}

/** GET /coa/documents/:id: the document with its snapshot, signatures and the register of its copies. */
export async function documentDetail(db: Db, id: string) {
  const d = await loadDocument(db, id);
  const runs = await db.select({
    id: reportRuns.id, copyNo: reportRuns.copyNo, purpose: reportRuns.purpose, documentStatus: reportRuns.documentStatus, watermark: reportRuns.watermark,
    bytes: reportRuns.bytes, pdfSha256: reportRuns.pdfSha256, generatedBy: reportRuns.generatedBy, generatedAt: reportRuns.generatedAt,
  }).from(reportRuns).where(eq(reportRuns.documentId, id)).orderBy(asc(reportRuns.copyNo));
  return { ...(await withSignatures(db, d)), snapshot: d.snapshot, runs: runs.map(r => ({ ...r, generatedAt: r.generatedAt.toISOString() })) };
}

