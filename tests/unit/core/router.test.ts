import express from 'express';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { asyncHandler } from '../../../src/server/core/asyncHandler';
import { createRouter } from '../../../src/server/core/router';
import { errorHandler, requestContext } from '../../../src/server/http/errors';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const build = (router: express.Router) => {
  const app = express();
  app.use(requestContext(log), express.json(), router, errorHandler(log));
  return supertest(app);
};

describe('asyncHandler / createRouter', () => {
  it('turns a rejected async handler into a 500 instead of an unhandled rejection', async () => {
    const router = createRouter();
    router.post('/crash', async (req) => { (req.body.content as string).trim(); });
    const res = await build(router).post('/crash').send({ content: 123 });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('also catches a synchronous throw', async () => {
    const router = createRouter();
    router.get('/sync', () => { throw new Error('sync'); });
    expect((await build(router).get('/sync')).status).toBe(500);
  });

  it('wraps every handler in a chain, for every verb', async () => {
    const router = createRouter();
    const before = async (_req: express.Request, _res: express.Response, next: express.NextFunction) => { next(); };
    router.put('/chain', before, async () => { throw new Error('late'); });
    router.delete('/chain', async () => { throw new Error('late'); });
    router.patch('/chain', async () => { throw new Error('late'); });
    const request = build(router);
    expect((await request.put('/chain')).status).toBe(500);
    expect((await request.delete('/chain')).status).toBe(500);
    expect((await request.patch('/chain')).status).toBe(500);
  });

  it('leaves successful handlers and their responses untouched', async () => {
    const router = createRouter();
    router.get('/ok', async (_req, res) => { res.json({ ok: true }); });
    expect((await build(router).get('/ok')).body).toEqual({ ok: true });
  });

  it('keeps the function name, which the route table uses to recognise requireAuth', () => {
    const router = createRouter();
    async function requireAuth(_req: express.Request, _res: express.Response, next: express.NextFunction) { next(); }
    router.get('/named', requireAuth, (_req, res) => { res.end(); });
    const names = (router as any).stack[0].route.stack.map((l: any) => l.name);
    expect(names[0]).toBe('requireAuth');
  });

  it('does not wrap error-handling middleware (arity 4) and does not double-wrap', () => {
    const router = createRouter();
    const eh = (_e: unknown, _req: express.Request, _res: express.Response, _next: express.NextFunction) => undefined;
    router.get('/e', eh as any);
    expect((router as any).stack[0].route.stack[0].handle).toBe(eh);
    const wrapped = asyncHandler(async () => undefined);
    expect(asyncHandler(wrapped)).toBe(wrapped);
  });
});
