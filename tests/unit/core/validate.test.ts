import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, requestContext } from '../../../src/server/http/errors';
import { requireStringCredentials, validate } from '../../../src/server/http/validate';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const build = (setup: (app: express.Express) => void) => {
  const app = express();
  app.use(requestContext(silent), express.json());
  setup(app);
  app.use(errorHandler(silent));
  return supertest(app);
};

describe('validate(schema)', () => {
  const schema = z.object({ name: z.string().min(1, 'name is required'), count: z.number().int() }).strict();

  it('hands the parsed body to the handler', async () => {
    const request = build(app => app.post('/x', validate(schema), (req, res) => { res.json(req.body); }));
    const res = await request.post('/x').send({ name: 'a', count: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'a', count: 2 });
  });

  it('rejects an unknown (server-controlled) field with 400, joining the messages as legacy clients expect', async () => {
    const request = build(app => app.post('/x', validate(schema), (_req, res) => { res.json({ reached: true }); }));
    const res = await request.post('/x').send({ name: 'a', count: 2, status: 'Approved' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.error).toMatch(/status/);
    expect(res.body.details[0]).toMatchObject({ path: '', message: expect.stringMatching(/status/) });
    expect(res.body.reached).toBeUndefined();
  });

  it('reports every failing field, with its path', async () => {
    const request = build(app => app.post('/x', validate(schema), (_req, res) => { res.json({}); }));
    const res = await request.post('/x').send({ name: '', count: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: any) => d.path).sort()).toEqual(['count', 'name']);
    expect(res.body.error).toContain('name is required');
  });

  it('can validate the query string', async () => {
    const request = build(app => app.get('/q', validate(z.object({ page: z.coerce.number().int().min(1) }).strict(), 'query'), (req, res) => { res.json(req.query); }));
    expect((await request.get('/q?page=2')).body).toEqual({ page: 2 });
    expect((await request.get('/q?page=0')).status).toBe(400);
  });

  it('treats a missing body as an empty object', async () => {
    const request = build(app => app.post('/x', validate(z.object({}).strict()), (_req, res) => { res.json({ ok: true }); }));
    expect((await request.post('/x')).status).toBe(200);
  });
});

describe('requireStringCredentials', () => {
  const request = () => build(app => { app.use(requireStringCredentials); app.post('/x', (req, res) => { res.json({ reached: true }); }); });

  it.each(['password', 'newPassword', 'currentPassword', 'passphrase', 'tempToken'])('%s must be a string', async (field) => {
    for (const bad of [123, true, null, ['a'], { $ne: '' }]) {
      const res = await request().post('/x').send({ [field]: bad });
      expect(res.status, `${field}=${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.error).toContain(field);
    }
  });

  it('lets strings, empty strings and absent fields through', async () => {
    expect((await request().post('/x').send({ password: 'x' })).status).toBe(200);
    expect((await request().post('/x').send({ password: '' })).status).toBe(200);
    expect((await request().post('/x').send({ other: 1 })).status).toBe(200);
    expect((await request().post('/x')).status).toBe(200);
    expect((await request().post('/x').send([1, 2])).status).toBe(200);
  });
});
