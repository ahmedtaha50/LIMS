/**
 * Verification of one signature (21 CFR 11.70: signature and record stay linked). Recomputes what the signature was bound to and
 * compares it with the hash stored when it was made, and checks the audit chain up to the entry the signature points at.
 *
 *   valid               the hash matches the record as signed AND the audit chain is intact through the signature's entry
 *   record-modified     the record no longer hashes to what was signed (altered after signing)
 *   record-missing      the record is gone
 *   chain-broken        the record matches, but an audit entry up to the signature's has been altered
 *   legacy-unverifiable the signature was made before hashes were recomputable ('N/A' or a formula whose input was not kept):
 *                       it is neither confirmed nor refuted, and it is never reported as valid
 *   audit-missing       a version 2 signature whose audit entry cannot be found
 *   unsupported         the record type is not registered in this build
 *
 * `valid` is true for status "valid" only. A hash that cannot be computed used to count as valid.
 */
import { eq } from 'drizzle-orm';
import { auditTrail, signatures, users } from '../../db/schema';
import { verifyAuditChainTo } from '../audit/chain';
import type { Db } from '../core/context';
import './entities';
import { signatureContentHash } from './hash';
import { legacyContentMatch } from './legacy';
import { getSignable, type SignedChange } from './registry';

export type VerifyStatus = 'valid' | 'record-modified' | 'record-missing' | 'chain-broken' | 'legacy-unverifiable' | 'audit-missing' | 'unsupported';

export type SignatureRow = typeof signatures.$inferSelect;
export type AuditRow = typeof auditTrail.$inferSelect;

export interface Binding { entityType: string; entityId: string }

/**
 * What a signature is bound to. Rows written by signRecord say so; rows from before migration 0020, or from a signing route that
 * has not moved to signRecord, say it through their audit entry (its entity and entity id) or, with none, through their sample.
 */
export function bindingOf(sig: SignatureRow, audit: AuditRow | undefined): Binding {
  if (sig.entityType && sig.entityId) return { entityType: sig.entityType, entityId: sig.entityId };
  if (audit) return { entityType: audit.entity, entityId: audit.entityId };
  return { entityType: 'Sample', entityId: sig.sampleId ?? '' };
}

/** The audit entry a signature points at; 'N/A' and 'pending' (and anything else that is not an entry) give undefined. */
export async function auditEntryOf(db: Db, sig: SignatureRow): Promise<AuditRow | undefined> {
  const [row] = await db.select().from(auditTrail).where(eq(auditTrail.id, sig.auditEntryId)).limit(1);
  return row;
}

export interface Verification {
  valid: boolean;
  status: VerifyStatus;
  /** true / false, or null where the hash cannot be recomputed. */
  contentHashMatches: boolean | null;
  /** true / false, or null where the signature points at no audit entry. */
  chainIntact: boolean | null;
  binding: Binding;
  signature: SignatureRow;
  audit: AuditRow | undefined;
  signer: { name: string; role: string; email: string; snapshot: boolean };
}

export async function verifySignature(db: Db, signatureId: string): Promise<Verification | null> {
  const [sig] = await db.select().from(signatures).where(eq(signatures.id, signatureId)).limit(1);
  if (!sig) return null;
  const audit = await auditEntryOf(db, sig);
  const binding = bindingOf(sig, audit);

  const [account] = await db.select().from(users).where(eq(users.id, sig.signerId)).limit(1);
  const snapshot = !!(sig.signerName && sig.signerRole);
  const signer = {
    name: sig.signerName ?? account?.name ?? sig.signerId,
    role: sig.signerRole ?? account?.role ?? 'Authorized Signer',
    email: account?.email ?? '',
    snapshot,
  };

  const chainIntact = audit ? (await verifyAuditChainTo(db, { id: audit.id })).isValid : null;

  let match: boolean | null = null;
  let unresolved: VerifyStatus = 'legacy-unverifiable';
  if (sig.hashVersion >= 2) {
    const entity = getSignable(binding.entityType);
    if (!entity) unresolved = 'unsupported';
    else if (!audit) unresolved = 'audit-missing';
    else {
      const change: SignedChange = { action: audit.action, field: audit.field, oldValue: audit.oldValue, newValue: audit.newValue };
      const content = await entity.canonical(db, { id: binding.entityId, recordVersion: sig.recordVersion, change, hashVersion: sig.hashVersion });
      match = content === null ? false : signatureContentHash({ entityType: binding.entityType, entityId: binding.entityId, recordVersion: sig.recordVersion, content }) === sig.contentHash;
      if (content === null) unresolved = 'record-missing';
    }
  } else {
    match = await legacyContentMatch(db, sig, audit, binding);
  }

  let status: VerifyStatus;
  if (match === false) status = unresolved === 'record-missing' ? 'record-missing' : 'record-modified';
  else if (chainIntact === false) status = 'chain-broken';
  else if (match === null) status = unresolved;
  else status = 'valid';

  return { valid: status === 'valid', status, contentHashMatches: match, chainIntact, binding, signature: sig, audit, signer };
}
