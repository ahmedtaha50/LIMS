import { z } from 'zod';
import { withTx } from '../core/db.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import { reviewBuiltIn } from '../logbook/review.js';
import type { Ctx } from '../logbook/service.js';

// E28: QA review of a built-in logbook type version, signed with the meaning "reviewed".
export const routes = [
  route({
    method: 'POST', path: '/api/logbook-types/:typeId/versions/:versionId/qa-review', permission: 'logbook.type.approve',
    summary: 'QA reviews a built-in logbook type version before it is used (signed, meaning reviewed)',
    input: strict({ password: z.string().min(1).max(200), comment: z.string().trim().min(5).max(500) }),
    handler: ({ pool, actor, res, input, params }) => withTx(pool, (c) => reviewBuiltIn(
      { c, pool, check: passwordCheck(pool), actor: actor as Ctx['actor'], requestId: String(res.locals.requestId) },
      params.typeId as string, params.versionId as string, input)),
  }),
];
