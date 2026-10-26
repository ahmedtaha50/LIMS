import { db } from './index';
import { auditCheckpoints, auditTrail, users } from './schema';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { appVersion } from '../server/boot/version';
import { AUDIT_HASH_VERSION, CHECKPOINT_INTERVAL, GENESIS_HASH, currentAuditAlg, linkHash, sealAnchor, sealHash } from '../server/audit/hash';
import { currentSessionId } from '../server/audit/context';

// Password format: "scrypt$<salt hex>$<hash hex>" (per-user random salt).
// Legacy format (bare hex derived with the old static salt) is still verified so existing users can log in.
const LEGACY_SALT = 'gxp-salt-2026';
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function verifyPassword(password: string, hash: string | null): boolean {
  if (!hash) return false;
  if (hash.startsWith('scrypt$')) {
    const [, salt, digest] = hash.split('$');
    return safeEqualHex(scryptSync(password, salt, 64).toString('hex'), digest);
  }
  return safeEqualHex(scryptSync(password, LEGACY_SALT, 64).toString('hex'), hash);
}

export function generatePasswordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Serialises everything that appends to the audit chain (src/server/migrate.ts takes the same key). */
export const AUDIT_CHAIN_LOCK = 7001;

/** Takes the chain lock for the rest of the transaction. Re-entrant: writeAudit takes it again. */
export async function lockAuditChain(tx: any) {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
}

// Mandatory Audit Logger (Runs INSIDE a database transaction tx)
// Row format v2 (src/server/audit/hash.ts): the v1 link hash plus a seal over the actor snapshot. The snapshot (name and role
// as they were when the action happened, the session, the application version) is read here, from the actor's user row, so no
// caller has to pass it and a later rename or role change cannot rewrite who did what.
export async function writeAudit(
  tx: any,
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  field: string,
  oldValue: string,
  newValue: string,
  reason: string
) {
  if (!reason && action !== 'Create') {
    throw new Error('Reason is required for audit trail modifications (ALCOA+).');
  }

  const [actor] = await tx.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);

  // Serialise audit writers so the sequence/hash chain cannot fork
  await lockAuditChain(tx);

  // Find last sequence to calculate chain hash
  const [lastEntry] = await tx.select({ sequence: auditTrail.sequence, hash: auditTrail.hash, seal: auditTrail.seal })
    .from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);

  const sequence = lastEntry ? lastEntry.sequence + 1 : 1;
  const prevHash = lastEntry ? lastEntry.hash : GENESIS_HASH;
  const at = new Date();
  const timestampStr = at.toISOString();
  const record = {
    sequence, timestamp: timestampStr, userId,
    actorName: actor?.name ?? null, actorRole: actor?.role ?? null, sessionId: currentSessionId(), appVersion: appVersion(),
    action, entity, entityId, field, oldValue, newValue, reason,
  };
  // Keyed (roadmap M35): the HMAC key comes from the keystore, never from the database.
  const hashAlg = currentAuditAlg();
  const hash = linkHash(record, prevHash, hashAlg);
  const seal = sealHash({ ...record, hash }, sealAnchor(lastEntry ?? null), hashAlg);

  const newAudit = {
    id: `adt-${randomBytes(8).toString('hex')}`,
    sequence,
    timestamp: at, // the same instant as timestamp_str, so a date filter and the hashed text agree
    userId,
    actorName: record.actorName,
    actorRole: record.actorRole,
    sessionId: record.sessionId,
    appVersion: record.appVersion,
    action,
    entity,
    entityId,
    field,
    oldValue,
    newValue,
    reason,
    hash,
    prevHash,
    hashVersion: AUDIT_HASH_VERSION,
    hashAlg,
    seal,
    timestampStr,
  };

  await tx.insert(auditTrail).values(newAudit);
  if (sequence % CHECKPOINT_INTERVAL === 0) {
    await tx.insert(auditCheckpoints).values({ sequence, hash, seal }).onConflictDoNothing();
  }
  return newAudit;
}

/**
 * A higher-order helper to wrap an operation in a database transaction 
 * and atomically append an audit trail entry if the operation succeeds.
 */
export async function executeWithAudit<T>(
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  field: string,
  oldValue: string,
  newValue: string,
  reason: string,
  operation: (tx: any) => Promise<T>
): Promise<T> {
  return await db.transaction(async (tx) => {
    const result = await operation(tx);
    await writeAudit(tx, userId, action, entity, entityId, field, oldValue, newValue, reason);
    return result;
  });
}
