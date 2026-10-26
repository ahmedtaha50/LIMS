/**
 * The change-control gate (roadmap M27, QA-12). When the setting `change_control_required` is on (qms_settings, changed only by an
 * e-signature), a controlled change needs a change control in state Approved that affects the record being changed:
 *
 *   approving a specification    target { type: 'Specification', id: <the revision being approved> }
 *   approving a role change      target { type: 'User', id: <the user whose role changes> }
 *   making a document effective  target { type: 'Document', id: <document id> }   (for r2-docs-training)
 *
 * Without one the change is refused with 409 CHANGE_REQUIRED. Each owning route calls the gate twice:
 *   1. assertChangeAuthorised(db, target) before the signature is asked for, so a refusal costs the signer no attempt;
 *   2. consumeChange(tx, actorId, target) inside the transaction that makes the change: it locks the change control, checks it again
 *      and records that it was implemented on that record (an `implemented` link and a ChangeImplemented audit entry), so one approval
 *      is used once per affected record and the change and its authorisation commit or roll back together.
 * The emergency path is a change control approved from Draft by one signature with the meaning QMS_EMERGENCY_CHANGE (states.ts).
 */
import { randomBytes } from 'crypto';
import { and, asc, eq, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { qmsLinks, qmsRecords } from '../../db/schema/qms';
import { writeAudit } from '../../db/utils';
import { lockRow, type Executor, type Tx } from '../core/tx';
import { AppError } from '../http/errors';
import { getSettings } from './engine';

export interface ChangeTarget { type: 'Specification' | 'User' | 'Document' | string; id: string }

export async function isChangeControlRequired(ex: Executor): Promise<boolean> {
  return (await getSettings(ex)).changeControlRequired;
}

/** Approved change controls that affect `target` and have not been implemented on it yet, oldest first. */
export async function findApprovedChanges(ex: Executor, target: ChangeTarget) {
  const done = alias(qmsLinks, 'done');
  return ex.select({ id: qmsRecords.id, title: qmsRecords.title }).from(qmsRecords)
    .innerJoin(qmsLinks, and(eq(qmsLinks.recordId, qmsRecords.id), eq(qmsLinks.relation, 'affects'), eq(qmsLinks.targetType, target.type), eq(qmsLinks.targetId, target.id)))
    .where(and(
      eq(qmsRecords.type, 'ChangeControl'), eq(qmsRecords.state, 'Approved'),
      notExists(ex.select({ id: done.id }).from(done).where(and(eq(done.recordId, qmsRecords.id), eq(done.relation, 'implemented'), eq(done.targetType, target.type), eq(done.targetId, target.id)))),
    ))
    .orderBy(asc(qmsRecords.createdAt), asc(qmsRecords.id));
}

function refuse(target: ChangeTarget): never {
  throw new AppError(409, 'CHANGE_REQUIRED',
    `Change control is required: no Approved change control affects ${target.type} ${target.id}. Raise a change control that affects it and have it approved first (in an emergency, QA can authorise an emergency change).`,
    { targetType: target.type, targetId: target.id });
}

/** Before the signature: 409 CHANGE_REQUIRED when the setting is on and no Approved change control affects the target. */
export async function assertChangeAuthorised(ex: Executor, target: ChangeTarget): Promise<void> {
  if (!(await isChangeControlRequired(ex))) return;
  if ((await findApprovedChanges(ex, target)).length === 0) refuse(target);
}

/**
 * Inside the change's transaction. Returns the change control used, or null when the setting is off. The change control's row lock
 * is held until the transaction ends, so it cannot be closed or used twice for the same record meanwhile.
 */
export async function consumeChange(tx: Tx, actorId: string, target: ChangeTarget, what: string): Promise<string | null> {
  if (!(await isChangeControlRequired(tx))) return null;
  for (const candidate of await findApprovedChanges(tx, target)) {
    const cc = await lockRow(tx, qmsRecords, candidate.id);
    if (cc.state !== 'Approved') continue;
    const inserted = await tx.insert(qmsLinks).values({
      id: `QL-${randomBytes(6).toString('hex')}`, recordId: cc.id, relation: 'implemented', targetType: target.type, targetId: target.id, createdBy: actorId,
    }).onConflictDoNothing().returning({ id: qmsLinks.id });
    if (!inserted.length) continue;
    await writeAudit(tx, actorId, 'ChangeImplemented', 'QmsRecord', cc.id, 'implemented', '', `${target.type} ${target.id}`, `${what} under change control ${cc.id}`);
    return cc.id;
  }
  refuse(target);
}
