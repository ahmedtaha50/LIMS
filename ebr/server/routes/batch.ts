import type { Response } from 'express';
import { z } from 'zod';
import * as svc from '../batch/service.js';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { route, type Actor } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';

const password = z.string().min(1).max(200);
const tx = <T>(pool: Pool, actor: Actor | null, res: Response, fn: (x: svc.Ctx) => Promise<T>) =>
  withTx(pool, (c) => fn({ c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }));
const p = (params: Record<string, string>, k: string) => params[k] as string;

export const routes = [
  route({ method: 'GET', path: '/api/batches', permission: 'batch.read', summary: 'Batches with their progress and open exceptions', handler: ({ pool }) => svc.list(pool) }),
  route({ method: 'GET', path: '/api/batches/:id', permission: 'batch.read', summary: 'A batch: its steps in order, the next step, its exceptions', handler: ({ pool, params }) => svc.detail(pool, p(params, 'id')) }),
  route({
    method: 'POST', path: '/api/batches', permission: 'batch.create', summary: 'Create a batch from the effective version of a recipe', status: 201,
    input: strict({ mbrMasterId: z.uuid(), batchNumber: z.string().regex(/^[A-Za-z0-9._/-]{3,40}$/) }),
    handler: ({ pool, actor, res, input }) => tx(pool, actor, res, (x) => svc.createBatch(x, input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/steps/:stepId/record', permission: 'batch.execute', summary: 'Record and sign the next step (states the version read)',
    input: strict({ version, input: z.record(z.string(), z.unknown()).default({}), comment: z.string().max(2000).optional(), password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.recordStep(x, p(params, 'id'), p(params, 'stepId'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/steps/:stepId/verify', permission: 'batch.execute', summary: 'Verify a step as the second person',
    input: strict({ version, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.verifyStep(x, p(params, 'id'), p(params, 'stepId'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/exceptions/:exceptionId/deviation', permission: 'batch.exception', summary: 'Hand an exception to a deviation (its number stays on the batch)',
    input: strict({ version, deviationNumber: z.string().regex(/^[A-Za-z0-9._/-]{3,40}$/), password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.raiseDeviation(x, p(params, 'id'), p(params, 'exceptionId'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/exceptions/:exceptionId/close', permission: 'batch.exception', summary: 'Close an exception with a signed justification',
    input: strict({ version, note: z.string().min(10).max(2000), password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.closeException(x, p(params, 'id'), p(params, 'exceptionId'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/complete', permission: 'batch.complete', summary: 'Close the batch when every step is recorded and verified and no exception is open',
    input: strict({ version, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.completeBatch(x, p(params, 'id'), input)),
  }),
];
