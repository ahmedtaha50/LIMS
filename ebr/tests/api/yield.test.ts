import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../server/core/db.js';
import { passwordCheck } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { reconcile } from '../../server/materials/service.js';
import { yieldLimitsFor } from '../../server/materials/yield.js';
import { Design } from '../../server/mbr/design.js';
import { migrate } from '../../server/migrate/runner.js';
import { change } from '../../server/settings/index.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// E29: yield limits per product. The batch uses the limits of the MBR version it was made from, else the site settings.
const PW = 'yield limits test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, sup = '', adm = '';
const design = (yieldLimits?: { minPct: number; maxPct: number }) => ({ batchSize: { value: 100, unit: 'kg' }, ...(yieldLimits ? { yieldLimits } : {}),
  phases: [{ key: 'blend', label: 'Blend', steps: [{ key: 'note', label: 'Blend 10 minutes', type: 'instruction', text: 'Blend' }] }] });
const ctx = (c: Parameters<Parameters<typeof withTx>[1]>[0], id: string, username: string) =>
  ({ c, pool: db.pool, check: passwordCheck(db.pool), actor: { userId: id, username, permissions: new Set<string>() }, requestId: 'yield-test' });

async function recipe(code: string, d: unknown, versionNo = 1, master?: string) {
  const m = master ?? (await db.pool.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $1) RETURNING id', [code])).rows[0]!.id;
  if (versionNo > 1) await db.pool.query("UPDATE mbr_versions SET status = 'retired' WHERE master_id = $1 AND status = 'effective'", [m]);
  const v = (await db.pool.query<{ id: string }>("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, $2, 'effective', $3, 'x', 'x') RETURNING id", [m, versionNo, JSON.stringify(d)])).rows[0]!.id;
  return { m, v };
}
async function batch(number: string, r: { m: string; v: string }) {
  return (await db.pool.query<{ id: string }>("INSERT INTO batches (batch_number, mbr_master_id, mbr_version_id, product_name, batch_size, status, created_by) VALUES ($1, $2, $3, 'p', $4, 'in_progress', 'sup-y') RETURNING id",
    [number, r.m, r.v, JSON.stringify({ value: 100, unit: 'kg' })])).rows[0]!.id;
}
const close = (batchId: string, output: number) => withTx(db.pool, (c) => reconcile(ctx(c, sup, 'sup-y'), batchId, { outputQuantity: output, password: PW }));

beforeAll(async () => {
  db = await freshDatabase('yield'); await migrate(db.pool, MIGRATIONS);
  const h = await hashPassword(PW);
  sup = (await db.pool.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('sup-y', 'sup-y', $1, '{supervisor}', false) RETURNING id", [h])).rows[0]!.id;
  adm = (await db.pool.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('adm-y', 'adm-y', $1, '{admin}', false) RETURNING id", [h])).rows[0]!.id;
});
afterAll(async () => { await db.drop(); });

describe('yield limits per product (E29)', () => {
  it('E29#1: a recipe may set its own limits, checked when it is saved', () => {
    expect(Design.safeParse(design({ minPct: 90, maxPct: 98 })).success).toBe(true);
    expect(Design.safeParse(design()).success).toBe(true);                                            // optional
    expect(Design.safeParse(design({ minPct: 99, maxPct: 160 })).success).toBe(false);                // above 150 %
    expect(Design.safeParse(design({ minPct: 100, maxPct: 100 })).success).toBe(false);               // min not below max
    expect(Design.safeParse(design({ minPct: 40, maxPct: 101 })).success).toBe(false);                // out of bounds
  });

  it('E29#2: a batch uses the limits of its own recipe version, and the exception names them', async () => {
    const r = await recipe('PROD-A', design({ minPct: 90, maxPct: 98 }));
    const b = await batch('B-Y-1', r);
    expect(await yieldLimitsFor(db.pool, b)).toEqual({ min: 90, max: 98, source: 'recipe PROD-A version 1' });
    const out = await close(b, 99);                                                                   // 99 % is fine for the site, not for this product
    expect(out.exceptions.map(e => e.message)).toEqual(['Yield 99% (99 of 100 kg) is outside 90% to 98% (recipe PROD-A version 1)']);
    // a later version with other limits does not change the batch already made from version 1
    await recipe('PROD-A', design({ minPct: 80, maxPct: 120 }), 2, r.m);
    expect(await yieldLimitsFor(db.pool, b)).toMatchObject({ min: 90, max: 98, source: 'recipe PROD-A version 1' });
  });

  it('E29#1: without its own limits a batch uses the site limits (default 95 to 102 percent), as the site sets them', async () => {
    const r = await recipe('PROD-B', design());
    const b1 = await batch('B-Y-2', r);
    expect(await yieldLimitsFor(db.pool, b1)).toEqual({ min: 95, max: 102, source: 'site limits' });
    expect((await close(b1, 99)).exceptions).toEqual([]);
    await withTx(db.pool, (c) => change(ctx(c, adm, 'adm-y'), 'yield.minPct', { value: 99.5, rowVersion: 0, reason: 'tighter site limit, QA decision 2026-11', password: PW }));
    const b2 = await batch('B-Y-3', r);
    expect((await close(b2, 99)).exceptions.map(e => e.message)).toEqual(['Yield 99% (99 of 100 kg) is outside 99.5% to 102% (site limits)']);
  });
});
