/**
 * Roadmap M35 (r2-audit-tamper), acceptance 1: the application's own database role, lims_app, may add to the audit trail, the
 * signatures and the security events but never change or remove them, and cannot remove the triggers that guard them. Before this
 * track the application connected as the database owner, for whom a trigger is one DROP TRIGGER away.
 *
 * The role is installed by a boot step (src/server/boot/steps/roles.ts -> src/db/roles.ts) run as the owner. Here it runs against
 * this file's own database copy and the test then connects AS lims_app.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionConfig } from '../helpers/db';
import { useTestDb, type TestDb } from '../helpers/testDb';

const PASSWORD = 'lims-app-test-password-123';
let t: TestDb;
let app: pg.Pool;

beforeAll(async () => {
  t = await useTestDb();
  const { appRoleStep } = await import('../../src/server/boot/steps/roles');
  const report = await appRoleStep(t.pool, { env: { LIMS_APP_DB_PASSWORD: PASSWORD }, log: () => {} });
  expect(report).toMatchObject({ role: 'lims_app', login: true });
  app = new pg.Pool({ ...connectionConfig(t.name), user: 'lims_app', password: PASSWORD, max: 2 });
});
afterAll(async () => { await app?.end(); });

const code = async (text: string, params: unknown[] = []) => {
  try { await app.query(text, params); return 'ok'; } catch (err: any) { return err.code as string; }
};

describe('lims_app on the append-only tables', () => {
  it('may read and append to the audit trail', async () => {
    expect(await code('select count(*) from audit_trail')).toBe('ok');
    expect(await code(`insert into audit_trail (id, sequence, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash, timestamp_str)
      values ('adt-role-test', 999999, 'usr-qa', 'Create', 'X', 'x', 'f', '', '', 'r', 'h', 'p', '2026-01-01T00:00:00.000Z')`)).toBe('ok');
  });

  for (const table of ['audit_trail', 'signatures', 'security_events']) {
    it(`update, delete and truncate on ${table} are permission denied (42501)`, async () => {
      expect(await code(`update ${table} set id = id`)).toBe('42501');
      expect(await code(`delete from ${table}`)).toBe('42501');
      expect(await code(`truncate ${table}`)).toBe('42501');
    });
  }

  it('cannot drop, disable or replace the guard triggers', async () => {
    expect(await code('drop trigger gxp_audit_trail_row_guard on audit_trail')).toBe('42501');
    expect(await code('alter table audit_trail disable trigger user')).toBe('42501');
    expect(await code(`create or replace function gxp_block_mutation() returns trigger as $$ begin return new; end $$ language plpgsql`)).toBe('42501');
    expect(await code('set session_replication_role = replica')).toBe('42501');
  });

  it('every other append-only table (guarded by gxp_block_mutation) is insert and read only as well', async () => {
    for (const table of ['audit_checkpoints', 'audit_reviews', 'audit_anchors', 'qms_links']) {
      expect(await code(`select 1 from ${table} limit 1`), table).toBe('ok');
      expect(await code(`delete from ${table}`), table).toBe('42501');
    }
  });
});

describe('lims_app on the working tables', () => {
  it('may read and change ordinary records, but not truncate them or change the schema', async () => {
    expect(await code(`update samples set batch = batch where false`)).toBe('ok');
    expect(await code(`update users set name = name where id = 'usr-qa'`)).toBe('ok');
    expect(await code('truncate samples')).toBe('42501');
    expect(await code('alter table samples add column x int')).toBe('42501');
    expect(await code('create table lims_app_scratch (id int)')).toBe('42501');
  });
});

describe('the guard triggers', () => {
  it('fire ALWAYS, so a session in replica mode does not skip them', async () => {
    const { rows } = await t.pool.query(`select tgname, tgenabled from pg_trigger where tgname like 'gxp\\_%' and not tgisinternal order by 1`);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.filter(r => r.tgenabled !== 'A').map(r => r.tgname)).toEqual([]);
    const c = await t.pool.connect();
    try {
      await c.query('set session_replication_role = replica');
      await expect(c.query(`update audit_trail set reason = 'x' where sequence = 1`)).rejects.toThrow(/not permitted/);
    } finally { await c.query('reset session_replication_role'); c.release(); }
  });

  it('the step is idempotent and keeps working after the protections are re-applied (which re-creates the triggers)', async () => {
    const { appRoleStep } = await import('../../src/server/boot/steps/roles');
    const { applyProtections } = await import('../../src/db/protections');
    await applyProtections(t.pool);
    const report = await appRoleStep(t.pool, { env: {}, log: () => {} });
    expect(report).toMatchObject({ role: 'lims_app', created: false });
    const { rows } = await t.pool.query(`select count(*)::int as n from pg_trigger where tgname like 'gxp\\_%' and not tgisinternal and tgenabled <> 'A'`);
    expect(rows[0].n).toBe(0);
    // No password given this time: the role keeps the one it has, the application can still connect.
    expect(await code('select 1')).toBe('ok');
  });

  it('LIMS_APP_ROLE=off skips the step, and says so', async () => {
    const { appRoleStep } = await import('../../src/server/boot/steps/roles');
    const lines: string[] = [];
    expect(await appRoleStep(t.pool, { env: { LIMS_APP_ROLE: 'off' }, log: m => lines.push(m) })).toBeNull();
    expect(lines.join('\n')).toMatch(/lims_app.*skipped/i);
  });
});
