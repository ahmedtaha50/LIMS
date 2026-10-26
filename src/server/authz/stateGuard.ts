// Reads the status of the record a route is about and applies the state machine of src/server/workflow/entityStates.ts before the
// handler runs. A record that does not exist is left to the handler (404). The handler keeps its own version check: this guard
// reads outside the handler's transaction, so it refuses early and the optimistic-concurrency predicate still decides a race.
import { sql } from 'drizzle-orm';
import type { Db } from '../core/context';
import { assertEditable, assertTransition, ENTITY_STATES, type EntityType } from '../workflow/entityStates';
import type { StateGuard } from './types';

interface Locator { table: string; key: string; status: string }

const LOCATORS: Record<EntityType, Locator> = {
  oos: { table: 'oos_investigations', key: 'id', status: 'status' },
  specification: { table: 'specifications', key: 'id', status: 'status' },
  batchRelease: { table: 'batch_releases', key: 'batch', status: 'status' },
  // A worksheet that is locked is signed, whatever its status text says.
  eln: { table: 'lab_notebook', key: 'id', status: `CASE WHEN locked THEN 'Signed' ELSE status END` },
  instrument: { table: 'instruments', key: 'id', status: 'status' },
};

export async function currentState(db: Db, entity: EntityType, id: string): Promise<string | null> {
  const l = LOCATORS[entity];
  const res = await db.execute(sql`SELECT ${sql.raw(l.status)} AS state FROM ${sql.identifier(l.table)} WHERE ${sql.identifier(l.key)} = ${id} LIMIT 1`);
  const row = (res as any).rows[0];
  if (row) return String(row.state);
  return entity === 'batchRelease' ? ENTITY_STATES.batchRelease.initial : null; // a batch with no release record is in quarantine
}

export async function applyStateGuard(db: Db, guard: StateGuard, params: Record<string, string>): Promise<void> {
  const id = params[guard.param];
  if (!id) return;
  const state = await currentState(db, guard.entity, id);
  if (state === null) return;
  if (guard.require === 'editable') assertEditable(guard.entity, state);
  else assertTransition(guard.entity, state, guard.to);
}
