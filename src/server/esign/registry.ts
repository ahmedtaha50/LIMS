/**
 * The record types that can be signed. A type registers what its signature covers (`canonical`): the content of the record as it
 * was signed. signRecord hashes it when the signature is made and the verifier hashes it again later, so the function must give
 * the same answer for as long as the signature is meant to verify:
 *   - read only columns that do not change after signing, or take the lifecycle state as signed from `change` (the audit entry
 *     of the signed action) with `asSigned`;
 *   - return null when the record no longer exists.
 * Types are registered by src/server/esign/entities.ts, which is imported by the service and the verifier. A track that adds a
 * record type calls registerSignable from its own module; a track that changes what a type signs adds a new hash version
 * (the input carries `hashVersion`) instead of changing version 2.
 */
import type { Executor } from '../core/tx';

/** The action a signature belongs to, as the audit entry recorded it. */
export interface SignedChange {
  action: string;
  field: string;
  oldValue: string;
  newValue: string;
}

export interface CanonicalInput {
  /** The entity id the signature carries (for a batch release, the batch). */
  id: string;
  /** The record version the signature is bound to (signatures.record_version). */
  recordVersion: number;
  /** The audit entry of the signed action; null if the entry cannot be found, in which case the signature cannot verify. */
  change: SignedChange | null;
  hashVersion: number;
}

export interface SignableEntity {
  /** Same spelling as the audit entry's `entity`: Sample, OOS, Specification, ... */
  type: string;
  canonical(ex: Executor, input: CanonicalInput): Promise<Record<string, unknown> | null>;
}

const TYPE = /^[A-Za-z][A-Za-z0-9]{1,63}$/;
const registry = new Map<string, SignableEntity>();

export function registerSignable(entity: SignableEntity): void {
  if (!TYPE.test(entity.type)) throw new Error(`registerSignable: "${entity.type}" is not a valid record type name.`);
  if (registry.has(entity.type)) throw new Error(`registerSignable: record type ${entity.type} is already registered.`);
  registry.set(entity.type, entity);
}

export const getSignable = (type: string): SignableEntity | undefined => registry.get(type);
export const signableTypes = (): string[] => [...registry.keys()].sort();

/** The lifecycle value as signed: the audit entry's new value when the signed action changed that field, else what the record holds. */
export function asSigned<T>(change: SignedChange | null, fields: string[], current: T): T | string {
  return change && fields.includes(change.field) ? change.newValue : current;
}
