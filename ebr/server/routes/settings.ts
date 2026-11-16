import { z } from 'zod';
import { withTx } from '../core/db.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import * as svc from '../settings/index.js';

// E27: site settings. Reading is for administrators and QA; changing is for administrators, signed, with a reason.
export const routes = [
  route({ method: 'GET', path: '/api/settings', permission: 'settings.read', summary: 'Site settings with their values, defaults and last change', handler: ({ pool }) => svc.list(pool) }),
  route({
    method: 'PUT', path: '/api/settings/:key', permission: 'settings.manage', summary: 'Change a site setting (within bounds, signed, with a reason)',
    input: strict({ value: z.unknown(), rowVersion: z.number().int().min(0), reason: z.string().trim().min(5).max(500), password: z.string().min(1).max(200) }),
    handler: ({ pool, actor, res, input, params }) => withTx(pool, (c) => svc.change(
      { c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }, params.key as string, input)),
  }),
];
