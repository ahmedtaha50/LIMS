/**
 * The audit trail's hash formulas, in one place and free of I/O so that the writer, the verifier, the backup check and the
 * tests all use the same definition.
 *
 * Every row carries two protections:
 *
 *   link  hash = H(JSON{sequence, timestamp, userId, action, entity, entityId, field, oldValue, newValue, reason} + prevHash)
 *         This is the formula of every row written before audit v2 (hash_version 1), unchanged and still computed for new
 *         rows, so a verifier written for v1 accepts them. `timestamp` is the text of timestamp_str, never the timestamp column.
 *
 *   seal  (hash_version 2) seal = H(JSON{v: 2, ...the link fields, actorName, actorRole, sessionId, appVersion, hash} + prevSeal)
 *         where prevSeal is the previous row's seal, or its hash when that row is a v1 row (or the genesis value). The seal
 *         puts the who/where snapshot under the same tamper evidence as the record itself and chains it row to row.
 *
 * `hash_alg` names H for both. A row whose version or algorithm is unknown is reported, never skipped.
 *
 *   sha256              H = SHA-256. Every row written before roadmap M35, and the migration runner's own rows.
 *   hmac-sha256-v1      H = HMAC-SHA-256 with the keystore's audit-hmac key of generation 1 (src/server/crypto/keystore.ts);
 *   hmac-sha256-v1:gN   the same with generation N (written after the master key was rotated to generation N). The key is not in
 *                       the database, so rows rewritten by someone who has only the database cannot be re-hashed to verify.
 *
 * Old rows keep verifying with the algorithm they were written with. Once the chain holds a keyed row, a later row with an unkeyed
 * algorithm is DOWNGRADE (re-hashing with the published sha256 formula is what someone without the key would do), except the
 * migration runner's own rows (hash_version 1, entity SYSTEM_MIGRATION), which it writes without the application's keys.
 */
import { createHash, createHmac } from 'crypto';
import { getKeystore } from '../crypto/keystore';

export const GENESIS_HASH = '0'.repeat(64);
/** The version new rows are written with. */
export const AUDIT_HASH_VERSION = 2;
/** The keyed algorithm new rows are written with (key generation 1); see currentAuditAlg for later generations. */
export const AUDIT_HASH_ALG = 'hmac-sha256-v1';
/** The unkeyed algorithm of the rows written before M35, and the default of linkHash and sealHash. */
export const LEGACY_HASH_ALG = 'sha256';
/** A checkpoint is recorded each time the sequence reaches a multiple of this number (roadmap M08). */
export const CHECKPOINT_INTERVAL = 5000;

const KEYED = /^hmac-sha256-v1(?::g([1-9]\d{0,5}))?$/;
export const isKeyedAlg = (alg: string): boolean => KEYED.test(alg);

/** H for `alg`, or null when the algorithm is unknown or its key generation is not in the key ring. */
function algorithm(alg: string): ((data: string) => string) | null {
  if (alg === 'sha256') return (data) => createHash('sha256').update(data).digest('hex');
  const m = KEYED.exec(alg);
  if (!m) return null;
  let key: Buffer;
  try { key = getKeystore().deriveKey('audit-hmac', 'chain', m[1] ? Number(m[1]) : 1); } catch { return null; }
  return (data) => createHmac('sha256', key).update(data).digest('hex');
}
export const isSupportedAlg = (alg: string): boolean => algorithm(alg) !== null;

/** The algorithm the writer uses now: keyed, with the keystore's current generation. */
export const currentAuditAlg = (): string => {
  const g = getKeystore().current;
  return g === 1 ? AUDIT_HASH_ALG : `${AUDIT_HASH_ALG}:g${g}`;
};
const H = (alg: string) => {
  const fn = algorithm(alg);
  if (!fn) throw new Error(`Audit hash algorithm "${alg}" is not available.`);
  return fn;
};

/** One audit row in the shape the hashes are defined on. */
export interface AuditRecord {
  id: string;
  sequence: number;
  /** The text the hash covers (timestamp_str). */
  timestamp: string;
  userId: string;
  actorName: string | null;
  actorRole: string | null;
  sessionId: string | null;
  appVersion: string | null;
  action: string;
  entity: string;
  entityId: string;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
  hash: string;
  prevHash: string;
  hashVersion: number;
  hashAlg: string;
  seal: string | null;
}

export type FailureReason = 'LINK_BROKEN' | 'SEAL_BROKEN' | 'UNSUPPORTED_ALG' | 'UNSUPPORTED_VERSION' | 'CHECKPOINT_MISMATCH' | 'ENTRY_NOT_FOUND' | 'DOWNGRADE';

/** What the next row is chained to. `keyed`: a keyed row came before (sticky), so an unkeyed row now is a downgrade. */
export interface ChainTail { hash: string; seal: string | null; keyed?: boolean }

const pick = (r: any, camel: string, snake: string) => (r[camel] !== undefined ? r[camel] : r[snake]);
const orNull = (v: unknown) => (v === undefined || v === null ? null : (v as string));

/** Accepts a Drizzle row (camelCase), a raw pg row (snake_case) or a row from an older backup that has no v2 columns. */
export function normalizeAuditRow(r: any): AuditRecord {
  const stamp = pick(r, 'timestampStr', 'timestamp_str');
  return {
    id: r.id,
    sequence: r.sequence,
    // Rows from before timestamp_str existed fall back to the timestamp column, as the old verifier did.
    timestamp: stamp ?? (r.timestamp ? new Date(r.timestamp).toISOString() : ''),
    userId: pick(r, 'userId', 'user_id'),
    actorName: orNull(pick(r, 'actorName', 'actor_name')),
    actorRole: orNull(pick(r, 'actorRole', 'actor_role')),
    sessionId: orNull(pick(r, 'sessionId', 'session_id')),
    appVersion: orNull(pick(r, 'appVersion', 'app_version')),
    action: r.action,
    entity: r.entity,
    entityId: pick(r, 'entityId', 'entity_id'),
    field: r.field,
    oldValue: pick(r, 'oldValue', 'old_value'),
    newValue: pick(r, 'newValue', 'new_value'),
    reason: r.reason,
    hash: r.hash,
    prevHash: pick(r, 'prevHash', 'prev_hash'),
    hashVersion: pick(r, 'hashVersion', 'hash_version') ?? 1,
    hashAlg: pick(r, 'hashAlg', 'hash_alg') ?? 'sha256',
    seal: orNull(r.seal),
  };
}

type Hashed = Pick<AuditRecord, 'sequence' | 'timestamp' | 'userId' | 'action' | 'entity' | 'entityId' | 'field' | 'oldValue' | 'newValue' | 'reason'>;

const linkContent = (r: Hashed) => JSON.stringify({
  sequence: r.sequence, timestamp: r.timestamp, userId: r.userId, action: r.action, entity: r.entity, entityId: r.entityId,
  field: r.field, oldValue: r.oldValue, newValue: r.newValue, reason: r.reason,
});

const sealContent = (r: Hashed & Pick<AuditRecord, 'actorName' | 'actorRole' | 'sessionId' | 'appVersion' | 'hash'>) => JSON.stringify({
  v: 2, sequence: r.sequence, timestamp: r.timestamp, userId: r.userId, actorName: r.actorName, actorRole: r.actorRole,
  sessionId: r.sessionId, appVersion: r.appVersion, action: r.action, entity: r.entity, entityId: r.entityId, field: r.field,
  oldValue: r.oldValue, newValue: r.newValue, reason: r.reason, hash: r.hash,
});

export const linkHash = (r: Hashed, prevHash: string, alg = LEGACY_HASH_ALG): string => H(alg)(linkContent(r) + prevHash);
export const sealHash = (r: Parameters<typeof sealContent>[0], prevSeal: string, alg = LEGACY_HASH_ALG): string => H(alg)(sealContent(r) + prevSeal);

/** The value the next row's seal is chained to. */
export const sealAnchor = (tail: ChainTail | null): string => (tail ? tail.seal ?? tail.hash : GENESIS_HASH);

/** null when the row is intact and follows `prev` (null = the first row of the chain); otherwise why not. */
export function checkRow(r: AuditRecord, prev: ChainTail | null): FailureReason | null {
  if (r.hashVersion !== 1 && r.hashVersion !== 2) return 'UNSUPPORTED_VERSION';
  if (!isSupportedAlg(r.hashAlg)) return 'UNSUPPORTED_ALG';
  if (prev?.keyed && !isKeyedAlg(r.hashAlg) && !(r.hashVersion === 1 && r.entity === 'SYSTEM_MIGRATION')) return 'DOWNGRADE';
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  if (r.prevHash !== prevHash || r.hash !== linkHash(r, prevHash, r.hashAlg)) return 'LINK_BROKEN';
  if (r.hashVersion === 2) {
    if (!r.seal || r.seal !== sealHash(r, sealAnchor(prev), r.hashAlg)) return 'SEAL_BROKEN';
  } else if (r.seal !== null) {
    return 'SEAL_BROKEN'; // a v1 row has no seal; one that grew a seal was edited
  }
  return null;
}

/** The tail after `r`, for the next checkRow. */
export const nextTail = (r: AuditRecord, prev: ChainTail | null): ChainTail => ({ hash: r.hash, seal: r.seal, keyed: !!prev?.keyed || isKeyedAlg(r.hashAlg) });
