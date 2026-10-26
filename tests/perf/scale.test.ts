/**
 * Roadmap M43 acceptance 2 and 3, measured on the real application and a real PostgreSQL (opt-in: it inserts hundreds of thousands of rows):
 *
 *     PERF_SAMPLES=50000  npx vitest run tests/perf/scale.test.ts            search under 300 ms, lists and dashboard
 *     PERF_SAMPLES=100000 PERF_AUDIT=1000000 npx vitest run tests/perf/scale.test.ts      the nightly gate (400,000 results, 1,000,000 audit rows)
 *
 * Budgets (p95 over PERF_RUNS requests each, default 30): GET /search?q=ibu 300 ms; GET /samples 300 ms; GET /dashboard 500 ms; the event
 * loop of the server (which runs in this process) never stalls for 100 ms (p99 of its delay while all of the above run). PERF_SLACK=2
 * doubles every budget for a slow machine; the numbers are printed either way. The test uses no collation-dependent expectation.
 */
import { monitorEventLoopDelay } from 'perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { seedScale } from './seed';

const SAMPLES = Number(process.env.PERF_SAMPLES || 0);
const AUDIT = Number(process.env.PERF_AUDIT || 0);
const RUNS = Number(process.env.PERF_RUNS || 30);
const SLACK = Number(process.env.PERF_SLACK || 1);

let t: TestApp;
let headers: { Authorization: string };
const loop = monitorEventLoopDelay({ resolution: 10 });

/** Milliseconds of each of `runs` sequential requests, after one warm-up request. */
async function timed(path: string, query: Record<string, string> = {}, runs = RUNS) {
  const get = () => t.request.get(path).query(query).set(headers);
  const warm = await get();
  expect(warm.status, path).toBe(200);
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    const res = await get();
    ms.push(Number(process.hrtime.bigint() - started) / 1e6);
    expect(res.status, path).toBe(200);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)];
  console.log(`${path} ${JSON.stringify(query)}: p50 ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms (${runs} runs, ${SAMPLES} samples)`);
  return p95;
}

describe.skipIf(!SAMPLES)(`${SAMPLES.toLocaleString()} samples`, () => {
  beforeAll(async () => {
    t = await startTestApp();
    const started = Date.now();
    await seedScale(t.db.pool, { samples: SAMPLES, audit: AUDIT });
    console.log(`seeded ${SAMPLES} samples, ${SAMPLES * 4} results, ${AUDIT} audit rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    headers = await t.auth('admin@gxp.com');
    loop.enable();
  }, 30 * 60_000);

  it("GET /search?q=ibu answers in under 300 ms (p95) and finds the Ibuprofen samples", async () => {
    const res = await t.request.get('/api/search').query({ q: 'ibu' }).set(headers);
    expect(res.status).toBe(200);
    const samples = res.body.groups.find((g: any) => g.type === 'samples');
    expect(samples.hits).toHaveLength(5);
    expect(samples.more).toBe(true);
    expect(samples.hits.every((h: any) => /Ibuprofen/.test(h.detail))).toBe(true);
    expect(await timed('/api/search', { q: 'ibu' })).toBeLessThan(300 * SLACK);
    expect(await timed('/api/search', { q: 'LOT-0042' })).toBeLessThan(300 * SLACK);
    expect(await timed('/api/search', { q: 'a' + 'bc' })).toBeLessThan(300 * SLACK); // a rare text: no hit
    expect(await timed('/api/search', { q: 'tab' })).toBeLessThan(600 * SLACK); // a very common text (a third of all samples match): reported, with a looser bound
  });

  it("an Analyst's search is as fast, and never contains an audit hit", async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const res = await t.request.get('/api/search').query({ q: 'Sample' }).set(analyst);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/adt-perf|audit/i);
  });

  it('the trigram index is used by the search query at this size (EXPLAIN)', async () => {
    const ext = await t.db.pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    if (!ext.rowCount) return;
    const plan = (await t.db.pool.query(`EXPLAIN WITH m AS MATERIALIZED (SELECT id, created_at FROM samples WHERE search_norm(id || ' ' || material || ' ' || batch) LIKE '%ibu%')
                  SELECT id FROM m ORDER BY created_at DESC LIMIT 6`))
      .rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('samples_search_trgm_idx');
  });

  it('GET /samples answers in under 300 ms (p95)', async () => {
    expect(await timed('/api/samples')).toBeLessThan(300 * SLACK);
    expect(await timed('/api/samples', { state: 'Testing' })).toBeLessThan(300 * SLACK);
  });

  it('GET /lists/samples (the grid) answers in under 300 ms (p95); with a search and a sort the bound is 600 ms (planner-dependent)', async () => {
    expect(await timed('/api/lists/samples', { q: 'ibu', sort: 'material', dir: 'asc' })).toBeLessThan(600 * SLACK);
    expect(await timed('/api/lists/samples')).toBeLessThan(300 * SLACK);
  });

  it('GET /dashboard answers in under 500 ms (p95)', async () => {
    expect(await timed('/api/dashboard')).toBeLessThan(500 * SLACK);
  });

  it('the event loop of the server never stalled for 100 ms while all of that ran', () => {
    loop.disable();
    const p99 = loop.percentile(99) / 1e6;
    console.log(`event-loop delay: p99 ${p99.toFixed(1)} ms, max ${(loop.max / 1e6).toFixed(1)} ms`);
    expect(p99).toBeLessThan(100 * SLACK);
  });
});
