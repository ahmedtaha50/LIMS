/**
 * Roadmap M28 (r2-docs-training), migration 0200_docs_training: controlled documents, their versions and print log, training
 * curricula and assignments, analyst qualifications, six signature meanings, eight permissions and the LIMS software curriculum.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * a new installation: the meanings, the permissions and their grants, the LIMS curriculum, and the database's own refusals
 *     (one Effective version per document, an Effective version cannot be edited or deleted, the print log is append-only,
 *     a completed assignment cannot be changed);
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/documents.ts and src/db/schema/training.ts declare exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as documents from '../../src/db/schema/documents';
import * as training from '../../src/db/schema/training';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const ID = '0200_docs_training';
const TABLES = ['documents', 'document_versions', 'document_prints', 'training_curricula', 'training_curriculum_documents', 'training_assignments', 'analyst_qualifications'];
const MEANINGS = ['DOCUMENT_APPROVAL', 'DOCUMENT_AUTHORSHIP', 'DOCUMENT_EFFECTIVE', 'DOCUMENT_OBSOLETE', 'DOCUMENT_REVIEW', 'QUALIFICATION_OVERRIDE'];
const backup = async () => ({ file: 'docs-test.bak', sha256: 'a'.repeat(64), verified: true });
const SHA = 'b'.repeat(64);

describe('the migration file', () => {
  it(`is ${ID}, in the range reserved for this track (0200 to 0209)`, () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain(ID);
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('docs-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code like 'DOCUMENT_%' or code = 'QUALIFICATION_OVERRIDE'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code like 'doc.%'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meanings, the permissions, the LIMS curriculum and the database-level controls', async () => {
    const s = await scratchDb('docs-new');
    await migrate(s.pool, { dir: DIR });
    const meanings = (await s.pool.query(`select code, allowed_roles, requires_reason, training_exempt from signature_meanings
      where code like 'DOCUMENT_%' or code = 'QUALIFICATION_OVERRIDE' order by code`)).rows;
    expect(meanings.map(m => m.code)).toEqual(MEANINGS);
    const byCode = Object.fromEntries(meanings.map(m => [m.code, m]));
    // Only QA makes a version Effective (M28 acceptance: "a QA role").
    expect(byCode.DOCUMENT_EFFECTIVE.allowed_roles).toEqual(['QA']);
    expect(byCode.DOCUMENT_APPROVAL.allowed_roles).toEqual(['QA', 'Admin']);
    expect(byCode.DOCUMENT_REVIEW.allowed_roles).toEqual(['Reviewer', 'QA', 'Admin']);
    expect(byCode.DOCUMENT_AUTHORSHIP.allowed_roles).toEqual(['Analyst', 'Reviewer', 'QA', 'Admin']);
    expect(byCode.QUALIFICATION_OVERRIDE.allowed_roles).toEqual(['QA']);
    expect(meanings.filter(m => m.requires_reason).map(m => m.code)).toEqual(['DOCUMENT_OBSOLETE', 'QUALIFICATION_OVERRIDE']);
    expect(meanings.filter(m => m.training_exempt)).toEqual([]);

    const grants = (await s.pool.query(`select role_id, permission_code from role_permissions
      where permission_code like 'doc.%' or permission_code in ('training.manage', 'training.acknowledge', 'training.override') order by 1, 2`)).rows;
    expect(grants.map(g => `${g.role_id}:${g.permission_code}`)).toEqual([
      'role-admin:doc.approve', 'role-admin:doc.author', 'role-admin:doc.print', 'role-admin:doc.review', 'role-admin:doc.view',
      'role-admin:training.acknowledge', 'role-admin:training.manage', 'role-admin:training.override',
      'role-analyst:doc.author', 'role-analyst:doc.print', 'role-analyst:doc.view', 'role-analyst:training.acknowledge',
      'role-qa:doc.approve', 'role-qa:doc.author', 'role-qa:doc.print', 'role-qa:doc.review', 'role-qa:doc.view',
      'role-qa:training.acknowledge', 'role-qa:training.manage', 'role-qa:training.override',
      'role-reviewer:doc.author', 'role-reviewer:doc.print', 'role-reviewer:doc.review', 'role-reviewer:doc.view', 'role-reviewer:training.acknowledge',
    ]);
    expect((await s.pool.query(`select code, title, is_software, training_method from training_curricula`)).rows)
      .toEqual([{ code: 'LIMS-CORE', title: 'LIMS Core Software', is_software: true, training_method: 'OJT' }]);

    const user = (await s.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA') returning id`)).rows[0].id;
    await s.pool.query(`insert into documents (id, code, title, doc_type, created_by) values ('D1', 'SOP-1', 'Weighing', 'SOP', $1)`, [user]);
    await expect(s.pool.query(`insert into documents (id, code, title, doc_type, created_by) values ('D2', 'sop-1', 'Other', 'SOP', $1)`, [user])).rejects.toThrow(/documents_code_lower_uidx/);
    const version = (id: string, rev: number, status: string) => s.pool.query(
      `insert into document_versions (id, document_id, revision, title, status, author_id, file_name, media_type, bytes, file_sha256)
       values ($1, 'D1', $2, 'Weighing', $3, $4, 'sop.pdf', 'application/pdf', 10, $5)`, [id, rev, status, user, SHA]);
    await version('V1', 1, 'Effective');
    await expect(version('V2', 2, 'Effective')).rejects.toThrow(/document_versions_one_effective_uidx/);
    await expect(version('V3', 3, 'Published')).rejects.toThrow(/document_versions_status_check/);
    // An Effective version is frozen: content cannot change and the row cannot be deleted; superseding it is allowed.
    await expect(s.pool.query(`update document_versions set title = 'Changed' where id = 'V1'`)).rejects.toThrow(/controlled document/);
    await expect(s.pool.query(`update document_versions set file_sha256 = $1 where id = 'V1'`, ['c'.repeat(64)])).rejects.toThrow(/controlled document/);
    await expect(s.pool.query(`update document_versions set status = 'Draft' where id = 'V1'`)).rejects.toThrow(/controlled document/);
    await expect(s.pool.query(`delete from document_versions where id = 'V1'`)).rejects.toThrow(/controlled document/);
    await expect(s.pool.query(`truncate document_versions cascade`)).rejects.toThrow(/append-only|controlled document/);
    await s.pool.query(`update document_versions set status = 'Superseded', superseded_at = now(), version = version + 1 where id = 'V1'`);
    await expect(s.pool.query(`update document_versions set status = 'Effective' where id = 'V1'`)).rejects.toThrow(/controlled document/);

    await s.pool.query(`insert into document_prints (id, document_version_id, copy_number, purpose, printed_by) values ('P1', 'V1', 1, 'Bench copy', $1)`, [user]);
    await expect(s.pool.query(`update document_prints set purpose = 'x'`)).rejects.toThrow(/append-only/);
    await expect(s.pool.query(`delete from document_prints`)).rejects.toThrow(/append-only/);

    await s.pool.query(`insert into training_assignments (id, user_id, curriculum_id, training_method, due_date, status, origin, created_by)
      values ('A1', $1, 'CUR-LIMS-CORE', 'OJT', '2026-01-01', 'Completed', 'manual', $1)`, [user]);
    await expect(s.pool.query(`update training_assignments set status = 'Assigned' where id = 'A1'`)).rejects.toThrow(/training record/);
    await expect(s.pool.query(`delete from training_assignments where id = 'A1'`)).rejects.toThrow(/training record/);
    await expect(s.pool.query(`insert into training_assignments (id, user_id, curriculum_id, training_method, due_date, status, origin, created_by)
      values ('A2', $1, 'CUR-LIMS-CORE', 'OJT', '2026-01-01', 'Done', 'manual', $1)`, [user])).rejects.toThrow(/training_assignments_status_check/);
  });

  it('src/db/schema/documents.ts and training.ts declare exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('docs-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...documents, ...training }, drizzle(s.pool) as any, ['public'],
      ['document*', 'training_curricula', 'training_curriculum_documents', 'training_assignments', 'analyst_qualifications'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it(`upgrades through ${ID} and changes no existing row`, async () => {
    const s = await scratchDb('docs-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < ID).pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from users t) as users, (select json_agg(t order by id) from training_records t) as training,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from results t) as results`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain(ID);
    expect(await frozen()).toBe(rowsBefore);
    expect((await s.pool.query(`select count(*)::int as n from training_assignments`)).rows[0].n).toBe(0);
  });
});
