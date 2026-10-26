/**
 * The content hash of a signature (hash_version 2), free of I/O so the signer, the verifier and the tests share one definition.
 *
 *   contentHash = sha256( canonicalJson({ v: 2, entityType, entityId, recordVersion, content }) )
 *
 * `content` is what the record type registers as the signed content of the record (src/server/esign/entities.ts). The text is
 * canonical: object keys are sorted at every depth, dates are ISO-8601 strings, undefined members are dropped. The same record
 * therefore always gives the same text, whatever order the database or the code listed its columns in.
 * A change of what a record type signs is a new hash version with its own function; version 2 stays as it is, because signatures
 * made under it have to keep verifying.
 */
import { createHash } from 'crypto';

/** The version signRecord writes. 1 is the set of per-record formulas of v0.1.0 (src/server/esign/legacy.ts). */
export const SIGNATURE_HASH_VERSION = 2;

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export interface HashInput {
  entityType: string;
  entityId: string;
  recordVersion: number;
  content: unknown;
}

export function signatureContentHash(input: HashInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: SIGNATURE_HASH_VERSION, entityType: input.entityType, entityId: input.entityId, recordVersion: input.recordVersion, content: input.content }))
    .digest('hex');
}
