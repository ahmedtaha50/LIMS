/**
 * Roadmap M30 acceptance 3: the traceback of a lot returns in under 1 s on 100,000 results. Opt-in (it inserts the rows):
 *     REAGENT_SCALE_ROWS=100000 npx vitest run tests/api/reagents-scale.test.ts
 * 100,000 results are generated inside PostgreSQL, each linked to a lot (a tenth of them to the lot asked for, the rest to others).
 * Needs the gate patch (the traceback route).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

const ROWS = Number(process.env.REAGENT_SCALE_ROWS || 0);
let t: TestApp;
beforeAll(async () => { if (ROWS) t = await startTestApp(); });

describe.skipIf(!ROWS)('lot traceback at scale', () => {
  it(`returns the results of a lot in under 1 s with ${ROWS} results linked`, async () => {
    const q = (text: string, p: unknown[] = []) => t.db.pool.query(text, p);
    await q(`INSERT INTO samples (id, material, batch, state, created_by) SELECT 'S-SC-' || g, 'Scale', 'B', 'Testing', 'usr-admin' FROM generate_series(1, 1000) g`);
    await q(`INSERT INTO reagent_items (id, code, name, category, unit, created_by) VALUES ('RI-SC', 'SC', 'Scale item', 'Reagent', 'mL', 'usr-admin')`);
    await q(`INSERT INTO reagent_lots (id, item_id, lot_number, supplier, received_quantity, unit, expiry_date, status, received_by)
             SELECT 'RL-SC-' || g, 'RI-SC', 'L' || g, 'S', 1, 'mL', '2099-01-01', 'InUse', 'usr-admin' FROM generate_series(1, 10) g`);
    await q(`INSERT INTO results (id, sample_id, parameter) SELECT 'R-SC-' || g, 'S-SC-' || (1 + g % 1000), 'P' || g FROM generate_series(1, ${ROWS}) g`);
    await q(`INSERT INTO result_materials (id, result_id, sample_id, lot_id, result_version, linked_by)
             SELECT 'RM-SC-' || g, 'R-SC-' || g, 'S-SC-' || (1 + g % 1000), 'RL-SC-' || (1 + g % 10), 1, 'usr-admin' FROM generate_series(1, ${ROWS}) g`);
    await q('ANALYZE result_materials');
    const h = await t.auth('qa@gxp.com');
    const started = Date.now();
    const res = await t.request.get('/api/reagent-lots/RL-SC-1/traceback').set(h);
    const ms = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(Math.min(5000, ROWS / 10));
    expect(res.body.truncated).toBe(ROWS / 10 > 5000);
    console.log(`traceback of RL-SC-1: ${ms} ms, ${res.body.results.length} of ${ROWS / 10} results`);
    expect(ms).toBeLessThan(1000);
  }, 300_000);
});
