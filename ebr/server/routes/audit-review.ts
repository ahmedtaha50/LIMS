import { z } from 'zod';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';

type Row = { id: string; at: Date; actor_name: string; action: string; entity: string; entity_id: string; old_value: unknown; new_value: unknown; reason: string | null };

// E32#3: the audit trail reviewed in the application (Annex 11 §9): the latest entries, filtered by record, action, user
// and period, newest first. Reading only; the chain itself is verified by GET /api/audit/verify.
export const routes = [
  route({
    method: 'GET', path: '/api/audit/recent', permission: 'audit.read', summary: 'Recent audit entries, filtered by record, action, user and period',
    input: strict({
      entity: z.string().max(64).optional(), entityId: z.string().max(128).optional(), action: z.string().max(64).optional(), actor: z.string().max(100).optional(),
      from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    handler: async ({ pool, input }) => {
      const where: string[] = [], args: unknown[] = [];
      const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
      if (input.entity) add('entity = ?', input.entity);
      if (input.entityId) add('entity_id = ?', input.entityId);
      if (input.action) add('action LIKE ?', `${input.action.replace(/[%_\\]/g, '\\$&')}%`);
      if (input.actor) add('lower(actor_name) = lower(?)', input.actor);
      if (input.from) add('at >= ?::date', input.from);
      if (input.to) add("at < ?::date + interval '1 day'", input.to);
      args.push(input.limit);
      const rows = (await pool.query<Row>(`SELECT id, at, actor_name, action, entity, entity_id, old_value, new_value, reason FROM audit_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${args.length}`, args)).rows;
      return rows.map(r => ({ id: r.id, at: r.at.toISOString(), actorName: r.actor_name, action: r.action, entity: r.entity, entityId: r.entity_id, oldValue: r.old_value, newValue: r.new_value, reason: r.reason }));
    },
  }),
];
