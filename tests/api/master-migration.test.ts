/**
 * Roadmap M17 (r2-master-data), migration 0100_master_data: products, product_batches, customers and the sample_context sidecar.
 *
 *   * an installation made by v0.1.0 (the real fixture): every sample is mapped to a product and a batch (zero orphans), no sample,
 *     result or signature row changes, and every signature verifies exactly as it did before the migration;
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * the database itself refuses a duplicate batch within a product and accepts the same batch number under two products;
 *   * src/db/schema/master.ts and the migration agree (the drift check of tests/upgrade/schema-drift.test.ts, with this file's tables).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import * as master from '../../src/db/schema/master';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['products', 'product_batches', 'customers', 'sample_context'];
const backup = async () => ({ file: 'master-test.bak', sha256: 'a'.repeat(64), verified: true });
const lastBefore = () => loadMigrations(DIR).map(f => f.id).filter(id => id < '0100').pop()!;

describe('the migration file', () => {
  it('is 0100_master_data, in the range reserved for master data', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0100_master_data');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing: no meaning, no permission, no master row', async () => {
    const s = await scratchDb('md-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'MASTER_DATA_STATUS'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code like 'master.%'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the MASTER_DATA_STATUS meaning and the master permissions, and the database enforces the batch key', async () => {
    const s = await scratchDb('md-new');
    await migrate(s.pool, { dir: DIR });
    expect((await s.pool.query(`select allowed_roles, requires_reason, training_exempt, active from signature_meanings where code = 'MASTER_DATA_STATUS'`)).rows)
      .toEqual([{ allowed_roles: ['QA', 'Admin'], requires_reason: true, training_exempt: false, active: true }]);
    const grants = (await s.pool.query(`select role_id, permission_code from role_permissions where permission_code like 'master.%' order by 1, 2`)).rows;
    expect(grants.map(g => `${g.role_id}:${g.permission_code}`)).toEqual([
      'role-admin:master.manage', 'role-admin:master.status', 'role-admin:master.view',
      'role-analyst:master.view',
      'role-qa:master.manage', 'role-qa:master.status', 'role-qa:master.view',
      'role-reviewer:master.view',
    ]);

    await s.pool.query(`INSERT INTO products (id, code, name) VALUES ('P1', 'C1', 'Product one'), ('P2', 'C2', 'Product two')`);
    await s.pool.query(`INSERT INTO product_batches (id, product_id, batch_no) VALUES ('B1', 'P1', 'LOT-1'), ('B2', 'P2', 'LOT-1')`);
    await expect(s.pool.query(`INSERT INTO product_batches (id, product_id, batch_no) VALUES ('B3', 'P1', 'LOT-1')`)).rejects.toThrow(/product_batches_product_batch_uidx/);
    await expect(s.pool.query(`INSERT INTO products (id, code, name) VALUES ('P3', 'C3', 'PRODUCT ONE')`)).rejects.toThrow(/products_name_lower_uidx/);
    await expect(s.pool.query(`INSERT INTO product_batches (id, product_id, batch_no, status) VALUES ('B4', 'P1', 'LOT-4', 'Maybe')`)).rejects.toThrow(/product_batches_status_check/);
  });

  it('src/db/schema/master.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('md-drift');
    await migrate(s.pool, { dir: DIR });
    const declared = { ...schema, ...master };
    const statements = (await pushSchema(declared, drizzle(s.pool) as any, ['public'], ['!schema_migrations'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('maps every sample to a product and a batch, changes no existing row, and every signature verifies as before', async () => {
    const s = await scratchDb('md-v010');
    await loadV010(s);
    await migrate(s.pool, { dir: DIR, upTo: lastBefore(), backup });

    const db = drizzle(s.pool, { schema }) as any;
    const { verifySignature } = await import('../../src/server/esign');
    const sigIds = (await s.pool.query('select id from signatures order by id')).rows.map(r => r.id as string);
    expect(sigIds.length).toBeGreaterThan(0);
    const verdicts = async () => Object.fromEntries(await Promise.all(sigIds.map(async id => {
      const v = await verifySignature(db, id);
      return [id, { status: v?.status, valid: v?.valid, contentHashMatches: v?.contentHashMatches }];
    })));
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from specifications t) as specs`)).rows[0]);
    const verdictsBefore = await verdicts();
    const rowsBefore = await frozen();

    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0100_master_data');

    // Zero orphans: every sample has its context, and the context agrees with the text columns.
    const orphans = await s.pool.query(`select id from samples s where not exists (select 1 from sample_context c where c.sample_id = s.id)`);
    expect(orphans.rows).toEqual([]);
    const mismatched = await s.pool.query(`
      select s.id from samples s join sample_context c on c.sample_id = s.id
        join products p on p.id = c.product_id join product_batches b on b.id = c.batch_id
       where b.product_id <> p.id or b.batch_no <> s.batch
          or lower(btrim(regexp_replace(p.name, '\\s+', ' ', 'g'))) <> lower(btrim(regexp_replace(s.material, '\\s+', ' ', 'g')))`);
    expect(mismatched.rows).toEqual([]);

    const products = (await s.pool.query(`select name, code, status, origin, created_by from products order by name`)).rows;
    expect(products).toEqual([
      { name: 'Amoxicillin 250mg/5mL Oral Suspension', code: 'Amoxicillin 250mg/5mL Oral Suspension', status: 'Active', origin: 'migration', created_by: null },
      { name: 'Ciprofloxacin 500mg Film-Coated Tablets', code: 'Ciprofloxacin 500mg Film-Coated Tablets', status: 'Active', origin: 'migration', created_by: null },
      { name: 'Paracetamol 500mg Finished Tablets', code: 'Paracetamol 500mg Finished Tablets', status: 'Active', origin: 'migration', created_by: null },
    ]);
    const batches = (await s.pool.query(`select b.batch_no, b.status, b.origin, b.manufactured_on, b.expires_on from product_batches b order by b.batch_no collate "C"`)).rows;
    expect(batches).toEqual([
      { batch_no: 'B-FIX-1', status: 'Released', origin: 'migration', manufactured_on: null, expires_on: null },
      { batch_no: 'B-FIX-2', status: 'Quarantine', origin: 'migration', manufactured_on: null, expires_on: null },
      { batch_no: 'BATCH-2026-001', status: 'Quarantine', origin: 'migration', manufactured_on: null, expires_on: null },
      { batch_no: 'BATCH-2026-002', status: 'Released', origin: 'migration', manufactured_on: null, expires_on: null },
      { batch_no: 'BATCH-2026-003', status: 'Quarantine', origin: 'migration', manufactured_on: null, expires_on: null },
    ]);
    expect((await s.pool.query(`select count(*)::int as n from sample_context where origin = 'migration' and customer_id is null`)).rows[0].n)
      .toBe((await s.pool.query('select count(*)::int as n from samples')).rows[0].n);

    // The frozen core is untouched and the old signatures verify exactly as they did.
    expect(await frozen()).toBe(rowsBefore);
    expect(await verdicts()).toEqual(verdictsBefore);
    expect(Object.values(verdictsBefore).filter((v: any) => v.status === 'valid').length).toBeGreaterThan(0);

    // The sidecar is append-only from the start.
    await expect(s.pool.query(`UPDATE sample_context SET customer_id = NULL`)).rejects.toThrow(/not permitted/);
  });
});
