// A refused request is a security event (AUTHZ_DENIED, src/server/audit/securityEvents.ts). It is written in a transaction of its own,
// committed before the 403 goes out: the request that was refused changes nothing, and the record of the attempt must survive.
import type { Request } from 'express';
import type { Db } from '../core/context';
import type { UserRow } from '../auth/sessions';
import { recordSecurityEvent, securityEventContext } from '../auth/events';

export function recordDenied(db: Db, req: Request, user: Pick<UserRow, 'id' | 'role'> | null, detail: Record<string, unknown>) {
  return recordSecurityEvent(db, {
    type: 'AUTHZ_DENIED',
    outcome: 'denied',
    actorId: user?.id ?? null,
    actorRole: user?.role ?? null,
    ...securityEventContext(req),
    detail: { method: req.method, path: req.path, ...detail },
  });
}
