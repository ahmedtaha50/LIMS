/**
 * Global search without the trigram indexes (a PostgreSQL built without contrib/pg_trgm, or an operator who dropped them):
 * the answers are the same, only slower, and GET /search says indexed: false so the operator can find out why.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  for (const index of ['samples', 'product_batches', 'products', 'specifications', 'methods', 'documents']) {
    await t.db.pool.query(`DROP INDEX IF EXISTS ${index}_search_trgm_idx`);
  }
  await t.db.pool.query(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ('SMP-6-1', 'Ibuprofen', 'B', 'Testing', 'usr-admin'), ('SMP-6-2', 'أسبرين', 'B', 'Testing', 'usr-admin')`);
});

describe('GET /search without trigram indexes', () => {
  it('still finds Latin and Arabic text and reports indexed: false', async () => {
    const h = await t.auth('admin@gxp.com');
    const latin = await t.request.get('/api/search').query({ q: 'IBU' }).set(h);
    expect(latin.status).toBe(200);
    expect(latin.body.indexed).toBe(false);
    expect(latin.body.groups[0].hits.map((x: any) => x.id)).toEqual(['SMP-6-1']);
    const arabic = await t.request.get('/api/search').query({ q: 'أَسبِرين' }).set(h);
    expect(arabic.body.groups[0].hits.map((x: any) => x.id)).toEqual(['SMP-6-2']);
  });
});
