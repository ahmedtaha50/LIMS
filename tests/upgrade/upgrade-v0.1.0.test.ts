/**
 * Acceptance (M04): a database created from the v0.1.0 fixture upgrades to the current schema through the product's own
 * installer (src/server/init-db.ts), keeps every record, and leaves a verified pre-migration backup and a SCHEMA_MIGRATED audit row.
 *
 * The fixture (tests/upgrade/fixtures) is the schema.sql, the triggers and the data of a real v0.1.0 installation: the demo
 * seed plus signed workflows executed by the original v0.1.0 server (a failed e-signature, an approval, a batch release, ...).
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX, PERMISSIONS, ROLE_NAMES, SOD_RULES } from '../../src/lib/permissions';
import { restoreBackup, verifyAuditChain, verifyBackupFile } from '../../src/server/backup';
import { protectionStatements } from '../../src/db/protections';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { FIXTURES, ROOT, columnTypes, loadV010, runInitDb, scratchDb, tableExists, tempDir, type Scratch } from './helpers';

const PASSPHRASE = 'upgrade-test-passphrase-123';

/**
 * Every row of every table as JSON text, with timestamptz columns shown as the naive UTC wall clock the v0.1.0 columns held,
 * so a snapshot before the upgrade and one after it are directly comparable.
 */
async function snapshot(pool: pg.Pool): Promise<Record<string, string[]>> {
  const cols = await pool.query(`select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name not in ('schema_migrations', 'counters') order by table_name, ordinal_position`);
  const byTable = new Map<string, string[]>();
  for (const c of cols.rows) {
    const select = c.data_type === 'timestamp with time zone' ? `("${c.column_name}" AT TIME ZONE 'UTC') AS "${c.column_name}"` : `"${c.column_name}"`;
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), select]);
  }
  const out: Record<string, string[]> = {};
  for (const [table, select] of byTable) {
    const { rows } = await pool.query(`select to_jsonb(t)::text as j from (select ${select.join(', ')} from "${table}") t order by 1`);
    out[table] = rows.map(r => r.j);
  }
  return out;
}

/** Columns audit v2 added to audit_trail, with the value every row written before it reads back (nothing was rewritten). */
const AUDIT_V2_DEFAULTS: Record<string, unknown> = { actor_name: null, actor_role: null, session_id: null, app_version: null, hash_version: 1, hash_alg: 'sha256', seal: null };
/** A row as an object without the audit v2 columns, after checking that they hold exactly those defaults. */
function legacyAuditRow(j: string): Record<string, unknown> {
  const row = JSON.parse(j);
  for (const [k, v] of Object.entries(AUDIT_V2_DEFAULTS)) { if (k in row) { expect(row[k], k).toBe(v); delete row[k]; } }
  return row;
}

/** Columns 0010_identity (r1-identity) added to users and system_settings, with the value every row that existed before reads back. */
const IDENTITY_V10_DEFAULTS: Record<string, Record<string, unknown>> = {
  users: { must_change_password: false, login_failed_attempts: 0, login_locked_until: null, totp_pending_secret: null, totp_last_step: null, totp_enrolled_at: null, version: 1 },
  system_settings: { password_history_count: 5, lockout_minutes: 15, mfa_required: false, session_absolute_hours: 12, version: 1 },
  // 0070_quality (r1-quality-fixes): the instrument version, and the sample type and limits of an environmental record (unknown for old rows).
  instruments: { version: 1 },
  env_records: { sample_type: null, limit_alert: null, limit_action: null },
  // 0060_spec (r1-spec): revision_label is numbered from the history (each fixture material has one revision, so 1); created_by and
  // approved_by stay null because the fixture's audit trail names nobody for these seeded rows (tests/api/spec-schema.test.ts covers the rule).
  specifications: { revision_label: 1, created_by: null, approved_by: null },
  // 0050_results_oos (r1-results-oos): the specification binding, the limit copied onto each result and the OOS phase and decision
  // are unknown for rows written before it; nothing is rewritten.
  samples: { spec_id: null, spec_revision: null },
  results: { unit: null, limit_kind: null, lower_text: null, upper_text: null, decimals: null, acceptance_text: null },
  // 0210_oos_workflow (r2-oos-workflow) adds the due date, the Phase II start, the assignable cause and its confirmation: unknown too.
  oos_investigations: {
    phase: null, decision: null, due_date: null, phase2_started_at: null, assignable_cause_category: null, assignable_cause: null,
    assignable_cause_by: null, assignable_cause_at: null, invalidated_by: null, invalidated_at: null,
  },
};
/**
 * Columns 0020_esign (r1-esign) added to signatures. Unlike the others they are not left at a default: the migration fills them
 * for the rows that exist (binding from the audit entry, meaning code, signer snapshot), which tests/api/esign-legacy-upgrade.test.ts
 * checks value by value. Here they only have to be present and are set aside, so every column the signature hash covers is compared.
 */
const ESIGN_V20_COLUMNS = ['entity_type', 'entity_id', 'meaning_code', 'signer_name', 'signer_role', 'auth_method', 'hash_version'];
/** A row as an object without the columns a later migration added to its table, after checking that they hold exactly their defaults. */
function legacyRow(table: string, j: string): Record<string, unknown> {
  const row = JSON.parse(j);
  for (const [k, v] of Object.entries(IDENTITY_V10_DEFAULTS[table] ?? {})) { expect(row[k], `${table}.${k}`).toBe(v); delete row[k]; }
  if (table === 'signatures') for (const k of ESIGN_V20_COLUMNS) { expect(row, `${table}.${k}`).toHaveProperty(k); delete row[k]; }
  return row;
}

/** Rows the 0040_authz migration installs in its tables (the default matrix); every other table the migrations add starts empty. */
const AUTHZ_CATALOG_ROWS: Record<string, number> = {
  roles: ROLE_NAMES.length,
  permissions: PERMISSIONS.length,
  role_permissions: ROLE_NAMES.reduce((n, r) => n + DEFAULT_MATRIX[r].length, 0),
  sod_rules: SOD_RULES.length,
};

/** Rows 0100_master_data derives from the v0.1.0 samples (the backfill; tests/api/master-migration.test.ts checks them value by value). */
const MASTER_DATA_ROWS = (snap: Record<string, string[]>): Record<string, number> => {
  const rows = snap.samples.map(j => JSON.parse(j) as { material: string; batch: string });
  const key = (m: string) => m.trim().replace(/\s+/g, ' ').toLowerCase();
  return {
    products: new Set(rows.map(r => key(r.material))).size,
    product_batches: new Set(rows.map(r => `${key(r.material)}|${r.batch}`)).size,
    sample_context: rows.length,
  };
};
/** The rows 0100 derives carry the time of the run that derived them (created_at); a second run derives the same rows at another time. */
const MASTER_DERIVED = ['products', 'product_batches', 'sample_context'];
const withoutRunTime = (rows: string[]) => rows.map(j => { const { created_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); });

let s: Scratch;
let before: Record<string, string[]>;
let after: Record<string, string[]>;
let backups: string;
let firstRun: { status: number | null; stdout: string; stderr: string };
let auditRowsBefore: any[];

beforeAll(async () => {
  s = await scratchDb('v010');
  await loadV010(s);
  backups = tempDir('bplims-mig-backups');
  before = await snapshot(s.pool);
  auditRowsBefore = (await s.pool.query('select * from audit_trail order by sequence')).rows;
  firstRun = runInitDb(s, { MIGRATION_BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: backups });
  after = await snapshot(s.pool);
});

describe('installer on a v0.1.0 installation', () => {
  it('upgrades the schema in place: journal, counters, timestamptz, indexes, and one SCHEMA_MIGRATED audit row', async () => {
    expect(firstRun.status, firstRun.stderr).toBe(0);
    expect(await tableExists(s.pool, 'schema_migrations')).toBe(true);
    expect(await tableExists(s.pool, 'counters')).toBe(true);
    const naive = await s.pool.query(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone'`);
    expect(naive.rows).toEqual([]);
    expect((await columnTypes(s.pool, 'signatures')).timestamp).toBe('timestamp with time zone');
    const idx = await s.pool.query(`select indexname from pg_indexes where schemaname = 'public' and indexname like '%\\_idx'`);
    expect(idx.rows.map(r => r.indexname)).toEqual(expect.arrayContaining(['results_sample_id_idx', 'audit_trail_entity_idx', 'samples_batch_idx']));

    const added = await s.pool.query(`select action, user_id, entity, sequence from audit_trail where sequence > $1 order by sequence`, [auditRowsBefore.length]);
    expect(added.rows).toHaveLength(1);
    expect(added.rows[0]).toMatchObject({ action: 'SCHEMA_MIGRATED', entity: 'SYSTEM_MIGRATION' });
    expect(added.rows[0].user_id).toMatch(/^migration:/);

    const ids = (await s.pool.query('select id from schema_migrations order by id')).rows.map(r => r.id);
    expect(ids.slice(0, 4)).toEqual(['0000_baseline', '0001_timestamptz', '0002_counters', '0003_indexes']);
    const detail = JSON.parse((await s.pool.query(`select new_value from audit_trail where action = 'SCHEMA_MIGRATED'`)).rows[0].new_value);
    expect(detail.baselineAdopted).toBe(true);
    expect(detail.applied.map((a: any) => a.id).slice(0, 4)).toEqual(['0000_baseline', '0001_timestamptz', '0002_counters', '0003_indexes']); // journal rows written by this run
    expect(firstRun.stdout).toMatch(/upgraded to \d{4}_\w+ \(applied: 0001_timestamptz, 0002_counters, 0003_indexes(, \d{4}_\w+)*\)/);
    expect(detail.backup.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps every record: all rows of all tables read back identically (timestamps as the same wall clock, hence the same instant)', () => {
    // Tables added by later migrations start empty; every table v0.1.0 had keeps its rows.
    expect(Object.keys(after)).toEqual(expect.arrayContaining(Object.keys(before)));
    for (const added of Object.keys(after).filter(t => !(t in before))) {
      // 0010_identity (r1-identity) starts password_history with one row per user that has a password: the password in force, so the
      // "not one of the last N" rule remembers it at the first change. Every other new table starts empty.
      // 0020_esign (r1-esign) installs the signature meaning catalog the same way.
      // 0040_authz (r1-authz) installs the default permission matrix: its rows are the catalog of src/lib/permissions.ts and nothing else.
      // 0070_quality (r1-quality-fixes) adds the VERIFICATION meaning (13 in the catalog) and the 14 example environmental limits.
      // 0100_master_data (r2-master-data) adds the MASTER_DATA_STATUS meaning (14) and maps every v0.1.0 sample to a product and a
      // batch: one product per material, one batch per (material, batch), one sample_context row per sample (MASTER_DATA_ROWS).
      // 0110_methods_calc (r2-methods-calc) adds METHOD_APPROVAL, FORMULA_APPROVAL and TEST_PLAN_APPROVAL (17) and derives one
      // spec_parameters row per parameter of every specification (tests/api/methods-migration.test.ts checks them value by value).
      // 0180_qms (r2-qms) adds seven QMS meanings (24) and the one qms_settings row, with change control not required.
      // 0120_raw_data (r2-raw-data) adds REINTEGRATION_APPROVAL (25) and gives every result that holds a value its first result_versions
      // row (MIGRATED; tests/api/rawdata-migration.test.ts checks them value by value).
      // 0170_audit_review (r2-audit-tamper) adds AUDIT_REVIEW, AUDIT_REVIEW_SETTING and CLOCK_ANOMALY_ACK (28) and the one
      // audit_review_settings row, with the review before release not required.
      // 0190_coa_reports (r2-coa-reports) adds COA_AUTHORISATION and COA_VOID (30); its three tables start empty.
      // 0200_docs_training (r2-docs-training) adds five document meanings and QUALIFICATION_OVERRIDE (36) and the one LIMS software
      // curriculum (training_curricula); documents, versions, prints, assignments and qualifications start empty.
      // 0210_oos_workflow (r2-oos-workflow) adds OOS_INVALIDATION, OOS_RETEST_AUTHORISATION and OOS_SETTING_CHANGE (39), the one
      // oos_settings row and the two OOS checklist templates (Phase I and Phase II).
      // 0220_custody (r2-custody-labels) adds CUSTODY_DEVIATION_ACK and RETAIN_DISPOSAL (41); its six tables start empty (a v0.1.0
      // sample has no receipt: one in Logged must be received before testing starts).
      // 0230_reagents (r2-reagents) adds REAGENT_LOT_RELEASE, REAGENT_LOT_REJECTION and REAGENT_LOT_RETEST (44); its six tables start
      // empty (the v0.1.0 reagents register is not migrated into them).
      // 0240_stability (r2-stability) adds STABILITY_PROTOCOL_APPROVAL (45) and the seven ICH Q1A(R2) storage conditions.
      // 0260_instrument_data (r2-instrument-integration) adds INSTRUMENT_PROFILE_APPROVAL (47).
      // R3 adds 6 more: 0310_directory DIRECTORY_MAPPING, 0320_spc SPC_BASELINE_APPROVAL, 0330_periodic_archive PERIODIC_REVIEW, ARCHIVE_DECISION,
      // RETENTION_POLICY and LEGAL_HOLD (48 + 1 + 1 + 4 = 54). Their other new tables start empty.
      // 0250_em (r2-em) adds EM_LIMIT_APPROVAL (46) and 25 Draft limit profiles: a copy of each of the 14 active env_limits rows and the
      // 11 example particle limits. Its other tables start empty.
      const specParameters = before.specifications.reduce((n, j) => n + (Array.isArray(JSON.parse(j).parameters) ? JSON.parse(j).parameters.length : 0), 0);
      const expected = added === 'password_history' ? before.users.filter(j => JSON.parse(j).password_hash).length : added === 'signature_meanings' ? 54
        : added === 'env_limits' ? 14 : added === 'spec_parameters' ? specParameters : added === 'qms_settings' || added === 'audit_review_settings' || added === 'oos_settings' || added === 'training_curricula' ? 1 : added === 'oos_checklist_templates' ? 2 : added === 'stability_conditions' ? 7 : added === 'em_limit_profiles' ? 25 : added === 'result_versions' ? before.results.filter(j => ![null, ''].includes(JSON.parse(j).value)).length : (MASTER_DATA_ROWS(before)[added] ?? AUTHZ_CATALOG_ROWS[added] ?? 0);
      expect(after[added], added).toHaveLength(expected);
    }
    for (const table of Object.keys(before)) {
      // audit_trail gains exactly one row, the migration's own; every other row (timestamp column included) must be unchanged.
      if (table === 'audit_trail') {
        const rows = after[table].filter(j => !j.includes('"action": "SCHEMA_MIGRATED"')).map(legacyAuditRow);
        expect(rows, table).toEqual(before[table].map(j => JSON.parse(j)));
      } else {
        expect(after[table].map(j => legacyRow(table, j)), table).toEqual(before[table].map(j => JSON.parse(j)));
      }
    }
  });

  it('does not rewrite the audit trail: every earlier row is byte-identical and the chain verifies end to end', async () => {
    const rows = (await s.pool.query('select * from audit_trail order by sequence')).rows;
    expect(rows).toHaveLength(auditRowsBefore.length + 1);
    // `timestamp` is the one column whose type changed; compare it as the same instant (naive UTC wall clock).
    const wall = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d));
    for (const [i, old] of auditRowsBefore.entries()) {
      const { timestamp: _t, ...rest } = rows[i];
      const { timestamp: _o, ...oldRest } = old;
      for (const [k, v] of Object.entries(AUDIT_V2_DEFAULTS)) { expect(rest[k], k).toBe(v); delete rest[k]; } // audit v2 columns: defaults only
      expect(rest).toEqual(oldRest);
      expect(wall(rows[i].timestamp)).toBeTruthy();
    }
    expect(verifyAuditChain(rows)).toEqual({ isValid: true, compromisedSequence: null });
  });

  it('left a pre-migration backup that verifies and restores into a v0.1.0 schema with identical data', async () => {
    const files = fs.readdirSync(backups).filter(f => f.endsWith('.bak'));
    expect(files).toHaveLength(1);
    const file = path.join(backups, files[0]);
    const verified = verifyBackupFile(file, PASSPHRASE);
    expect(verified).toMatchObject({ ok: true, problems: [] });
    expect(verified.manifest.auditHead.sequence).toBe(auditRowsBefore.length); // taken before the migration wrote its entry

    const target = await scratchDb('restored');
    const restored = await restoreBackup(file, PASSPHRASE, target.pool, fs.readFileSync(path.join(FIXTURES, 'v0.1.0.schema.sql'), 'utf8'));
    expect(restored).toMatchObject({ chainIntact: true, countsMatch: true });
    expect(await snapshot(target.pool)).toEqual(before); // timestamps to the microsecond: no shift by the machine's UTC offset
  });

  it('can be rolled back and upgraded again: restoring the pre-migration backup into the v0.1.0 schema, then migrating, gives the same data', async () => {
    const file = path.join(backups, fs.readdirSync(backups).filter(f => f.endsWith('.bak'))[0]);
    const files = loadMigrations(path.join(ROOT, 'drizzle'));
    const target = await scratchDb('rollback');
    // What an operator restoring the backup needs: an empty database at the backup's schema version (journal table included).
    const restored = await restoreBackup(file, PASSPHRASE, target.pool, buildSchemaSql(files, '0000_baseline'));
    expect(restored).toMatchObject({ chainIntact: true, countsMatch: true });
    expect(await snapshot(target.pool)).toEqual(before);

    const again = await migrate(target.pool, { dir: path.join(ROOT, 'drizzle'), backup: async () => ({ file: 'rollback-test.bak', sha256: 'b'.repeat(64), verified: true }) });
    expect(again).toMatchObject({ status: 'migrated', adoptedBaseline: true });
    const strip = (snap: Record<string, string[]>) => ({
      ...snap, audit_trail: snap.audit_trail.filter(j => !j.includes('"action": "SCHEMA_MIGRATED"')),
      ...Object.fromEntries(MASTER_DERIVED.map(t => [t, withoutRunTime(snap[t] ?? [])])),
      // The LIMS software curriculum 0200 installs carries the time of the run (created_at).
      training_curricula: (snap.training_curricula ?? []).map(j => { const { created_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      // The qms_settings row 0180 installs carries the time of the run (updated_at).
      qms_settings: (snap.qms_settings ?? []).map(j => { const { updated_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      audit_review_settings: (snap.audit_review_settings ?? []).map(j => { const { updated_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      // 0210 likewise: the oos_settings row (updated_at) and the checklist templates (created_at).
      // 0250 likewise: the draft limit profiles (created_at).
      em_limit_profiles: (snap.em_limit_profiles ?? []).map(j => { const { created_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      oos_settings: (snap.oos_settings ?? []).map(j => { const { updated_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      oos_checklist_templates: (snap.oos_checklist_templates ?? []).map(j => { const { created_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
      // 0240: the installed storage conditions carry the time of the run (created_at).
      stability_conditions: (snap.stability_conditions ?? []).map(j => { const { created_at: _t, ...rest } = JSON.parse(j); return JSON.stringify(rest); }),
    });
    expect(strip(await snapshot(target.pool))).toEqual(strip(after));
  });

  it('keeps the append-only triggers: UPDATE, DELETE and TRUNCATE of audit_trail and signatures are still refused', async () => {
    expect((await s.pool.query(`select count(*)::int as n from pg_trigger where tgname like 'gxp\\_%'`)).rows[0].n).toBe((protectionStatements.join(' ').match(/CREATE TRIGGER gxp_/g) ?? []).length);
    for (const sql of [
      `update audit_trail set reason = 'tamper' where sequence = 1`, `delete from audit_trail where sequence = 1`, 'truncate audit_trail',
      `update signatures set meaning = 'tamper'`, 'delete from signatures', 'truncate signatures',
    ]) {
      await expect(s.pool.query(sql), sql).rejects.toThrow(/not permitted/);
    }
  });

  it('seeds the sample counter from the highest existing number, so the first new number is unused', async () => {
    const ids = (await s.pool.query(`select id from samples where id like 'SMP-2026-%'`)).rows.map(r => Number(r.id.split('-')[2]));
    const counter = (await s.pool.query(`select value::int as v from counters where key = 'sample:2026'`)).rows[0].v;
    expect(counter).toBe(Math.max(...ids));
  });

  it('is idempotent: a second installer run changes nothing and makes no second backup', async () => {
    const run = runInitDb(s, { MIGRATION_BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: backups });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/already up to date/);
    expect(fs.readdirSync(backups).filter(f => f.endsWith('.bak'))).toHaveLength(1);
    expect((await s.pool.query('select count(*)::int as n from audit_trail')).rows[0].n).toBe(auditRowsBefore.length + 1);
  });

  it('refuses to upgrade without a configured backup, and says what to set', async () => {
    const other = await scratchDb('v010-nobackup');
    await loadV010(other);
    const run = runInitDb(other, { MIGRATION_BACKUP_PASSPHRASE: '', BACKUP_PASSPHRASE: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/MIGRATION_BACKUP_PASSPHRASE/);
    expect(await tableExists(other.pool, 'schema_migrations')).toBe(false);
  });

  it('the application works on the upgraded database: the v0.1.0 signatures that can be recomputed still verify, the others say so, and a new audit entry extends the chain', async () => {
    Object.assign(process.env, s.env); // src/db/index reads SQL_* once, at first import; this file's modules are not loaded yet
    const { createApp } = await import('../../src/server/app');
    const { db } = await import('../../src/db/index');
    const request = supertest(createApp({ db, rateLimit: false }));

    const login = await request.post('/api/auth/login-local').send({ email: 'qa@gxp.com', password: 'password' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const sigIds = (await s.pool.query('select id from signatures order by id')).rows.map(r => r.id);
    expect(sigIds).toHaveLength(5);
    // r1-esign (M07): a signature verifies when its hash is recomputed and matches. The two sample transitions and the ELN signature
    // can be recomputed; the batch release (a list of samples that was not kept) and the notebook observation (content hash 'N/A')
    // cannot, and are shown as legacy-unverifiable instead of valid.
    const hashChecked: Record<string, boolean | null> = {};
    for (const id of sigIds) {
      const res = await request.get(`/api/signatures/verify/${id}`).set(auth);
      expect(res.status, id).toBe(200);
      const recomputable = ['sig-7d8aaf8559f8097d', 'sig-a998fb35a28b73fb', 'SIG-ELN-395C49EB'].includes(id);
      expect(res.body.valid, id).toBe(recomputable);
      expect(res.body.status, id).toBe(recomputable ? 'valid' : 'legacy-unverifiable');
      hashChecked[id] = res.body.contentHashMatches;
    }
    expect(Object.values(hashChecked).filter(v => v === true)).toHaveLength(3);

    const verify = await request.post('/api/audit/verify').set(auth);
    expect(verify.body).toMatchObject({ isValid: true, compromisedSequence: null, totalRecords: auditRowsBefore.length + 1 });

    // The application's own writer continues the chain behind the migration's entry.
    const { writeAudit } = await import('../../src/db/utils');
    await db.transaction(tx => writeAudit(tx, 'usr-qa', 'Create', 'Probe', 'p-1', 'all', '', '{}', 'chain continuity check'));
    expect(verifyAuditChain((await s.pool.query('select * from audit_trail')).rows).isValid).toBe(true);
    await db.$client.end();
  });
});
