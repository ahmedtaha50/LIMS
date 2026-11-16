import type { Response } from 'express';
import { z } from 'zod';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { route, type Actor } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import * as svc from '../materials/service.js';

const password = z.string().min(1).max(200);
const tx = <T>(pool: Pool, actor: Actor | null, res: Response, fn: (x: svc.Ctx) => Promise<T>) =>
  withTx(pool, (c) => fn({ c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }));
const p = (params: Record<string, string>, k: string) => params[k] as string;

export const routes = [
  route({ method: 'GET', path: '/api/materials', permission: 'materials.read', summary: 'Materials and their lots', handler: ({ pool }) => svc.listMaterials(pool) }),
  route({
    method: 'POST', path: '/api/materials', permission: 'materials.manage', summary: 'Add a material', status: 201,
    input: strict({ code: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/), name: z.string().min(1).max(200), unit: z.string().min(1).max(20) }),
    handler: ({ pool, actor, res, input }) => tx(pool, actor, res, (x) => svc.createMaterial(x, input)),
  }),
  route({
    method: 'POST', path: '/api/materials/:code/lots', permission: 'materials.manage', summary: 'Receive a lot (it starts in quarantine)', status: 201,
    input: strict({ lotNumber: z.string().regex(/^[A-Za-z0-9._/-]{2,40}$/), expiry: z.iso.date() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.receiveLot(x, p(params, 'code'), input)),
  }),
  route({
    method: 'POST', path: '/api/material-lots/:id/release', permission: 'materials.release', summary: 'QA releases a lot for use', input: strict({ version, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.decideLot(x, p(params, 'id'), 'released', input)),
  }),
  route({
    method: 'POST', path: '/api/material-lots/:id/reject', permission: 'materials.release', summary: 'QA rejects a lot, with a reason', input: strict({ version, password, reason: z.string().min(3).max(1000) }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.decideLot(x, p(params, 'id'), 'rejected', input)),
  }),
  route({
    method: 'GET', path: '/api/batches/:id/reconciliation', permission: 'batch.read', summary: 'The yield and material reconciliation of a batch (null before it is recorded)',
    handler: async ({ pool, params }) => {
      const r = (await pool.query<{ output_quantity: string; unit: string; theoretical: string; yield_pct: string; materials: unknown; recorded_by: string; recorded_at: Date }>('SELECT * FROM batch_reconciliations WHERE batch_id = $1', [p(params, 'id')])).rows[0];
      return r ? { outputQuantity: Number(r.output_quantity), unit: r.unit, theoretical: Number(r.theoretical), yieldPct: Number(r.yield_pct), materials: r.materials, recordedBy: r.recorded_by, recordedAt: r.recorded_at.toISOString() } : null;
    },
  }),
  route({
    method: 'POST', path: '/api/batches/:id/reconcile', permission: 'batch.complete', summary: 'Record the yield and the material reconciliation of a batch', status: 201,
    input: strict({ outputQuantity: z.number().positive(), password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.reconcile(x, p(params, 'id'), input)),
  }),
];
