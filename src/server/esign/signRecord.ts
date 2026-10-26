/**
 * signRecord: the one way to make an electronic signature (roadmap M07).
 *
 *   const { result, signature } = await signRecord({
 *     db, user: req.user, meaningCode, credentials: { password, totpCode }, reason,
 *     entityType: 'Specification', entityId: id,
 *     execute: async (tx, afterCommit) => {
 *       const row = await updateVersioned(tx, specifications, id, expectedVersion, { status: 'Active' });   // the change being signed
 *       return { recordVersion: row.version, audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Active', reason: '...' }, result: row };
 *     },
 *   });
 *
 * What it does, in this order:
 *   1. looks the meaning up in the catalog (the client sends a code; a text from the client is never read) and the record type up
 *      in the registry;
 *   1b. refuses (423 CLOCK_ANOMALY) while the system clock is in doubt, except the acknowledgement that lifts it (roadmap M35,
 *      src/server/audit/clockGuard.ts); nothing is counted;
 *   2. authorises the signer (./authorize.ts): role, reason, lock, training, password, authenticator code. A failure is committed
 *      with its audit entry in its own transaction and thrown; `execute` has not run;
 *   3. opens ONE transaction in which `execute` makes the change (it returns the new record version and the audit entry for the
 *      change), the audit entry is written FIRST, the content hash is computed from the record as it now stands, and the signature
 *      row is inserted pointing at that audit entry. Any failure rolls all of it back, so no change exists without its signature
 *      and no signature without its audit entry;
 *   4. runs the afterCommit hooks that `execute` registered (socket emits, queue publishes) once the transaction has committed.
 *
 * The signature row carries a snapshot of the signer's name and role and of the meaning text, so renaming a user or editing the
 * catalog later cannot change what an old signature shows (21 CFR 11.50).
 */
import { randomBytes } from 'crypto';
import { signatures } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import type { EventContext } from '../auth/events';
import type { Db } from '../core/context';
import { withTransaction, type AfterCommit, type Tx } from '../core/tx';
import { AppError } from '../http/errors';
import { guardSigningClock } from '../audit/clockGuard';
import { authorizeSigner, type AuthMethod, type SigningCredentials } from './authorize';
import './entities';
import { SIGNATURE_HASH_VERSION, signatureContentHash } from './hash';
import { getMeaning } from './meanings';
import { getSignable, type SignedChange } from './registry';

export interface AuditChange extends SignedChange {
  /** Why the change was made (ALCOA+); defaults to the reason of the signature. */
  reason: string;
}

export interface SignRecordInput<T> {
  db: Db;
  /** The authenticated user, req.user. Only the id is used: the user is read again, so a stale session object cannot sign. */
  user: { id: string };
  /** The catalog code. The meaning text, the roles allowed and the reason rule come from the catalog. */
  meaningCode: string;
  credentials: SigningCredentials;
  reason?: string;
  entityType: string;
  entityId: string;
  /** For a record that belongs to a sample: keeps the sample's foreign key and lets the sample page list the signature. */
  sampleId?: string | null;
  context?: Partial<EventContext>;
  /** The change being signed, inside the signing transaction. */
  execute: (tx: Tx, afterCommit: AfterCommit) => Promise<{ recordVersion: number; audit: AuditChange; result: T }>;
}

/** What is shown wherever a signature is shown: the manifestation (21 CFR 11.50) and the bindings. */
export interface SignatureView {
  id: string;
  entityType: string;
  entityId: string;
  sampleId: string | null;
  meaningCode: string;
  meaning: string;
  signerId: string;
  signerName: string;
  signerRole: string;
  authMethod: AuthMethod;
  reason: string;
  timestamp: Date;
  recordVersion: number;
  contentHash: string;
  auditEntryId: string;
  hashVersion: number;
}

export async function signRecord<T>(input: SignRecordInput<T>): Promise<{ result: T; signature: SignatureView }> {
  const { db, entityType, entityId } = input;

  const meaning = await getMeaning(db, input.meaningCode);
  if (!meaning || !meaning.active) throw new AppError(400, 'UNKNOWN_MEANING', `"${input.meaningCode}" is not a signature meaning.`);
  const entity = getSignable(entityType);
  if (!entity) throw new AppError(400, 'UNKNOWN_ENTITY_TYPE', `Records of type "${entityType}" cannot be signed.`);

  await guardSigningClock(db, meaning.code);

  const { signer, authMethod } = await authorizeSigner({
    db, userId: input.user.id, meaning, credentials: input.credentials, reason: input.reason, entityType, entityId, context: input.context,
  });

  return withTransaction(db, async (tx, afterCommit) => {
    const done = await input.execute(tx, afterCommit);
    if (!Number.isInteger(done.recordVersion) || done.recordVersion < 1) throw new Error('signRecord: execute must return the record version the signature is bound to.');

    const signedReason = (input.reason ?? '').trim() || done.audit.reason;
    const audit = await writeAudit(tx, signer.id, done.audit.action, entityType, entityId, done.audit.field, done.audit.oldValue, done.audit.newValue, done.audit.reason || signedReason);

    const change: SignedChange = { action: done.audit.action, field: done.audit.field, oldValue: done.audit.oldValue, newValue: done.audit.newValue };
    const content = await entity.canonical(tx, { id: entityId, recordVersion: done.recordVersion, change, hashVersion: SIGNATURE_HASH_VERSION });
    if (!content) throw new Error(`signRecord: ${entityType} ${entityId} does not exist after the change; there is nothing to sign.`);
    const contentHash = signatureContentHash({ entityType, entityId, recordVersion: done.recordVersion, content });

    const view: SignatureView = {
      id: `sig-${randomBytes(8).toString('hex')}`, entityType, entityId, sampleId: input.sampleId ?? null,
      meaningCode: meaning.code, meaning: meaning.text, signerId: signer.id, signerName: signer.name, signerRole: signer.role, authMethod,
      reason: signedReason, timestamp: new Date(), recordVersion: done.recordVersion, contentHash, auditEntryId: audit.id, hashVersion: SIGNATURE_HASH_VERSION,
    };
    await tx.insert(signatures).values({
      id: view.id, sampleId: view.sampleId, signerId: view.signerId, meaning: view.meaning, reason: view.reason, timestamp: view.timestamp,
      recordVersion: view.recordVersion, contentHash: view.contentHash, auditEntryId: view.auditEntryId,
      entityType, entityId, meaningCode: view.meaningCode, signerName: view.signerName, signerRole: view.signerRole, authMethod, hashVersion: view.hashVersion,
    });
    return { result: done.result, signature: view };
  });
}
