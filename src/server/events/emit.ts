/**
 * emitEvent: the one way to announce a business event (roadmap M23).
 *
 *   await withTransaction(db, async (tx, afterCommit) => {
 *     ... the change and its audit entry ...
 *     await emitEvent(tx, { type: 'result.oos_detected', payload, entity: 'Result', entityId, actorId: user.id }, afterCommit);
 *   });
 *
 * The event is a row of outbox_events written with the caller's transaction: if the change rolls back, so does the event, and
 * nothing is ever pushed to a socket, a webhook or a mailbox about a change that did not happen. The dispatcher picks the row up
 * after COMMIT; `afterCommit`, when given, only wakes it at once instead of at its next poll. The payload is checked against the
 * catalog's strict schema here, so an unknown key (a result value, say) fails the business transaction instead of leaking.
 */
import { randomBytes } from 'crypto';
import { outboxEvents } from '../../db/schema/events';
import type { AfterCommit, Executor } from '../core/tx';
import { eventDefinition, type EventPayload, type EventType } from './catalog';

export interface EmitInput<T extends EventType = EventType> {
  type: T;
  payload: EventPayload<T>;
  /** The record the event is about, as the audit trail names it (Result, BatchRelease, Instrument, SystemAlert). */
  entity: string;
  entityId: string;
  /** req.user.id, or the service principal for scheduled work. Never a client-supplied identity. */
  actorId: string;
}

type Wake = () => void;
const wakers = new Set<Wake>();
/** The running dispatcher of this process registers here (dispatcher.ts). */
export function onEventEmitted(wake: Wake): () => void { wakers.add(wake); return () => { wakers.delete(wake); }; }
export function wakeDispatchers(): void { for (const w of [...wakers]) { try { w(); } catch { /* a waker never fails the caller */ } } }

export const newEventId = () => `evt-${randomBytes(12).toString('hex')}`;

export async function emitEvent<T extends EventType>(tx: Executor, input: EmitInput<T>, afterCommit?: AfterCommit): Promise<string> {
  const def = eventDefinition(input.type);
  if (!input.actorId) throw new Error(`emitEvent(${input.type}): actorId is required (an event is always attributable).`);
  const parsed = def.payload.safeParse(input.payload);
  if (!parsed.success) {
    throw new Error(`emitEvent(${input.type}): the payload does not match the catalog: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
  const id = newEventId();
  await tx.insert(outboxEvents).values({
    id, type: def.type, typeVersion: def.version, entity: input.entity, entityId: input.entityId,
    payload: parsed.data as Record<string, unknown>, audience: def.audience, actorId: input.actorId,
  });
  afterCommit?.(() => wakeDispatchers());
  return id;
}
