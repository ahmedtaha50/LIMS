/** Arrange helper for tests that need a study to start: a product, a batch, a specification, an Effective test plan and an Approved protocol. */
import type { TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

export async function startableStudy(t: TestApp) {
  const h = async (e: string) => ({ Authorization: `Bearer ${await t.token(e)}` });
  const [qa, reviewer] = [await h('qa@gxp.com'), await h('reviewer@gxp.com')];
  const name = uniq('Fixture product');
  const p = await t.request.post('/api/products').set(qa).send({ code: uniq('FX'), name });
  const b = await t.request.post('/api/batches').set(qa).send({ productId: p.body.id, batchNo: uniq('B') });
  await insertActiveSpec(t, name);
  const plan = uniq('TP');
  await t.db.pool.query(`INSERT INTO test_plans (id, code, name, material, purpose, parameters, revision, status) VALUES ($1, $2, 'Stability', $3, 'Stability', '["Assay (%)"]'::jsonb, 1, 'Effective')`, [uniq('TPL'), plan, name]);
  const draft = await t.request.post('/api/stability/protocols').set(reviewer).send({ code: uniq('SP'), title: 'Long term', productId: p.body.id, testPlanCode: plan, conditionIds: ['STC-LT-25-60'], monthPoints: [3, 6], windowDays: 7 });
  const signed = await t.request.post(`/api/stability/protocols/${draft.body.id}/approve`).set(qa).send({ password: 'password', expectedVersion: 1 });
  if (signed.status !== 200) throw new Error(`protocol approval failed: ${signed.status} ${JSON.stringify(signed.body)}`);
  const d = new Date(Date.now() + 86_400_000);
  const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { protocolId: draft.body.id as string, batchId: b.body.id as string, startDate, product: name, batchNo: b.body.batchNo as string };
}
