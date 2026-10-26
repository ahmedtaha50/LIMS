/**
 * Roadmap M09 (r1-authz) acceptance: "the route-contract test fails when a route is added without a permission".
 *
 * src/server/authz/routeTable.ts binds every route of the API to a permission code (or declares it public or self-service).
 * This file checks the table against the routes the application really registers, in both directions, and checks the
 * mechanism that stops the server from starting when they disagree.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { extractRouteTable } from '../helpers/routeTable';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });

const strip = (p: string) => p.replace(/^\/api/, '');
const keyOf = (r: { method: string; path: string }) => `${r.method} ${strip(r.path)}`;

describe('the route table covers the API', () => {
  it('every route the application registers has a rule', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const missing = extractRouteTable(t.app).map(keyOf).filter(k => !(k in ROUTE_RULES));
    expect(missing, `add these to src/server/authz/routeTable.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('no rule names a route that does not exist', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const live = new Set(extractRouteTable(t.app).map(keyOf));
    expect(Object.keys(ROUTE_RULES).filter(k => !live.has(k))).toEqual([]);
  });

  it('a rule agrees with the route about authentication: public routes have none, every other route runs requireAuth', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const wrong = extractRouteTable(t.app).filter(r => (ROUTE_RULES[keyOf(r)]?.kind === 'public') === r.auth).map(keyOf);
    expect(wrong).toEqual([]);
  });

  it('every mutating route lists the keys it accepts (a rule without a body would let unknown keys through)', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const noBody = Object.entries(ROUTE_RULES).filter(([k, r]) => /^(POST|PUT|PATCH|DELETE) /.test(k) && r.body === undefined).map(([k]) => k);
    expect(noBody).toEqual([]);
  });

  it('every permission a rule uses exists in the catalog, and every catalog permission is used by at least one rule', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const { PERMISSION_CODES } = await import('../../src/lib/permissions');
    const used = new Set(Object.values(ROUTE_RULES).flatMap(r => (r.kind === 'perm' ? [r.permission] : [])));
    expect([...used].filter(c => !(PERMISSION_CODES as readonly string[]).includes(c))).toEqual([]);
    expect(PERMISSION_CODES.filter(c => !used.has(c))).toEqual([]);
  });

  it('every path resolves to its own rule: no rule shadows another', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const { matchRule } = await import('../../src/server/authz/match');
    for (const key of Object.keys(ROUTE_RULES)) {
      const [method, route] = key.split(' ');
      const concrete = route.replace(/:[A-Za-z]+/g, 'abc-123');
      expect(matchRule(method, concrete)?.key, `${method} ${concrete}`).toBe(key);
      expect(matchRule(method, concrete + '/')?.key, `${method} ${concrete}/ (Express ignores a trailing slash)`).toBe(key);
      expect(matchRule(method, concrete.toUpperCase().replace('ABC-123', 'abc-123'))?.key, `${method} ${concrete} in capitals (Express ignores case)`).toBe(key);
    }
    expect(matchRule('GET', '/samples/abc/extra/segments')).toBeNull();
    expect(matchRule('TRACE', '/samples')).toBeNull();
  });
});

describe('the contract stops a route without a permission', () => {
  it('reads authentication from handler names only where they survive: the minified server bundle renames requireAuth', async () => {
    const { canCheckAuthentication } = await import('../../src/server/authz/contract');
    const route = (authenticated: boolean) => ({ method: 'GET', path: '/api/x', authenticated });
    expect(canCheckAuthentication([route(false), route(true)])).toBe(true);
    expect(canCheckAuthentication([route(false), route(false)])).toBe(false); // a bundle: no handler is called requireAuth any more
    expect(canCheckAuthentication([])).toBe(false);
  });

  it('findContractViolations names a route that was added without a rule, and a rule whose route is gone', async () => {
    const { findContractViolations } = await import('../../src/server/authz/contract');
    const { createApp } = await import('../../src/server/app');
    const { db } = await import('../../src/db/index');
    const app = createApp({ db, rateLimit: false });
    expect(findContractViolations(app)).toEqual([]);

    const extra = express.Router();
    extra.get('/zz-new-report', (_req, res) => res.json({ ok: true }));
    extra.post('/zz-new-write', (_req, res) => res.json({ ok: true }));
    app.use('/api', extra);
    const violations = findContractViolations(app);
    expect(violations.map(v => v.route).sort()).toEqual(['GET /zz-new-report', 'POST /zz-new-write']);
    expect(violations.every(v => v.problem === 'no-rule')).toBe(true);
    expect(violations[0].fix).toContain('src/server/authz/routeTable.ts');
  });

  it('assertRouteContract throws with every violation listed, and the live application passes it', async () => {
    const { assertRouteContract } = await import('../../src/server/authz/contract');
    expect(() => assertRouteContract(t.app)).not.toThrow();

    const bare = express();
    bare.use('/api', (() => { const r = express.Router(); r.post('/orphan', (_q, s) => s.json({})); return r; })());
    expect(() => assertRouteContract(bare)).toThrowError(/POST \/orphan/);
  });

  it('a request for a path that has no rule never reaches a handler (deny by default at run time)', async () => {
    const { authorize } = await import('../../src/server/authz');
    const { db } = await import('../../src/db/index');
    const supertest = (await import('supertest')).default;
    let reached = false;
    const app = express();
    app.use(express.json());
    app.use('/api', authorize({ db }));
    app.get('/api/zz-unmapped', (_req, res) => { reached = true; res.json({}); });
    const admin = await t.auth('admin@gxp.com');
    const res = await supertest(app).get('/api/zz-unmapped').set(admin);
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
  });

  it('the live application is wired: createApp mounts the authorisation layer in front of the API', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const res = await t.request.get('/api/permissions/me').set(analyst);
    expect(res.status).toBe(200);
  });
});

describe('the matrix document', () => {
  it('docs/permission-matrix.csv is the current catalog and route table (npx tsx scripts/authz/export-matrix.ts rewrites it)', async () => {
    const { matrixCsvFromCatalog } = await import('../../src/server/authz/csv');
    const committed = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'permission-matrix.csv'), 'utf8');
    expect(committed).toBe(matrixCsvFromCatalog());
  });
});
