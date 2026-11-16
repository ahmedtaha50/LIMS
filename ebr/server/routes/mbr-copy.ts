import { z } from 'zod';
import { withTx } from '../core/db.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import { copyToNewMaster } from '../mbr/copy.js';
import type { Ctx } from '../mbr/service.js';

// E23: copy a recipe version into a new master batch record (version 1, draft).
export const routes = [
  route({
    method: 'POST', path: '/api/mbrs/:id/versions/:versionId/copy', permission: 'mbr.design', status: 201,
    summary: 'Copy this version into a new master batch record (version 1, draft; the source is recorded)',
    input: strict({ code: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/), productName: z.string().min(1).max(200) }),
    handler: ({ pool, actor, res, input, params }) => withTx(pool, (c) => copyToNewMaster(
      { c, pool, check: passwordCheck(pool), actor: actor as Ctx['actor'], requestId: String(res.locals.requestId) },
      params.id as string, params.versionId as string, input)),
  }),
];
