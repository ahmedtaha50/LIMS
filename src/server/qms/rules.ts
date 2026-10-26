/**
 * What a quality record must satisfy before a move of its lifecycle (src/server/qms/states.ts). Read through `ex`, so the same check
 * runs before the signature is asked for and again inside the transaction that makes the move (with the record locked).
 * A failed rule is 409 with a code the screen can show; every failed rule is listed in `details`.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { qmsActions, qmsEffectivenessChecks, qmsLinks, qmsRecords } from '../../db/schema/qms';
import type { Executor } from '../core/tx';
import { AppError } from '../http/errors';
import type { RuleName } from './states';

type QmsRow = typeof qmsRecords.$inferSelect;

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const SERIOUS = ['Major', 'Critical'];

/** The CAPA records linked to `recordId` (relation capa) that are not cancelled. */
export async function linkedCapas(ex: Executor, recordId: string) {
  const capa = alias(qmsRecords, 'capa');
  return ex.select({ id: capa.id, state: capa.state }).from(qmsLinks)
    .innerJoin(capa, eq(capa.id, qmsLinks.targetId))
    .where(and(eq(qmsLinks.recordId, recordId), eq(qmsLinks.relation, 'capa'), eq(qmsLinks.targetType, 'QmsRecord'), eq(capa.type, 'CAPA'), ne(capa.state, 'Cancelled')))
    .orderBy(capa.id);
}

async function actionCounts(ex: Executor, recordId: string) {
  const rows = await ex.select({ status: qmsActions.status, n: sql<number>`count(*)::int` }).from(qmsActions)
    .where(eq(qmsActions.recordId, recordId)).groupBy(qmsActions.status);
  const of = (s: string) => rows.find(r => r.status === s)?.n ?? 0;
  return { open: of('Open'), done: of('Done'), cancelled: of('Cancelled') };
}

/** The latest effectiveness check, if it was made on the record version `version` (a later move makes an older check stale). */
export async function currentEffectiveness(ex: Executor, recordId: string, version: number) {
  const [latest] = await ex.select().from(qmsEffectivenessChecks).where(eq(qmsEffectivenessChecks.recordId, recordId))
    .orderBy(desc(qmsEffectivenessChecks.checkedAt), desc(qmsEffectivenessChecks.id)).limit(1);
  return latest && latest.recordVersion === version ? latest : null;
}

async function check(ex: Executor, row: QmsRow, rule: RuleName): Promise<{ code: string; message: string } | null> {
  const p = row.payload ?? {};
  switch (rule) {
    case 'classified':
      return row.classification ? null : { code: 'CLASSIFICATION_REQUIRED', message: `${row.id} has no classification (Minor, Major or Critical).` };
    case 'rootCause':
      return filled(p.rootCause) ? null : { code: 'ROOT_CAUSE_REQUIRED', message: `${row.id} has no root cause recorded.` };
    case 'minorOnly':
      return row.classification === 'Minor' ? null
        : { code: 'CAPA_REQUIRED', message: `${row.id} is ${row.classification ?? 'not classified'}: a Major or Critical deviation needs a linked CAPA (go through CAPA Proposed) and an effectiveness check before it can close.` };
    case 'linkedCapa':
      return (await linkedCapas(ex, row.id)).length ? null : { code: 'CAPA_REQUIRED', message: `${row.id} has no linked CAPA.` };
    case 'linkedCapaIfSerious':
      if (!SERIOUS.includes(row.classification ?? '')) return null;
      return (await linkedCapas(ex, row.id)).length ? null
        : { code: 'CAPA_REQUIRED', message: `${row.id} is ${row.classification}: it cannot close without a linked CAPA.` };
    case 'capasClosed': {
      const open = (await linkedCapas(ex, row.id)).filter(c => c.state !== 'Closed');
      return open.length === 0 ? null
        : { code: 'CAPA_NOT_CLOSED', message: `Linked CAPA not closed: ${open.map(c => `${c.id} (${c.state})`).join(', ')}. A CAPA closes only on an effective effectiveness check.` };
    }
    case 'actionsFinished': {
      const { open } = await actionCounts(ex, row.id);
      return open === 0 ? null : { code: 'ACTIONS_OPEN', message: `${row.id} has ${open} open action(s).` };
    }
    case 'hasDoneAction':
      return (await actionCounts(ex, row.id)).done > 0 ? null : { code: 'NO_ACTION_DONE', message: `${row.id} has no completed action.` };
    case 'capaPlan': {
      const missing = [!filled(p.plan) && 'the action plan', !filled(p.effectivenessCriteria) && 'the effectiveness criteria'].filter(Boolean);
      const { open, done } = await actionCounts(ex, row.id);
      if (open + done === 0) missing.push('at least one action');
      return missing.length === 0 ? null : { code: 'CAPA_PLAN_INCOMPLETE', message: `${row.id} cannot be approved without ${missing.join(', ')}.` };
    }
    case 'effective': {
      const latest = await currentEffectiveness(ex, row.id, row.version);
      return latest?.result === 'Effective' ? null
        : { code: 'EFFECTIVENESS_REQUIRED', message: `${row.id} has no effectiveness check that found it effective in its current state. Record a signed effectiveness check first.` };
    }
    case 'impactAssessed':
      return filled(p.impactAssessment) ? null : { code: 'IMPACT_ASSESSMENT_REQUIRED', message: `${row.id} has no impact assessment.` };
    case 'emergency':
      return p.emergency === true ? null : { code: 'NOT_EMERGENCY', message: `${row.id} is not marked as an emergency change: it is approved after review (Under Review).` };
    case 'response':
      return filled(p.response) ? null : { code: 'RESPONSE_REQUIRED', message: `${row.id} has no response recorded.` };
  }
}

/** Throws 409 with the first failed rule's code and every failed rule in `details`. */
export async function assertRules(ex: Executor, row: QmsRow, rules: readonly RuleName[] = []): Promise<void> {
  const failed: Array<{ code: string; message: string }> = [];
  for (const rule of rules) {
    const f = await check(ex, row, rule);
    if (f) failed.push(f);
  }
  if (failed.length) throw new AppError(409, failed[0].code, failed.map(f => f.message).join(' '), failed);
}
