import express, { type Express } from 'express';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError,
  errorHandler, notFoundHandler, requestContext,
} from '../../../src/server/http/errors';

const makeLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function harness(setup: (app: Express) => void, log = makeLog()) {
  const app = express();
  app.use(requestContext(log));
  app.use(express.json({ limit: '1kb' }));
  setup(app);
  app.use(notFoundHandler);
  app.use(errorHandler(log));
  return { request: supertest(app), log };
}

describe('AppError hierarchy', () => {
  it.each([
    [new ValidationError('bad field', [{ path: 'a', message: 'x' }]), 400, 'VALIDATION_FAILED'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
  ])('%o is sent as %i %s with a request id', async (err, status, code) => {
    const { request } = harness(app => app.get('/boom', () => { throw err; }));
    const res = await request.get('/boom');
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code, error: err.message, requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(err).toBeInstanceOf(AppError);
  });

  it('ConflictError keeps the word "Conflict" because legacy handlers map statuses by message text', () => {
    expect(new ConflictError().message).toMatch(/^Conflict:/);
  });

  it('carries validation details to the client', async () => {
    const { request } = harness(app => app.get('/v', () => { throw new ValidationError('a is required', [{ path: 'a', message: 'a is required' }]); }));
    expect((await request.get('/v')).body.details).toEqual([{ path: 'a', message: 'a is required' }]);
  });
});

describe('errorHandler', () => {
  it('hides the message of an unexpected error, logs it with the request id, and answers 500', async () => {
    const { request, log } = harness(app => app.get('/boom', () => { throw new Error('select * from users where password = 123'); }));
    const res = await request.get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('select');
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ requestId: res.body.requestId, method: 'GET', path: '/boom' }), expect.any(String));
  });

  it('maps a ZodError to 400 with the issue messages', async () => {
    const { request } = harness(app => app.get('/z', () => { z.object({ a: z.string() }).strict().parse({ a: 1, b: 2 }); }));
    const res = await request.get('/z');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('maps malformed JSON to 400 INVALID_JSON and an oversized body to 413', async () => {
    const { request } = harness(app => app.post('/p', (_req, res) => { res.json({ ok: true }); }));
    const bad = await request.post('/p').set('content-type', 'application/json').send('{"a": ');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_JSON', requestId: expect.any(String) });
    const big = await request.post('/p').send({ blob: 'x'.repeat(4000) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not try to answer twice when headers are already sent', async () => {
    const { request, log } = harness(app => app.get('/late', (_req, res, next) => { res.status(200).write('partial'); next(new Error('after headers')); }));
    await request.get('/late').catch(() => undefined); // Express aborts the connection
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.any(String) }), 'error after the response had started');
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { request } = harness(() => undefined);
    const res = await request.get('/nothing');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
  });
});

describe('requestContext', () => {
  it('honours a well-formed inbound X-Request-Id and replaces a hostile one', async () => {
    const { request } = harness(app => app.get('/id', (_req, res) => { res.json({ ok: true }); }));
    expect((await request.get('/id').set('X-Request-Id', 'abc12345-test')).headers['x-request-id']).toBe('abc12345-test');
    const replaced = (await request.get('/id').set('X-Request-Id', 'bad id with spaces\t')).headers['x-request-id'];
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adds the request id to legacy error bodies and leaves success bodies alone', async () => {
    const { request } = harness(app => {
      app.get('/legacy-error', (_req, res) => { res.status(409).json({ error: 'Conflict: legacy' }); });
      app.get('/ok', (_req, res) => { res.json({ fine: true }); });
    });
    const err = await request.get('/legacy-error');
    expect(err.body).toEqual({ error: 'Conflict: legacy', requestId: err.headers['x-request-id'] });
    expect((await request.get('/ok')).body).toEqual({ fine: true });
  });

  it('withholds SQL text and parameters that a legacy handler copied into its response', async () => {
    const leaked = 'Database Transaction Failed: Failed query: insert into "users" ("id") values ($1)\nparams: secret-hash';
    const { request, log } = harness(app => app.post('/db', (_req, res) => { res.status(500).json({ error: leaked }); }));
    const res = await request.post('/db');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'DATABASE_ERROR', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/insert into|secret-hash|params/);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ detail: leaked }), expect.any(String));
  });
});
