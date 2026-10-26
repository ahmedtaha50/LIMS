/**
 * Record-level segregation of duties (roadmap M09; 21 CFR Part 11.10(g), Annex 11 s.12): the person who signs for a record must
 * be independent of the people who made it. One helper for every four-eyes rule, so a rule is a row in sod_rules instead of an
 * if-statement copied into a handler.
 *
 *   assertIndependent(participants, actorId, rule)        pure: throws 403 SOD_VIOLATION when the actor is among the participants
 *   auditParticipants(ex, entity, entityId, actions)      who took one of these actions on the record, from the audit trail
 *   assertIndependentOfRecord(ex, ruleCode, id, actorId)  the two together, with the rule read from sod_rules
 *
 * The participants come from the audit trail, not from a column: it exists for every record already, it cannot be edited, and
 * it needs no author column on tables whose layout other tracks own. Handlers that already enforce a rule of their own (a sample
 * cannot be approved by the person who entered its results) keep it.
 */
import { eq, sql } from 'drizzle-orm';
import { sodRules } from '../../db/schema/authz';
import type { Executor } from '../core/tx';
import { AppError } from '../http/errors';

export interface SodRuleText { code: string; description: string }

export class SodViolationError extends AppError {
  constructor(rule: SodRuleText, details: Record<string, unknown> = {}) {
    super(403, 'SOD_VIOLATION',
      `Segregation of duties: ${rule.description} You took part in this record, so an independent person must sign.`,
      { rule: rule.code, ...details });
  }
}

export function assertIndependent(participants: Iterable<string | null | undefined>, actorId: string, rule: SodRuleText, details: Record<string, unknown> = {}): void {
  for (const p of participants) if (p === actorId) throw new SodViolationError(rule, details);
}

/** The users who took one of `actions` on the record, per the audit trail. */
export async function auditParticipants(ex: Executor, entity: string, entityId: string, actions: readonly string[]): Promise<Set<string>> {
  if (actions.length === 0) return new Set();
  const res = await ex.execute(sql`
    SELECT DISTINCT user_id FROM audit_trail
    WHERE entity = ${entity} AND entity_id = ${entityId} AND action IN (${sql.join(actions.map(a => sql`${a}`), sql`, `)})`);
  return new Set((res as any).rows.map((r: { user_id: string }) => r.user_id));
}

export async function loadSodRule(ex: Executor, code: string) {
  const [rule] = await ex.select().from(sodRules).where(eq(sodRules.code, code)).limit(1);
  if (!rule) throw new Error(`Unknown segregation-of-duties rule: ${code}`);
  return rule;
}

/** `extraParticipants`: people the rule excludes that the audit trail does not name (for a role change, the person it is for). */
export async function assertIndependentOfRecord(ex: Executor, ruleCode: string, entityId: string, actorId: string, extraParticipants: Iterable<string> = []): Promise<void> {
  const rule = await loadSodRule(ex, ruleCode);
  const participants = await auditParticipants(ex, rule.entity, entityId, rule.authorActions);
  assertIndependent([...participants, ...extraParticipants], actorId, rule, { entity: rule.entity, entityId });
}
