import { z } from 'zod';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';
import { MEANINGS, signaturesOf } from '../esign/index.js';

export const routes = [
  route({
    method: 'GET', path: '/api/signatures', permission: 'signatures.read', summary: 'The signatures of one record',
    input: strict({ entity: z.string().min(1).max(64), entityId: z.string().min(1).max(128) }),
    handler: ({ pool, input }) => signaturesOf(pool, input.entity, input.entityId),
  }),
  route({
    method: 'GET', path: '/api/signatures/meanings', permission: 'session', summary: 'The signature meanings the system knows',
    handler: () => MEANINGS,
  }),
];
