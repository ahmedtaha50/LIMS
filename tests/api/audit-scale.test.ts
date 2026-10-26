/**
 * Roadmap M08 acceptance: "With 1M rows, signature verification responds in under 300 ms with under 50 MB allocated."
 *
 * Building a million-row chain takes a few minutes, so this file is off by default:
 *     AUDIT_SCALE_ROWS=1000000 npx vitest run tests/api/audit-scale.test.ts
 * (AUDIT_SCALE_ROWS=100000 is enough to see the shape.) The chain is generated inside PostgreSQL with the same formulas the
 * application uses, then checkpointed the way a full verification does. What is measured is verifyAuditChainTo(): the
 * function a signature check calls to prove that the audit entry it points at is part of an intact chain.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

const ROWS = Number(process.env.AUDIT_SCALE_ROWS || 0);

let t: TestDb;
let db: any;
let mod: typeof import('../../src/server/audit/chain');

async function generate(pool: TestDb['pool'], n: number) {
  const c = await pool.connect();
  try {
    await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    await c.query('DELETE FROM audit_trail');
    await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
    await c.query(`
      CREATE OR REPLACE FUNCTION pg_temp.gen(n int) RETURNS void AS $$
      DECLARE i int; prev_hash text := repeat('0', 64); prev_seal text := repeat('0', 64); ts text; lc text; h text; sc text; s text;
      BEGIN
        FOR i IN 1..n LOOP
          ts := to_char(timestamp '2026-01-01 00:00:00' + make_interval(secs => i), 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z';
          lc := format('{"sequence":%s,"timestamp":"%s","userId":"usr-qa","action":"Update","entity":"Sample","entityId":"S-%s","field":"state","oldValue":"a","newValue":"b","reason":"r"}', i, ts, i % 1000);
          h := encode(sha256(convert_to(lc || prev_hash, 'UTF8')), 'hex');
          sc := format('{"v":2,"sequence":%s,"timestamp":"%s","userId":"usr-qa","actorName":"Test QA Officer","actorRole":"QA","sessionId":null,"appVersion":"0.1.0","action":"Update","entity":"Sample","entityId":"S-%s","field":"state","oldValue":"a","newValue":"b","reason":"r","hash":"%s"}', i, ts, i % 1000, h);
          s := encode(sha256(convert_to(sc || prev_seal, 'UTF8')), 'hex');
          INSERT INTO audit_trail (id, sequence, timestamp, timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash,
                                   actor_name, actor_role, session_id, app_version, hash_version, hash_alg, seal)
          VALUES ('adt-scale-' || i, i, ts::timestamptz, ts, 'usr-qa', 'Update', 'Sample', 'S-' || (i % 1000), 'state', 'a', 'b', 'r', h, prev_hash,
                  'Test QA Officer', 'QA', NULL, '0.1.0', 2, 'sha256', s);
          prev_hash := h; prev_seal := s;
        END LOOP;
      END $$ LANGUAGE plpgsql`);
    await c.query('SELECT pg_temp.gen($1)', [n]);
    await c.query('ANALYZE audit_trail');
  } finally { c.release(); }
}

describe.skipIf(!ROWS)(`signature verification against ${ROWS.toLocaleString()} audit rows`, () => {
  beforeAll(async () => {
    t = await useTestDb();
    ({ db } = await import('../../src/db/index'));
    mod = await import('../../src/server/audit/chain');
    await generate(t.pool, ROWS);
  }, 30 * 60_000);

  it('the generated chain is the real chain: a full verification passes, builds the checkpoints, and takes a while', async () => {
    const started = Date.now();
    const r = await mod.verifyAuditChain(db);
    const seconds = (Date.now() - started) / 1000;
    console.log(`full verification of ${r.totalRecords} rows: ${seconds.toFixed(1)} s, ${r.checkpointsAdded} checkpoints added`);
    expect(r).toMatchObject({ isValid: true, totalRecords: ROWS, headSequence: ROWS });
    expect(r.checkpointsAdded).toBe(Math.floor(ROWS / mod.CHECKPOINT_INTERVAL));
  }, 30 * 60_000);

  it('verifies the chain up to a recent signature entry in under 300 ms using under 50 MB', async () => {
    const id = `adt-scale-${ROWS - 100}`;
    await mod.verifyAuditChainTo(db, { id }); // warm the pool and the plan cache
    (globalThis as any).gc?.();
    const timings: number[] = [];
    let peak = 0;
    const base = process.memoryUsage().heapUsed + process.memoryUsage().external;
    const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.external - base); }, 1);
    try {
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        const r = await mod.verifyAuditChainTo(db, { id });
        timings.push(performance.now() - started);
        expect(r).toMatchObject({ isValid: true, startedFrom: 'checkpoint', verifiedThrough: ROWS - 100 });
        expect(r.rowsChecked).toBeLessThanOrEqual(mod.CHECKPOINT_INTERVAL);
      }
    } finally { clearInterval(sampler); }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    console.log(`bounded verification: median ${median.toFixed(0)} ms (min ${timings[0].toFixed(0)}, max ${timings[timings.length - 1].toFixed(0)}), peak allocation ${(peak / 1048576).toFixed(1)} MB`);
    expect(median).toBeLessThan(300);
    expect(peak).toBeLessThan(50 * 1048576);
  }, 120_000);
});
