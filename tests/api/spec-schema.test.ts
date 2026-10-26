/**
 * Roadmap M11 (r1-spec): migration 0060. The revision of a specification gets its own column (revision_label), apart from the
 * optimistic-concurrency counter (version); the specification gets an author and an approver.
 *
 *   1. the shape of the table on a database built from the migrations;
 *   2. what the migration does to the specifications of an installation that has history: revisions numbered per material in the
 *      order they were created, the author and the approver read from the audit trail, nothing else changed, audit_trail untouched.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';
import { loadV010, runInitDb, scratchDb, tempDir, ROOT, type Scratch } from '../upgrade/helpers';

describe('the specifications table', () => {
  let db: TestDb;
  beforeAll(async () => { db = await useTestDb(); });
  const q = async (text: string, params: unknown[] = []) => (await db.pool.query(text, params)).rows;

  it('has revision_label (integer, not null, default 1), created_by and approved_by (text, nullable)', async () => {
    const cols = Object.fromEntries((await q(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'specifications'`)).map(r => [r.column_name, r]));
    expect(cols.revision_label).toMatchObject({ data_type: 'integer', is_nullable: 'NO', column_default: '1' });
    expect(cols.created_by).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(cols.approved_by).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(cols.version).toMatchObject({ data_type: 'integer', is_nullable: 'NO' }); // the OCC counter stays
  });

  it('refuses two revisions of one material with the same label', async () => {
    const material = `Schema material ${process.pid}`;
    await q(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters) VALUES ('SPEC-SCH-1', $1, 1, 1, '2026-01-01', 'Draft', '[]')`, [material]);
    await expect(q(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters) VALUES ('SPEC-SCH-2', $1, 1, 1, '2026-01-01', 'Draft', '[]')`, [material]))
      .rejects.toThrow(/specifications_material_revision_uq/);
    await q(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters) VALUES ('SPEC-SCH-3', $1, 1, 2, '2026-01-01', 'Draft', '[]')`, [material]);
  });

  it('author and approver must be users', async () => {
    await expect(q(`INSERT INTO specifications (id, material, version, effective_date, status, parameters, created_by) VALUES ('SPEC-SCH-4', 'M', 1, '2026-01-01', 'Draft', '[]', 'usr-nobody')`))
      .rejects.toThrow(/specifications_created_by_users_id_fk/);
    await expect(q(`INSERT INTO specifications (id, material, version, effective_date, status, parameters, approved_by) VALUES ('SPEC-SCH-5', 'M', 1, '2026-01-01', 'Active', '[]', 'usr-nobody')`))
      .rejects.toThrow(/specifications_approved_by_users_id_fk/);
  });

  it('indexes the foreign keys', async () => {
    const idx = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'specifications'`)).map(r => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['specifications_created_by_idx', 'specifications_approved_by_idx', 'specifications_material_revision_uq']));
  });
});

describe('migration 0060 on an installation that has specification history', () => {
  let s: Scratch;
  const MIGRATION = '0060_spec.sql';
  const sql = async (text: string, params: unknown[] = []) => (await s.pool.query(text, params)).rows;
  let auditBefore: unknown;

  const audit = (seq: number, action: string, id: string, user: string) => sql(
    `INSERT INTO audit_trail (id, sequence, timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash, hash_version)
     VALUES ($1, $2, '2026-03-01T10:00:00.000Z', $3, $4, 'Specification', $5, 'status', '', '', 'history', $6, $7, 1)`,
    [`adt-hist-${seq}`, seq, user, action, id, `h${seq}`, `h${seq - 1}`]);
  const spec = (id: string, material: string, status: string, date: string) => sql(
    `INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 7, $3, $4, '[{"name":"Assay","min":98,"max":102}]')`, [id, material, date, status]);

  beforeAll(async () => {
    s = await scratchDb('spec-history');
    // The installation as it was before this migration: every other migration applied, 0060 not yet.
    const dir = tempDir('spec-migrations-without-0060');
    for (const f of fs.readdirSync(path.join(ROOT, 'drizzle'))) if (f.endsWith('.sql') && f !== MIGRATION) fs.copyFileSync(path.join(ROOT, 'drizzle', f), path.join(dir, f));
    const run = runInitDb(s, { MIGRATIONS_DIR: dir });
    expect(run.status, run.stderr).toBe(0);
    expect((await sql(`SELECT 1 FROM information_schema.columns WHERE table_name = 'specifications' AND column_name = 'revision_label'`))).toHaveLength(0);

    await sql(`INSERT INTO users (id, uid, name, role, email, password_hash) VALUES ('usr-h-a', 'u-a', 'Ann Analyst', 'Analyst', 'a@h.test', 'x'), ('usr-h-q', 'u-q', 'Quinn QA', 'QA', 'q@h.test', 'x'), ('usr-h-b', 'u-b', 'Bo Analyst', 'Analyst', 'b@h.test', 'x'), ('usr-h-d', 'u-d', 'Dee Admin', 'Admin', 'd@h.test', 'x')`);
    // One material with four revisions (the ids do not follow their order), approved by different people.
    await spec('SPEC-Z-OLD', 'History material', 'Obsolete', '2025-01-01');
    await spec('SPEC-A-MID', 'History material', 'Obsolete', '2025-06-01');
    await spec('SPEC-M-CUR', 'History material', 'Active', '2026-01-01');
    await spec('SPEC-B-NEW', 'History material', 'Draft', '2026-09-01');
    // A material whose only specification has no history at all (seeded), and one whose creation was never audited next to one that was.
    await spec('SPEC-SEEDED', 'Seeded material', 'Active', '2026-01-01');
    await spec('SPEC-NOAUDIT', 'Mixed material', 'Active', '2026-01-01');
    await spec('SPEC-AUDITED', 'Mixed material', 'Draft', '2026-02-01');
    await spec('SPEC-TIE-0', 'Tie material', 'Active', '2026-05-01');
    await spec('SPEC-TIE-1', 'Tie material', 'Active', '2026-05-01');
    await spec('SPEC-TIE-2', 'Tie material', 'Active', '2026-05-01');
    const base = Number((await sql('SELECT max(sequence) AS n FROM audit_trail'))[0].n);
    let n = base;
    await audit(++n, 'Create', 'SPEC-Z-OLD', 'usr-h-a'); await audit(++n, 'Approve', 'SPEC-Z-OLD', 'usr-h-q');
    await audit(++n, 'Create', 'SPEC-A-MID', 'usr-h-b'); await audit(++n, 'Update', 'SPEC-A-MID', 'usr-h-b'); await audit(++n, 'Approve', 'SPEC-A-MID', 'usr-h-d');
    await audit(++n, 'Create', 'SPEC-M-CUR', 'usr-h-a'); await audit(++n, 'Approve', 'SPEC-M-CUR', 'usr-h-q'); await audit(++n, 'Approve', 'SPEC-M-CUR', 'usr-h-d'); // approved twice: the latest approval counts
    await audit(++n, 'Create', 'SPEC-B-NEW', 'usr-h-b');
    await audit(++n, 'Create', 'SPEC-AUDITED', 'usr-h-a');
    await audit(++n, 'Create', 'SPEC-TIE-2', 'usr-h-a'); await audit(++n, 'Create', 'SPEC-TIE-1', 'usr-h-a');
    auditBefore = await sql('SELECT * FROM audit_trail ORDER BY sequence');

    await s.pool.query(fs.readFileSync(path.join(ROOT, 'drizzle', MIGRATION), 'utf8'));
  });

  it('numbers the revisions of a material in the order they take effect, not by id', async () => {
    const rows = await sql(`SELECT id, revision_label FROM specifications WHERE material = 'History material' ORDER BY revision_label`);
    expect(rows.map(r => [r.id, r.revision_label])).toEqual([['SPEC-Z-OLD', 1], ['SPEC-A-MID', 2], ['SPEC-M-CUR', 3], ['SPEC-B-NEW', 4]]);
  });

  it('breaks a tie of effective dates by the order of creation in the audit trail, then by id', async () => {
    expect((await sql(`SELECT id, revision_label FROM specifications WHERE material = 'Tie material' ORDER BY revision_label`)).map(r => [r.id, r.revision_label]))
      .toEqual([['SPEC-TIE-2', 1], ['SPEC-TIE-1', 2], ['SPEC-TIE-0', 3]]); // TIE-0 was never audited: it comes last of the tie
  });

  it('numbers a specification whose creation was never audited by its effective date, and a lone one at 1', async () => {
    expect((await sql(`SELECT id, revision_label FROM specifications WHERE material = 'Mixed material' ORDER BY revision_label`)).map(r => [r.id, r.revision_label]))
      .toEqual([['SPEC-NOAUDIT', 1], ['SPEC-AUDITED', 2]]);
    expect((await sql(`SELECT revision_label FROM specifications WHERE id = 'SPEC-SEEDED'`))[0].revision_label).toBe(1);
  });

  it('reads the author from the first Create entry and the approver from the latest Approve entry; leaves unknown ones empty', async () => {
    const by = Object.fromEntries((await sql('SELECT id, created_by, approved_by FROM specifications')).map(r => [r.id, r]));
    expect(by['SPEC-Z-OLD']).toMatchObject({ created_by: 'usr-h-a', approved_by: 'usr-h-q' });
    expect(by['SPEC-A-MID']).toMatchObject({ created_by: 'usr-h-b', approved_by: 'usr-h-d' });
    expect(by['SPEC-M-CUR']).toMatchObject({ created_by: 'usr-h-a', approved_by: 'usr-h-d' });
    expect(by['SPEC-B-NEW']).toMatchObject({ created_by: 'usr-h-b', approved_by: null }); // a draft has no approver
    expect(by['SPEC-SEEDED']).toMatchObject({ created_by: null, approved_by: null });
    expect(by['SPEC-NOAUDIT']).toMatchObject({ created_by: null, approved_by: null });
  });

  it('changes nothing else: version, status, effective date and parameters are as they were, and the audit trail is untouched', async () => {
    const r = (await sql(`SELECT version, status, effective_date, parameters FROM specifications WHERE id = 'SPEC-M-CUR'`))[0];
    expect(r).toMatchObject({ version: 7, status: 'Active', effective_date: '2026-01-01', parameters: [{ name: 'Assay', min: 98, max: 102 }] });
    expect(await sql('SELECT * FROM audit_trail ORDER BY sequence')).toEqual(auditBefore);
  });
});
