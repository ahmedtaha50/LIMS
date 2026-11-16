import { createHash } from 'node:crypto';
import type { Client, Pool } from '../core/db.js';
import { HttpError } from '../core/errors.js';
import { writeAudit } from '../audit/index.js';
import { canonical } from '../audit/canonical.js';

/** What a signature means. A new meaning is added here (and counted by the tests), never typed freely by a caller. */
export const MEANINGS = ['authored', 'performed', 'verified', 'reviewed', 'approved', 'released', 'rejected', 'corrected', 'retired'] as const;
export type Meaning = (typeof MEANINGS)[number];

export type Signer = { userId: string; username: string; displayName: string };
/**
 * Checks the signer's password again at the moment of signing. Provided by r1-identity (injected, so this module does not
 * depend on how accounts are stored). Returns false for a wrong password.
 */
export type PasswordCheck = (userId: string, password: string) => Promise<boolean>;

export type SignRequest = {
  signer: Signer; password: string; meaning: Meaning;
  entity: string; entityId: string; recordVersion: number; record: unknown;
  comment?: string | null; requestId?: string | null;
};
export type Signature = { id: string; entity: string; entityId: string; recordVersion: number; recordHash: string; meaning: Meaning; signerId: string; signerName: string; signedAt: string; comment: string | null };

export const recordHash = (record: unknown) => createHash('sha256').update(canonical(record)).digest('hex');

/**
 * Signs a record version inside the caller's transaction (with its audit entry). A wrong password is refused with 401
 * and the failed attempt is audited in its OWN transaction, so it is kept although the signing does not happen.
 */
export async function sign(c: Client, pool: Pool, check: PasswordCheck, r: SignRequest): Promise<Signature> {
  if (!MEANINGS.includes(r.meaning)) throw new HttpError(400, 'bad_meaning', `Unknown signature meaning: ${String(r.meaning)}.`);
  if (!(await check(r.signer.userId, r.password))) {
    const fc = await pool.connect();
    try {
      await fc.query('BEGIN');
      await writeAudit(fc, { actorId: r.signer.userId, actorName: r.signer.username, action: 'esign.refused', entity: r.entity, entityId: r.entityId, newValue: { meaning: r.meaning, recordVersion: r.recordVersion, why: 'wrong password' }, requestId: r.requestId ?? null });
      await fc.query('COMMIT');
    } catch (e) { await fc.query('ROLLBACK').catch(() => undefined); throw e; } finally { fc.release(); }
    throw new HttpError(401, 'signature_password', 'The password is not correct. Nothing was signed.');
  }
  const hash = recordHash(r.record);
  const at = (await c.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const ins = await c.query<{ id: string }>(
    `INSERT INTO signatures (entity, entity_id, record_version, record_hash, meaning, signer_id, signer_name, signed_at, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [r.entity, r.entityId, r.recordVersion, hash, r.meaning, r.signer.userId, r.signer.displayName, at, r.comment ?? null]);
  const sig: Signature = { id: ins.rows[0]!.id, entity: r.entity, entityId: r.entityId, recordVersion: r.recordVersion, recordHash: hash, meaning: r.meaning, signerId: r.signer.userId, signerName: r.signer.displayName, signedAt: at.toISOString(), comment: r.comment ?? null };
  await writeAudit(c, { actorId: r.signer.userId, actorName: r.signer.username, action: 'esign.signed', entity: r.entity, entityId: r.entityId, newValue: { signatureId: sig.id, meaning: sig.meaning, recordVersion: sig.recordVersion, recordHash: hash }, reason: r.comment ?? null, requestId: r.requestId ?? null });
  return sig;
}

/** A signature is valid only for the version and content it signed: a record changed afterwards shows it invalid. */
export const isValid = (s: Pick<Signature, 'recordVersion' | 'recordHash'>, current: { version: number; record: unknown }) =>
  s.recordVersion === current.version && s.recordHash === recordHash(current.record);

/** Two-person rule (AGENTS.md rule 3), checked on the server whatever the client shows. */
export function assertDifferentPerson(performerId: string, verifierId: string) {
  if (performerId === verifierId) throw new HttpError(403, 'same_person', 'The verifier must be a different person from the one who performed the step.');
}

type Row = { id: string; entity: string; entity_id: string; record_version: number; record_hash: string; meaning: Meaning; signer_id: string; signer_name: string; signed_at: Date; comment: string | null };
export async function signaturesOf(pool: Pool, entity: string, entityId: string): Promise<Signature[]> {
  const r = await pool.query<Row>('SELECT * FROM signatures WHERE entity = $1 AND entity_id = $2 ORDER BY id', [entity, entityId]);
  return r.rows.map(x => ({ id: x.id, entity: x.entity, entityId: x.entity_id, recordVersion: x.record_version, recordHash: x.record_hash, meaning: x.meaning, signerId: x.signer_id, signerName: x.signer_name, signedAt: x.signed_at.toISOString(), comment: x.comment }));
}
