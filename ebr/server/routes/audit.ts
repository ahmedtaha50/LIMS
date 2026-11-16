import { z } from 'zod';
import { auditOf, verifyChain } from '../audit/index.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';

export const routes = [
  route({
    method: 'GET', path: '/api/audit', permission: 'audit.read', summary: 'The audit trail of one record',
    input: strict({ entity: z.string().min(1).max(64), entityId: z.string().min(1).max(128) }),
    handler: ({ pool, input }) => auditOf(pool, input.entity, input.entityId),
  }),
  route({
    method: 'GET', path: '/api/audit/verify', permission: 'audit.verify', summary: 'Recompute the hash chain of the whole audit trail',
    handler: ({ pool }) => verifyChain(pool),
  }),
];
