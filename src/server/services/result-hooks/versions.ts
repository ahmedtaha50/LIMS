/**
 * Result versions (roadmap M20, r2-raw-data): every value a result holds is kept, with a coded reason (21 CFR 211.194(a)(8), 11.10(e)).
 *
 * saveResult (src/server/services/saveResult.ts) calls, inside its one transaction:
 *   codeTheChange        before the write: the code of this write (INITIAL_ENTRY for the first value; a correction needs a reasonCode
 *                        from RESULT_CHANGE_CODES; an OOS value only one of the OOS codes, never REINTEGRATION) and the audit reason
 *                        that names it ("[CODE] reason");
 *   recordResultVersion  after the write: one result_versions row with the value, the version it produced and the code.
 * Any failure rolls back the result, its audit entry and its version together.
 *
 * A REINTEGRATION is approved by a QA signature (signReintegration, meaning REINTEGRATION_APPROVAL, entity ResultVersion), never by
 * the person who reintegrated; the review checklist blocks approval of the sample until every reintegration is signed.
 */
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { results, samples, signatures } from '../../../db/schema';
import { resultVersions } from '../../../db/schema/rawdata';
import { OOS_RESULT_CHANGE_CODES } from '../../../lib/constants/results';
import { securityEventContext } from '../../auth/events';
import { recordDenied } from '../../authz/denied';
import type { Db } from '../../core/context';
import type { Executor, Tx } from '../../core/tx';
import { registerSignable, signRecord } from '../../esign';
import { AppError, BadRequestError, NotFoundError } from '../../http/errors';
import { REINTEGRATION, RESULT_CHANGE_CODES, isOosChangeCode, isResultChangeCode, type VersionCode } from './codes';

export const REINTEGRATION_MEANING = 'REINTEGRATION_APPROVAL';

const isBlank = (v: string | null | undefined) => v === null || v === undefined || v === '';

/**
 * The code of a write and the audit reason that carries it. `auditReason` is the reason saveResult has so far (for an OOS replacement
 * it already reads "[CODE] OOS <id>: reason"). Throws 400 when the code is missing, not allowed, or not wanted.
 */
export function codeTheChange(
  result: { value: string | null; isOos: boolean },
  input: { reason: string; reasonCode?: string },
  auditReason: string,
): { changeCode: VersionCode; auditReason: string } {
  const code = input.reasonCode;
  if (code !== undefined && !isResultChangeCode(code)) {
    throw new BadRequestError(`reasonCode must be one of ${RESULT_CHANGE_CODES.join(', ')}.`);
  }
  if (result.isOos) {
    if (!code || !isOosChangeCode(code)) {
      throw new BadRequestError(`Replacing a value that is OOS takes one of the OOS codes (${OOS_RESULT_CHANGE_CODES.join(', ')}); ${REINTEGRATION} is not accepted for an OOS value.`);
    }
    return { changeCode: code, auditReason };
  }
  if (isBlank(result.value)) {
    if (code) throw new BadRequestError('A first entry takes no reasonCode: the codes explain a correction of a value already entered.');
    return { changeCode: 'INITIAL_ENTRY', auditReason };
  }
  if (!code) throw new BadRequestError(`Correcting a result needs a reasonCode, one of ${RESULT_CHANGE_CODES.join(', ')}, beside the reason.`);
  return { changeCode: code, auditReason: `[${code}] ${input.reason}` };
}

export interface RecordVersionInput {
  before: { id: string; sampleId: string; value: string | null };
  after: { version: number; value: string | null; isOos: boolean; instrumentId: string | null };
  userId: string;
  changeCode: VersionCode;
  reason: string;
  oosId?: string | null;
  now: Date;
}

/** Appends the version the write produced. Inside the result's transaction. */
export async function recordResultVersion(tx: Tx, v: RecordVersionInput) {
  const row = {
    id: `rv-${randomBytes(8).toString('hex')}`, resultId: v.before.id, sampleId: v.before.sampleId, resultVersion: v.after.version,
    value: v.after.value, previousValue: isBlank(v.before.value) ? null : v.before.value, isOos: v.after.isOos, changeCode: v.changeCode,
    reason: v.reason, oosId: v.oosId ?? null, instrumentId: v.after.instrumentId ?? null, enteredBy: v.userId, enteredAt: v.now,
  };
  await tx.insert(resultVersions).values(row);
  return row;
}

export interface ReintegrationSignature { id: string; signerId: string; signerName: string | null; timestamp: string }

/** The QA signatures on reintegrations, by version id. */
export async function reintegrationSignatures(ex: Executor, versionIds: string[]): Promise<Map<string, ReintegrationSignature>> {
  const out = new Map<string, ReintegrationSignature>();
  if (versionIds.length === 0) return out;
  const rows = await ex.select().from(signatures).where(and(
    eq(signatures.entityType, 'ResultVersion'), inArray(signatures.entityId, versionIds), eq(signatures.meaningCode, REINTEGRATION_MEANING),
  ));
  for (const s of rows) {
    if (s.entityId && !out.has(s.entityId)) out.set(s.entityId, { id: s.id, signerId: s.signerId, signerName: s.signerName, timestamp: s.timestamp.toISOString() });
  }
  return out;
}

/** Every version of every result of a sample, oldest first per result, with the parameter and any reintegration signature. */
export async function listResultVersions(ex: Executor, sampleId: string) {
  const rows = await ex.select({ v: resultVersions, parameter: results.parameter }).from(resultVersions)
    .innerJoin(results, eq(results.id, resultVersions.resultId))
    .where(eq(resultVersions.sampleId, sampleId))
    .orderBy(asc(results.parameter), asc(resultVersions.resultId), asc(resultVersions.resultVersion));
  const signed = await reintegrationSignatures(ex, rows.filter(r => r.v.changeCode === REINTEGRATION).map(r => r.v.id));
  return rows.map(({ v, parameter }) => ({
    ...v, parameter, enteredAt: v.enteredAt.toISOString(),
    reintegrationSignature: v.changeCode === REINTEGRATION ? signed.get(v.id) ?? null : null,
  }));
}

async function loadVersion(ex: Executor, id: string, lock = false) {
  const q = ex.select().from(resultVersions).where(eq(resultVersions.id, id));
  const [row] = lock ? await q.for('update') : await q.limit(1);
  if (!row) throw new NotFoundError(`Result version ${id} was not found.`);
  return row;
}

/**
 * QA approves a reintegration with an e-signature bound to the version (record version = the result version it produced).
 * 409 for a version that is not a reintegration, or one already signed; 403 for the person who reintegrated; 423 once the sample is
 * closed. The version row is immutable, so the signature changes nothing but itself and its audit entry.
 */
export async function signReintegration(db: Db, req: Request, user: { id: string; role: string },
  versionId: string, input: { password: string; totpCode?: string; reason?: string }) {
  const check = async (ex: Executor, v: typeof resultVersions.$inferSelect) => {
    if (v.changeCode !== REINTEGRATION) throw new AppError(409, 'NOT_A_REINTEGRATION', `Version ${v.id} is a ${v.changeCode} change: only a reintegration is approved this way.`);
    if ((await reintegrationSignatures(ex, [v.id])).size > 0) throw new AppError(409, 'ALREADY_SIGNED', `The reintegration ${v.id} is already approved.`);
    const [s] = await ex.select({ state: samples.state }).from(samples).where(eq(samples.id, v.sampleId)).limit(1);
    if (s && (s.state === 'Approved' || s.state === 'Rejected')) throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: Sample ${v.sampleId} is ${s.state}.`);
  };
  const version = await loadVersion(db, versionId);
  await check(db, version);
  if (version.enteredBy === user.id) {
    await recordDenied(db, req, user as any, { rule: 'result.reintegration.independent-signer', entity: 'ResultVersion', entityId: versionId });
    throw new AppError(403, 'SOD_VIOLATION', 'You made this reintegration: another member of the quality unit must approve it.');
  }

  const { signature } = await signRecord({
    db, user, meaningCode: REINTEGRATION_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'ResultVersion', entityId: versionId, sampleId: version.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const v = await loadVersion(tx, versionId, true); // serialises two signers of the same version
      await check(tx, v);
      return {
        recordVersion: v.resultVersion,
        audit: { action: 'ReintegrationApproved', field: 'change_code', oldValue: '', newValue: REINTEGRATION, reason: `${v.resultId} v${v.resultVersion}: ${v.reason}` },
        result: v,
      };
    },
  });
  return { signature };
}

registerSignable({
  type: 'ResultVersion',
  async canonical(ex, { id }) {
    const [v] = await ex.select().from(resultVersions).where(eq(resultVersions.id, id)).limit(1);
    if (!v) return null;
    return {
      id: v.id, resultId: v.resultId, sampleId: v.sampleId, resultVersion: v.resultVersion, value: v.value, previousValue: v.previousValue,
      isOos: v.isOos, changeCode: v.changeCode, reason: v.reason, instrumentId: v.instrumentId, enteredBy: v.enteredBy, enteredAt: v.enteredAt.toISOString(),
    };
  },
});
