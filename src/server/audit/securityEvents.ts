/**
 * Security events (roadmap M08, SEC-09): who tried to sign in and failed, who was locked out, what was refused, what left the
 * system, what configuration changed. A separate table and a separate hash chain from the audit trail, because most of these
 * events have no record they belong to, and many happen while nobody is authenticated.
 *
 * recordSecurityEvent(db, ...) opens its OWN transaction on purpose: the request that raised the event usually rolls back or
 * answers 401, and the trace of what was attempted must survive that. writeSecurityEvent(tx, ...) is the same write inside a
 * transaction the caller already has, for bookkeeping that must commit together with the event (a failed-attempt counter and
 * the lockout it caused); it is only as durable as that transaction, so open that one for the failure path, not for the business
 * change. A transaction that needs both an audit entry and a security event writes the AUDIT ENTRY FIRST: each chain has its
 * own advisory lock, and one order everywhere cannot deadlock.
 *
 * Event type is an open vocabulary (UPPER_SNAKE, 3-64 characters) so a track can add one without changing this module;
 * SECURITY_EVENT_TYPES lists those in use. A call that fails throws: a security event that could not be written must not
 * pass silently.
 */
import { createHash, randomBytes } from 'crypto';
import { and, asc, desc, eq, gt, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { securityEvents } from '../../db/schema';
import { appVersion } from '../boot/version';
import type { Db } from '../core/context';
import type { Tx } from '../core/tx';
import { GENESIS_HASH } from './hash';
import { currentSessionId } from './context';

/** Takes its own key; 7001 is the audit chain and 7002 the migration runner. */
const SECURITY_CHAIN_LOCK = 7003;
const MAX_DETAIL = 4000;
const HASH_ALG = 'sha256';

export const SECURITY_EVENT_TYPES = [
  'AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'AUTH_MFA_FAILED', 'AUTH_RECOVERY_CODE_USED', 'AUTH_REAUTH', 'AUTH_LOGOUT', 'AUTH_PASSWORD_CHANGED',
  'AUTH_SESSION_EXPIRED', 'LOCKOUT', 'AUTHZ_DENIED', 'EXPORT', 'CONFIG', 'EXTERNAL_CALL', 'AUDIT_VERIFY',
] as const;
export const SECURITY_OUTCOMES = ['success', 'failure', 'denied', 'info'] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

const TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export interface SecurityEventInput {
  type: string;
  outcome: SecurityOutcome;
  /** The authenticated or identified user, when there is one. */
  actorId?: string | null;
  /** What the actor claimed to be when nobody was identified (the e-mail address typed at the login). */
  actorLabel?: string | null;
  actorRole?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Free-form context. Credential-looking keys are removed, the result is capped at 4,000 characters. */
  detail?: unknown;
}

export type SecurityEvent = typeof securityEvents.$inferSelect;

/** ip, userAgent, requestId and sessionId of a request, for spreading into recordSecurityEvent. */
export function securityEventContext(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: (req as any).id ?? null,
    sessionId: (req as any).sessionId ?? currentSessionId() ?? null,
  };
}

// Keys that look like credentials are dropped, whatever the caller meant to log (a flag such as passwordChanged: true is kept).
const SECRET_KEY = /token|secret|passw|passphrase|totp|api[_-]?key|private[_-]?key|credential|^(code|otp|pin|authorization|cookie|cookies|auth)$/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return '[too deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      if (SECRET_KEY.test(k) && typeof v !== 'boolean') continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) return '';
  const text = JSON.stringify(sanitize(detail)) ?? '';
  if (text.length <= MAX_DETAIL) return text;
  let preview = text.slice(0, 3000);
  let out = JSON.stringify({ truncated: true, preview });
  while (out.length > MAX_DETAIL) { preview = preview.slice(0, Math.floor(preview.length * 0.8)); out = JSON.stringify({ truncated: true, preview }); }
  return out;
}

const clip = (v: string | null | undefined, max: number) => (v == null ? null : v.length > max ? v.slice(0, max) : v);

const sha = (data: string) => createHash(HASH_ALG).update(data).digest('hex');

type Hashed = Pick<SecurityEvent, 'sequence' | 'eventType' | 'outcome' | 'actorId' | 'actorLabel' | 'actorRole' | 'sessionId' | 'ip' | 'userAgent' | 'requestId' | 'detail' | 'appVersion'> & { timestampStr: string };

/** hash_version 1 of a security event: H(JSON{...every field below} + prevHash). */
export const securityEventHash = (e: Hashed, prevHash: string): string => sha(JSON.stringify({
  sequence: e.sequence, timestamp: e.timestampStr, eventType: e.eventType, outcome: e.outcome, actorId: e.actorId, actorLabel: e.actorLabel,
  actorRole: e.actorRole, sessionId: e.sessionId, ip: e.ip, userAgent: e.userAgent, requestId: e.requestId, detail: e.detail, appVersion: e.appVersion,
}) + prevHash);

/** The write itself, inside a transaction the caller has (see the header). */
export async function writeSecurityEvent(tx: Tx, input: SecurityEventInput): Promise<SecurityEvent> {
  if (typeof input.type !== 'string' || !TYPE_PATTERN.test(input.type)) throw new Error(`Invalid security event type: ${JSON.stringify(input.type)}.`);
  if (!(SECURITY_OUTCOMES as readonly string[]).includes(input.outcome)) throw new Error(`Invalid security event outcome: ${JSON.stringify(input.outcome)}.`);
  const detail = detailText(input.detail);

  await tx.execute(sql`select pg_advisory_xact_lock(${SECURITY_CHAIN_LOCK})`);
  const [last] = await tx.select({ sequence: securityEvents.sequence, hash: securityEvents.hash }).from(securityEvents).orderBy(desc(securityEvents.sequence)).limit(1);
  const at = new Date();
  const row = {
    id: `sev-${randomBytes(8).toString('hex')}`,
    sequence: last ? last.sequence + 1 : 1,
    timestamp: at,
    timestampStr: at.toISOString(),
    eventType: input.type,
    outcome: input.outcome,
    actorId: clip(input.actorId, 200),
    actorLabel: clip(input.actorLabel, 320),
    actorRole: clip(input.actorRole, 100),
    sessionId: clip(input.sessionId ?? currentSessionId(), 200),
    ip: clip(input.ip, 64),
    userAgent: clip(input.userAgent, 512),
    requestId: clip(input.requestId, 100),
    detail,
    appVersion: appVersion(),
    hashVersion: 1,
    hashAlg: HASH_ALG,
    prevHash: last ? last.hash : GENESIS_HASH,
  };
  const hash = securityEventHash(row, row.prevHash);
  const [stored] = await tx.insert(securityEvents).values({ ...row, hash }).returning();
  return stored;
}

/** The write in a transaction of its own, committed before this returns. */
export function recordSecurityEvent(db: Db, input: SecurityEventInput): Promise<SecurityEvent> {
  return db.transaction(tx => writeSecurityEvent(tx, input));
}

export interface SecurityVerification { isValid: boolean; compromisedSequence: number | null; reason: 'LINK_BROKEN' | 'UNSUPPORTED_ALG' | 'UNSUPPORTED_VERSION' | null; totalRecords: number }

/** Verifies the security event chain from the first event, in keyset batches. */
export async function verifySecurityChain(db: Db, options: { batchSize?: number } = {}): Promise<SecurityVerification> {
  const batch = options.batchSize ?? 2000;
  let last = 0, prevHash = GENESIS_HASH, total = 0;
  for (;;) {
    const rows = await db.select().from(securityEvents).where(gt(securityEvents.sequence, last)).orderBy(asc(securityEvents.sequence)).limit(batch);
    if (rows.length === 0) return { isValid: true, compromisedSequence: null, reason: null, totalRecords: total };
    for (const r of rows) {
      total++;
      const fail = (reason: SecurityVerification['reason']): SecurityVerification => ({ isValid: false, compromisedSequence: r.sequence, reason, totalRecords: total });
      if (r.hashVersion !== 1) return fail('UNSUPPORTED_VERSION');
      if (r.hashAlg !== HASH_ALG) return fail('UNSUPPORTED_ALG');
      if (r.prevHash !== prevHash || r.hash !== securityEventHash({ ...r, timestampStr: r.timestampStr }, prevHash)) return fail('LINK_BROKEN');
      prevHash = r.hash;
      last = r.sequence;
    }
  }
}

export interface SecurityEventFilter {
  type?: string; outcome?: SecurityOutcome; actorId?: string; from?: string; to?: string;
  cursor?: number; limit: number;
}

/** Newest first; `cursor` is the sequence of the last event of the previous page. */
export async function querySecurityEvents(db: Db, f: SecurityEventFilter) {
  const where: SQL[] = [];
  if (f.type) where.push(eq(securityEvents.eventType, f.type));
  if (f.outcome) where.push(eq(securityEvents.outcome, f.outcome));
  if (f.actorId) where.push(eq(securityEvents.actorId, f.actorId));
  if (f.from) where.push(gte(securityEvents.timestamp, new Date(f.from)));
  if (f.to) where.push(lte(securityEvents.timestamp, new Date(f.to)));
  if (f.cursor !== undefined) where.push(lt(securityEvents.sequence, f.cursor));
  const rows = await db.select().from(securityEvents).where(and(...where)).orderBy(desc(securityEvents.sequence)).limit(f.limit + 1);
  const hasMore = rows.length > f.limit;
  const events = hasMore ? rows.slice(0, f.limit) : rows;
  return { events, hasMore, nextCursor: hasMore ? events[events.length - 1].sequence : null };
}

/** The types in use: the known list plus any other type that has been recorded. */
export async function securityEventTypes(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ type: securityEvents.eventType }).from(securityEvents);
  return [...new Set<string>([...SECURITY_EVENT_TYPES, ...rows.map(r => r.type)])].sort();
}
