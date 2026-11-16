import type { Response } from 'express';
import { z } from 'zod';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { route, type Actor } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import * as svc from '../mbr/service.js';

const password = z.string().min(1).max(200);
const tx = <T>(pool: Pool, actor: Actor | null, res: Response, fn: (x: svc.Ctx) => Promise<T>) =>
  withTx(pool, (c) => fn({ c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }));
const p = (params: Record<string, string>, k: string) => params[k] as string;
const act = strict({ rowVersion: version, password });

export const routes = [
  route({ method: 'GET', path: '/api/mbrs', permission: 'mbr.read', summary: 'Master batch records with their versions', handler: ({ pool }) => svc.list(pool) }),
  route({
    method: 'POST', path: '/api/mbrs', permission: 'mbr.design', summary: 'Create a master batch record (version 1, draft)', status: 201,
    input: strict({ code: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/), productName: z.string().min(1).max(200), design: z.unknown() }),
    handler: ({ pool, actor, res, input }) => tx(pool, actor, res, (x) => svc.create(x, input)),
  }),
  route({
    method: 'PUT', path: '/api/mbrs/:id/versions/:versionId', permission: 'mbr.design', summary: 'Change a draft version (states the version read)',
    input: strict({ rowVersion: version, design: z.unknown() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.editDraft(x, p(params, 'id'), p(params, 'versionId'), input.rowVersion, input.design)),
  }),
  route({
    method: 'POST', path: '/api/mbrs/:id/versions', permission: 'mbr.design', summary: 'Start a new draft from the effective version', status: 201,
    handler: ({ pool, actor, res, params }) => tx(pool, actor, res, (x) => svc.newDraft(x, p(params, 'id'))),
  }),
  route({
    method: 'POST', path: '/api/mbrs/:id/versions/:versionId/submit', permission: 'mbr.design', summary: 'Sign a draft as its author and send it to QA', input: act,
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.submit(x, p(params, 'id'), p(params, 'versionId'), input.rowVersion, input.password)),
  }),
  route({
    method: 'POST', path: '/api/mbrs/:id/versions/:versionId/approve', permission: 'mbr.approve', summary: 'QA approval of a version in review',
    input: strict({ rowVersion: version, password, comment: z.string().max(1000).optional() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.approve(x, p(params, 'id'), p(params, 'versionId'), input.rowVersion, input.password, input.comment ?? null)),
  }),
  route({
    method: 'POST', path: '/api/mbrs/:id/versions/:versionId/reject', permission: 'mbr.approve', summary: 'QA sends a version back to draft, with a reason',
    input: strict({ rowVersion: version, password, reason: z.string().min(3).max(1000) }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.reject(x, p(params, 'id'), p(params, 'versionId'), input.rowVersion, input.password, input.reason)),
  }),
  route({
    method: 'POST', path: '/api/mbrs/:id/versions/:versionId/make-effective', permission: 'mbr.approve', summary: 'Make an approved version the effective one (the previous one retires)', input: act,
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.makeEffective(x, p(params, 'id'), p(params, 'versionId'), input.rowVersion, input.password)),
  }),
];
