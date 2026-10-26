/** Strict input schemas of the audit and security-event routes (AGENTS.md section 3). Query strings arrive as text, hence coerce. */
import { z } from 'zod';

const when = z.iso.datetime({ offset: true });
const id = (max: number) => z.string().min(1).max(max);

/** The filters of GET /audit and of its export. */
const auditFilter = {
  entity: id(100).optional(),
  entityId: id(200).optional(),
  userId: id(100).optional(),
  actorRole: id(50).optional(),
  action: id(100).optional(),
  from: when.optional(),
  to: when.optional(),
};

const page = {
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
};

export const auditListQuery = z.object({ ...auditFilter, ...page }).strict();

export const auditExportBody = z.object({ ...auditFilter, reason: z.string().trim().min(3).max(500) }).strict();

/** "Entity:id,Entity:id" -> pairs. */
const refs = z.string().max(4000).transform((text, ctx) => {
  const out: Array<{ entity: string; entityId: string }> = [];
  for (const part of text.split(',')) {
    const at = part.indexOf(':');
    if (at < 1 || at === part.length - 1) { ctx.addIssue({ code: 'custom', message: 'refs must be Entity:id pairs separated by commas.' }); return z.NEVER; }
    out.push({ entity: part.slice(0, at), entityId: part.slice(at + 1) });
  }
  if (out.length > 25) { ctx.addIssue({ code: 'custom', message: 'At most 25 refs.' }); return z.NEVER; }
  return out;
});

export const auditHistoryQuery = z.object({ entity: id(100), entityId: id(200), refs: refs.optional(), ...page }).strict();

export const emptyBody = z.object({}).strict();

export const securityEventsQuery = z.object({
  type: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'type must be an UPPER_SNAKE event type.').optional(),
  outcome: z.enum(['success', 'failure', 'denied', 'info']).optional(),
  actorId: id(200).optional(),
  from: when.optional(),
  to: when.optional(),
  cursor: page.cursor,
  limit: page.limit,
}).strict();

export type AuditListQuery = z.infer<typeof auditListQuery>;
export type AuditHistoryQuery = z.infer<typeof auditHistoryQuery>;
export type SecurityEventsQuery = z.infer<typeof securityEventsQuery>;
