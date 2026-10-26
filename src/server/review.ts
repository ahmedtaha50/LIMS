/**
 * The review checklist of a sample (roadmap M20, r2-raw-data; 21 CFR 211.194(a)(8): the record of review, audit-trail review by
 * exception). Server items are evaluated from the records, never typed in:
 *
 *   RESULTS_ENTERED          every result has a value
 *   RESULT_HISTORY           every entered result's value, flag and version are those of its last result_versions row (a value written
 *                            outside saveResult, or a row without history, fails)
 *   REINTEGRATIONS_APPROVED  every REINTEGRATION version of the sample carries a QA signature (REINTEGRATION_APPROVAL)
 *   INSTRUMENTS_CALIBRATED   every instrument a result was measured on was Active and within its calibration on the day the result was
 *                            entered, read from calibration_history (what the due date was then, not what it is now)
 *   RAW_DATA_ATTACHED        every result measured on an instrument has at least one raw-data file attached to it
 *   ATTACHMENTS_INTACT       every file attached to the sample is in the blob store and re-hashes to its registered sha256
 *   SYSTEM_SUITABILITY       the system suitability rule of r2-methods-calc (workflow/guards/sst.ts)
 *
 * Status: pass, fail, or na (nothing to check). The approval guard (reviewChecklistGuard) refuses the move to Approved while an item
 * fails; RESULTS_ENTERED and SYSTEM_SUITABILITY are left to their own guards (resultsComplete, sstPassed) so a refusal names each
 * problem once. The manual attestations are what the system cannot check (reagent lots are not linked to results); a reviewer records
 * them with recordChecklist, together with the server items as evaluated at that moment (review_checklists, append-only).
 */
import { randomBytes } from 'crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { calibrationHistory, instruments, results, samples } from '../db/schema';
import { attachments, resultVersions, reviewChecklists } from '../db/schema/rawdata';
import { writeAudit } from '../db/utils';
import { calibrationState } from '../lib/validations/instruments';
import { blobDir, verifyBlob } from './blobs';
import type { Db } from './core/context';
import { lockRow, withTransaction, type Executor } from './core/tx';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from './http/errors';
import { REINTEGRATION } from './services/result-hooks/codes';
import { reintegrationSignatures } from './services/result-hooks/versions';
import { sstPassed } from './workflow/guards/sst';
import type { GuardedSample, TransitionGuard } from './workflow/guards/types';

export type ItemStatus = 'pass' | 'fail' | 'na';
export interface ChecklistItem { code: string; label: string; status: ItemStatus; detail: string }

export const CHECK_LABELS = {
  RESULTS_ENTERED: 'All results entered',
  RESULT_HISTORY: 'Every value matches its recorded history',
  REINTEGRATIONS_APPROVED: 'Every reintegration approved by QA',
  INSTRUMENTS_CALIBRATED: 'Instruments within calibration when used',
  RAW_DATA_ATTACHED: 'Raw data attached for every instrument result',
  ATTACHMENTS_INTACT: 'Every attached file intact (sha256)',
  SYSTEM_SUITABILITY: 'System suitability passed',
} as const;
type CheckCode = keyof typeof CHECK_LABELS;

/** Checks with a guard of their own on the move to Approved (src/server/workflow/guards/index.ts). */
const OWN_GUARD: ReadonlySet<CheckCode> = new Set(['RESULTS_ENTERED', 'SYSTEM_SUITABILITY']);

export const ATTESTATIONS = {
  AUDIT_TRAIL_REVIEWED: 'I reviewed the audit trail of this sample and its results, including every correction and its reason.',
  RAW_DATA_VERIFIED: 'I compared the reported results with the raw data (attached files, instrument printouts, worksheets).',
  REAGENTS_IN_DATE: 'I confirmed that the reagents, standards and solutions used were within their expiry and correctly prepared.',
} as const;
export type AttestationCode = keyof typeof ATTESTATIONS;
export const ATTESTATION_CODES = Object.keys(ATTESTATIONS) as AttestationCode[];

/** The roles that review (the workflow's approvers, src/server/workflow/transitions.ts). */
export const REVIEW_ROLES: readonly string[] = ['Reviewer', 'QA', 'Admin'];

const item = (code: CheckCode, status: ItemStatus, detail: string): ChecklistItem => ({ code, label: CHECK_LABELS[code], status, detail });
const entered = (v: string | null) => v !== null && v !== '';
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Due date and status of an instrument at instant `at`, from its signed calibration history (or its record when it has none). */
async function calibrationAt(ex: Executor, instrumentId: string, at: Date) {
  const [inst] = await ex.select().from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  if (!inst) return null;
  const history = await ex.select().from(calibrationHistory).where(eq(calibrationHistory.instrumentId, instrumentId)).orderBy(asc(calibrationHistory.performedAt));
  const before = [...history].reverse().find(h => h.performedAt.getTime() <= at.getTime());
  if (before) return { dueDate: before.newDueDate, status: before.statusAfter, name: inst.name };
  const after = history.find(h => h.performedAt.getTime() > at.getTime());
  if (after) return { dueDate: after.previousDueDate, status: after.statusBefore, name: inst.name };
  return { dueDate: inst.calibrationDueDate, status: inst.status, name: inst.name };
}

export async function evaluateChecklist(ex: Executor, sample: GuardedSample, dir = blobDir()): Promise<ChecklistItem[]> {
  const rows = await ex.select().from(results).where(eq(results.sampleId, sample.id)).orderBy(asc(results.parameter));
  const done = rows.filter(r => entered(r.value));
  const out: ChecklistItem[] = [];

  const missing = rows.filter(r => !entered(r.value)).map(r => r.parameter);
  out.push(rows.length === 0 ? item('RESULTS_ENTERED', 'fail', 'The sample has no results.')
    : missing.length ? item('RESULTS_ENTERED', 'fail', `Not entered: ${missing.join(', ')}.`)
      : item('RESULTS_ENTERED', 'pass', `${rows.length} of ${rows.length} entered.`));

  const versions = rows.length ? await ex.select().from(resultVersions).where(eq(resultVersions.sampleId, sample.id)).orderBy(asc(resultVersions.resultVersion)) : [];
  const history: string[] = [];
  for (const r of done) {
    const last = versions.filter(v => v.resultId === r.id).pop();
    if (!last) history.push(`${r.parameter}: no recorded version for the value ${r.value}.`);
    else if (last.resultVersion !== r.version || last.value !== r.value || last.isOos !== r.isOos) {
      history.push(`${r.parameter}: the value ${r.value} (version ${r.version}) is not the last recorded version (${last.value}, version ${last.resultVersion}).`);
    }
  }
  out.push(done.length === 0 ? item('RESULT_HISTORY', 'na', 'No result entered.')
    : history.length ? item('RESULT_HISTORY', 'fail', history.join(' '))
      : item('RESULT_HISTORY', 'pass', `${versions.length} recorded version(s); every correction has a coded reason.`));

  const reints = versions.filter(v => v.changeCode === REINTEGRATION);
  const signed = await reintegrationSignatures(ex, reints.map(v => v.id));
  const parameterOf = new Map(rows.map(r => [r.id, r.parameter]));
  const unsigned = reints.filter(v => !signed.has(v.id)).map(v => `${parameterOf.get(v.resultId)} (version ${v.resultVersion})`);
  out.push(reints.length === 0 ? item('REINTEGRATIONS_APPROVED', 'na', 'No reintegration.')
    : unsigned.length ? item('REINTEGRATIONS_APPROVED', 'fail', `Waiting for QA approval: ${unsigned.join(', ')}.`)
      : item('REINTEGRATIONS_APPROVED', 'pass', `${reints.length} reintegration(s) approved.`));

  const measured = done.filter(r => r.instrumentId);
  const calProblems: string[] = [];
  for (const r of measured) {
    const at = r.enteredAt ?? new Date();
    const cal = await calibrationAt(ex, r.instrumentId!, at);
    if (!cal) { calProblems.push(`${r.parameter}: instrument ${r.instrumentId} does not exist.`); continue; }
    if (cal.status !== 'Active') calProblems.push(`${r.parameter}: ${r.instrumentId} (${cal.name}) was ${cal.status} on ${day(at)}.`);
    else if (calibrationState(cal.dueDate, at).expired) calProblems.push(`${r.parameter}: ${r.instrumentId} (${cal.name}) was due for calibration on ${cal.dueDate} and was used on ${day(at)}.`);
  }
  out.push(measured.length === 0 ? item('INSTRUMENTS_CALIBRATED', 'na', 'No result names an instrument.')
    : calProblems.length ? item('INSTRUMENTS_CALIBRATED', 'fail', calProblems.join(' '))
      : item('INSTRUMENTS_CALIBRATED', 'pass', `${new Set(measured.map(r => r.instrumentId)).size} instrument(s) within calibration when used.`));

  const files = await ex.select().from(attachments).where(eq(attachments.sampleId, sample.id)).orderBy(asc(attachments.uploadedAt));
  const withFile = new Set(files.map(f => f.resultId).filter(Boolean));
  const noRaw = measured.filter(r => !withFile.has(r.id)).map(r => r.parameter);
  out.push(measured.length === 0 ? item('RAW_DATA_ATTACHED', 'na', 'No result measured on an instrument.')
    : noRaw.length ? item('RAW_DATA_ATTACHED', 'fail', `No raw data file for: ${noRaw.join(', ')}.`)
      : item('RAW_DATA_ATTACHED', 'pass', `Raw data attached for ${measured.length} instrument result(s).`));

  const damaged: string[] = [];
  const checked = new Map<string, Awaited<ReturnType<typeof verifyBlob>>>();
  for (const f of files) {
    if (!checked.has(f.sha256)) checked.set(f.sha256, await verifyBlob(dir, f.sha256));
    const c = checked.get(f.sha256)!;
    if (!c.ok) damaged.push(`${f.fileName} (${c.problem === 'missing' ? 'missing from the store' : 'does not match its sha256'})`);
  }
  out.push(files.length === 0 ? item('ATTACHMENTS_INTACT', 'na', 'No file attached.')
    : damaged.length ? item('ATTACHMENTS_INTACT', 'fail', `Damaged: ${damaged.join(', ')}.`)
      : item('ATTACHMENTS_INTACT', 'pass', `${files.length} file(s) re-hashed and intact.`));

  const sst = await sstPassed.check(ex, sample);
  out.push(sst ? item('SYSTEM_SUITABILITY', 'fail', sst) : item('SYSTEM_SUITABILITY', 'pass', 'No system suitability failure or missing run.'));
  return out;
}

const failedOf = (items: ChecklistItem[]) => items.filter(i => i.status === 'fail');

/** The approval guard: refuses Approved while a server item of the checklist fails (registered in workflow/guards/index.ts). */
export const reviewChecklistGuard: TransitionGuard = {
  name: 'review-checklist',
  async check(ex, sample) {
    const failed = failedOf(await evaluateChecklist(ex, sample)).filter(i => !OWN_GUARD.has(i.code as CheckCode));
    if (failed.length === 0) return null;
    return `Review checklist not met: ${failed.map(i => `${i.code} (${i.label}): ${i.detail}`).join(' ')}`;
  },
};

async function loadSample(ex: Executor, id: string) {
  const [s] = await ex.select().from(samples).where(eq(samples.id, id)).limit(1);
  if (!s) throw new NotFoundError(`Sample ${id} was not found.`);
  return s;
}

const presentChecklist = (row: typeof reviewChecklists.$inferSelect) => ({ ...row, recordedAt: row.recordedAt.toISOString() });

/** GET /samples/:id/review-checklist: the server items now, the attestation catalogue, and the latest recorded checklist. */
export async function getChecklist(db: Db, sampleId: string) {
  const sample = await loadSample(db, sampleId);
  const items = await evaluateChecklist(db, sample);
  const [latest] = await db.select().from(reviewChecklists).where(eq(reviewChecklists.sampleId, sampleId)).orderBy(desc(reviewChecklists.recordedAt)).limit(1);
  return {
    sampleId, sampleState: sample.state, sampleVersion: sample.version, items, ready: failedOf(items).length === 0,
    attestationCodes: ATTESTATION_CODES, attestations: ATTESTATION_CODES.map(code => ({ code, text: ATTESTATIONS[code] })),
    latest: latest ? presentChecklist(latest) : null,
  };
}

/** POST /samples/:id/review-checklist: the reviewer's attestations, with the server items as they stand. While Pending Review only. */
export async function recordChecklist(db: Db, user: { id: string; role: string }, sampleId: string,
  input: { attestations: AttestationCode[]; comment?: string; expectedVersion: number }) {
  if (!REVIEW_ROLES.includes(user.role)) throw new ForbiddenError(`Forbidden: the review checklist is recorded by ${REVIEW_ROLES.join(', ')}.`);
  return withTransaction(db, async (tx) => {
    const sample = await lockRow(tx, samples, sampleId).catch(e => { throw e instanceof NotFoundError ? new NotFoundError(`Sample ${sampleId} was not found.`) : e; });
    if (sample.state !== 'Pending Review') throw new AppError(409, 'SAMPLE_NOT_IN_REVIEW', `The checklist is recorded while the sample is in Pending Review; ${sampleId} is ${sample.state}.`);
    if (sample.version !== input.expectedVersion) throw new ConflictError();
    const items = await evaluateChecklist(tx, sample);
    const row = {
      id: `rcl-${randomBytes(8).toString('hex')}`, sampleId, sampleVersion: sample.version,
      items: items.map(({ code, status, detail }) => ({ code, status, detail })), attestations: input.attestations,
      serverItemsPassed: failedOf(items).length === 0, comment: input.comment ?? null, recordedBy: user.id, recordedAt: new Date(),
    };
    await tx.insert(reviewChecklists).values(row);
    await writeAudit(tx, user.id, 'Create', 'ReviewChecklist', row.id, 'all', '', JSON.stringify({
      sampleId, sampleVersion: row.sampleVersion, attestations: row.attestations, serverItemsPassed: row.serverItemsPassed,
      failed: failedOf(items).map(i => i.code),
    }), input.comment || `Review checklist of ${sampleId} recorded`);
    return presentChecklist(row as typeof reviewChecklists.$inferSelect);
  });
}
