/**
 * Roadmap M25 (r2-coa-reports), migration 0190_coa_reports: the CoA register (coa_documents), the generated-document register
 * (report_runs), the print log (report_print_log), two signature meanings and the coa.issue permission.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * a new installation: the meanings, the permission and its grants, and the database's own refusals: a CoA's number, version,
 *     snapshot and authorisation never change, its status moves only Issued -> Superseded | Voided, the PDF hash is set once, nothing
 *     is deleted; report runs and the print log are append-only;
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/reports.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import * as reports from '../../src/db/schema/reports';
import { COA_DOCUMENTS_GUARD } from '../../src/db/protections/reports';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['coa_documents', 'report_runs', 'report_print_log'];
const backup = async () => ({ file: 'coa-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0190_coa_reports, in the range reserved for this track', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0190_coa_reports');
  });
  it('creates the same guard function the protections install at every start', () => {
    expect(fs.readFileSync(path.join(DIR, '0190_coa_reports.sql'), 'utf8')).toContain(`${COA_DOCUMENTS_GUARD};`);
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('coa-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code like 'COA_%'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code = 'coa.issue'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meanings and the permission, and the database refuses every change a controlled document must not have', async () => {
    const s = await scratchDb('coa-new');
    await migrate(s.pool, { dir: DIR });
    const meanings = (await s.pool.query(`select code, text, allowed_roles, requires_reason from signature_meanings where code like 'COA_%' order by code`)).rows;
    expect(meanings.map(m => m.code)).toEqual(['COA_AUTHORISATION', 'COA_VOID']);
    for (const m of meanings) expect(m.allowed_roles, m.code).toEqual(['QA', 'Admin']);
    expect(meanings[0].text).toMatch(/^Authorisation of Certificate of Analysis/);
    expect(meanings.find(m => m.code === 'COA_VOID').requires_reason).toBe(true);
    const grants = (await s.pool.query(`select role_id from role_permissions where permission_code = 'coa.issue' order by 1`)).rows.map(r => r.role_id);
    expect(grants).toEqual(['role-admin', 'role-qa']);

    const q = (text: string, params: unknown[] = []) => s.pool.query(text, params);
    const user = (await q(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA') returning id`)).rows[0].id;
    await q(`insert into samples (id, material, batch, state, created_by) values ('S1', 'M', 'B', 'Approved', $1)`, [user]);
    const doc = (id: string, n: string, v: number, extra = '') => q(
      `insert into coa_documents (id, sample_id, number, issue_version, label, snapshot, snapshot_sha256, issued_by, issued_at${extra ? ', supersedes_id' : ''})
       values ($1, 'S1', $2, $3::int, $2 || '-v' || $3::int, '{"a":1}', $4, $5, now()${extra ? `, '${extra}'` : ''})`, [id, n, v, 'b'.repeat(64), user]);
    await doc('D1', 'COA-2026-0001', 1);
    await expect(doc('D2', 'COA-2026-0002', 1)).rejects.toThrow(/coa_documents_one_issued_per_sample_uidx/);  // one Issued per sample
    await expect(doc('D3', 'COA-26-1', 1)).rejects.toThrow(/coa_documents_number_check/);

    for (const [col, val] of [['snapshot', `'{"a":2}'`], ['snapshot_sha256', `'${'c'.repeat(64)}'`], ['number', `'COA-2026-0009'`], ['issue_version', '5'], ['issued_by', 'NULL'], ['label', `'X'`]]) {
      await expect(q(`update coa_documents set ${col} = ${val} where id = 'D1'`), col).rejects.toThrow(/controlled document/);
    }
    await expect(q(`delete from coa_documents where id = 'D1'`)).rejects.toThrow(/controlled document/);
    await expect(q(`truncate coa_documents cascade`)).rejects.toThrow(/append-only|controlled document/);

    // the PDF hash is set once
    await q(`update coa_documents set pdf_sha256 = $1, original_run_id = 'run-1', version = version + 1 where id = 'D1'`, ['d'.repeat(64)]);
    await expect(q(`update coa_documents set pdf_sha256 = $1 where id = 'D1'`, ['e'.repeat(64)])).rejects.toThrow(/controlled document/);

    // status: Issued -> Superseded with the reason and successor, and never back
    await expect(q(`update coa_documents set status = 'Superseded' where id = 'D1'`)).rejects.toThrow(/controlled document/);   // no reason
    await q(`update coa_documents set status = 'Superseded', superseded_by_id = 'D9', superseded_at = now(), superseded_reason = 'Corrected', superseded_by = $1 where id = 'D1'`, [user]);
    await expect(q(`update coa_documents set status = 'Issued' where id = 'D1'`)).rejects.toThrow(/controlled document/);
    await expect(q(`update coa_documents set superseded_reason = 'Other' where id = 'D1'`)).rejects.toThrow(/controlled document/);
    await doc('D9', 'COA-2026-0001', 2, 'D1');
    await expect(doc('D10', 'COA-2026-0001', 2)).rejects.toThrow(/coa_documents_number_issue_version_uidx/);
    await q(`update coa_documents set status = 'Voided', voided_at = now(), void_reason = 'Wrong order', voided_by = $1 where id = 'D9'`, [user]);
    await expect(q(`update coa_documents set status = 'Issued' where id = 'D9'`)).rejects.toThrow(/controlled document/);

    // report runs and the print log are append-only
    await q(`insert into report_runs (id, report_type, document_id, copy_no, purpose, document_status, file_name, bytes, pdf_sha256, pdf, generated_by)
             values ('run-1', 'CoA', 'D1', 1, 'Original', 'Issued', 'x.pdf', 3, $1, '\\x414243', $2)`, ['f'.repeat(64), user]);
    await expect(q(`insert into report_runs (id, report_type, document_id, copy_no, purpose, document_status, file_name, bytes, pdf_sha256, pdf, generated_by)
             values ('run-2', 'CoA', 'D1', 1, 'Copy', 'Issued', 'x.pdf', 3, $1, '\\x414243', $2)`, ['f'.repeat(64), user])).rejects.toThrow(/report_runs_document_copy_uidx/);
    await q(`insert into report_print_log (id, run_id, action, printed_by) values ('p1', 'run-1', 'Download', $1)`, [user]);
    for (const table of ['report_runs', 'report_print_log']) {
      await expect(q(`update ${table} set id = id`), table).rejects.toThrow(/append-only/);
      await expect(q(`delete from ${table}`), table).rejects.toThrow(/append-only/);
      await expect(q(`truncate ${table} cascade`), table).rejects.toThrow(/append-only/);
    }
  });

  it('src/db/schema/reports.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('coa-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...reports }, drizzle(s.pool) as any, ['public'], ['coa_*', 'report_*'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0190 and changes no existing row', async () => {
    const s = await scratchDb('coa-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0190_coa_reports').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from jobs t) as jobs`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0190_coa_reports');
    expect(await frozen()).toBe(rowsBefore);
    expect((await s.pool.query(`select count(*)::int as n from coa_documents`)).rows[0].n).toBe(0);
  });
});
