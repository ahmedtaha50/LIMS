/**
 * Scale seed for the performance gate (roadmap M43): N samples, 4 results per sample, A audit rows, generated inside PostgreSQL
 * (set-based, so 100,000 samples take seconds). The data is deterministic: material i comes from a fixed list of 40 names, so about
 * 1 sample in 40 is 'Ibuprofen ...' and a search for 'ibu' has a known, realistic hit rate. The audit rows are NOT a valid hash chain
 * (they exist to give the audit table its weight; tests/api/audit-scale.test.ts builds the real chain).
 */
import type pg from 'pg';

export const SCALE_MATERIALS = [
  'Ibuprofen 400 mg tablets', 'Paracetamol 500 mg tablets', 'Amoxicillin 250 mg capsules', 'Metformin 850 mg tablets', 'Atorvastatin 20 mg tablets',
  'Omeprazole 20 mg capsules', 'Cetirizine 10 mg tablets', 'Losartan 50 mg tablets', 'Amlodipine 5 mg tablets', 'Azithromycin 500 mg tablets',
  'Salbutamol inhaler', 'Diclofenac gel 1%', 'Ciprofloxacin 500 mg tablets', 'Lisinopril 10 mg tablets', 'Simvastatin 40 mg tablets',
  'Ranitidine syrup', 'Hydrochlorothiazide 25 mg', 'Clarithromycin 250 mg', 'Prednisolone 5 mg tablets', 'Insulin glargine solution',
  'Sodium chloride 0.9% infusion', 'Glucose 5% infusion', 'Ceftriaxone 1 g vial', 'Pantoprazole 40 mg tablets', 'Levothyroxine 100 mcg',
  'Warfarin 5 mg tablets', 'Furosemide 40 mg tablets', 'Bisoprolol 5 mg tablets', 'Clopidogrel 75 mg tablets', 'Montelukast 10 mg tablets',
  'Gabapentin 300 mg capsules', 'Sertraline 50 mg tablets', 'Tramadol 50 mg capsules', 'Doxycycline 100 mg capsules', 'Fluconazole 150 mg capsule',
  'Loratadine 10 mg tablets', 'Metronidazole 500 mg tablets', 'Naproxen 500 mg tablets', 'Ketoconazole cream 2%', 'Zinc sulfate dispersible',
];

export interface ScaleSeed { samples: number; resultsPerSample?: number; audit?: number }

export async function seedScale(pool: pg.Pool, { samples, resultsPerSample = 4, audit = 0 }: ScaleSeed): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`CREATE OR REPLACE FUNCTION pg_temp.material(i int) RETURNS text AS $$ SELECT (ARRAY[${SCALE_MATERIALS.map(m => `'${m}'`).join(',')}])[1 + i % ${SCALE_MATERIALS.length}] $$ LANGUAGE sql IMMUTABLE`);
    await c.query(`
      INSERT INTO samples (id, material, batch, state, created_by, created_at)
      SELECT 'SMP-2026-' || lpad(g::text, 6, '0'), pg_temp.material(g), 'LOT-' || lpad((g / 25)::text, 5, '0'),
             (ARRAY['Registered','Testing','Pending Review','Approved','Approved','Approved'])[1 + g % 6],
             'usr-analyst1', now() - make_interval(secs => ($1::int - g) * 40)
      FROM generate_series(1, $1::int) g`, [samples]);
    if (resultsPerSample > 0) {
      await c.query(`
        INSERT INTO results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at)
        SELECT 'RES-' || s.n || '-' || p, 'SMP-2026-' || lpad(s.n::text, 6, '0'), 'Parameter ' || p, (90 + (s.n * 7 + p) % 20)::text, 90, 110, false, 'usr-analyst1', now()
        FROM generate_series(1, $1::int) s(n) CROSS JOIN generate_series(1, $2::int) p`, [samples, resultsPerSample]);
    }
    if (audit > 0) {
      await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
      await c.query(`
        INSERT INTO audit_trail (id, sequence, timestamp, timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash,
                                 actor_name, actor_role, session_id, app_version, hash_version, hash_alg, seal)
        SELECT 'adt-perf-' || g, 1000000 + g, now() - make_interval(secs => ($1::int - g)), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z', 'usr-qa', 'Update', 'Sample',
               'SMP-2026-' || lpad((1 + g % $2::int)::text, 6, '0'), 'state', 'a', 'b', 'r', md5(g::text) || md5((g + 1)::text), md5((g - 1)::text) || md5(g::text),
               'Test QA Officer', 'QA', NULL, '0.1.0', 2, 'sha256', md5(g::text) || md5((g + 2)::text)
        FROM generate_series(1, $1::int) g`, [audit, samples]);
      await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
    }
    await c.query('ANALYZE samples'); await c.query('ANALYZE results'); await c.query('ANALYZE audit_trail');
  } finally { c.release(); }
}
