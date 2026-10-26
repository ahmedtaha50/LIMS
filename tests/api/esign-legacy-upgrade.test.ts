/**
 * Roadmap M07 (r1-esign), upgrade: the five signatures of a real v0.1.0 installation (tests/upgrade/fixtures: two sample
 * transitions, an ELN signature, a batch release and a notebook observation with content hash 'N/A') get their binding, meaning
 * code and signer snapshot from migration 0020 without a single hash-covered column changing, and verify honestly afterwards.
 *
 * "Honestly": the two sample transitions and the ELN signature are recomputed and match; the release and the observation cannot
 * be recomputed (the first signed a list of samples that was not kept, the second signed nothing) and are shown as
 * legacy-unverifiable, never as valid.
 */
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadV010, runInitDb, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const PASSPHRASE = 'upgrade-test-passphrase-123';
let s: Scratch;
let legacyColumns: Record<string, string>;
// The timestamp changed type under it (0001: naive UTC wall clock to timestamptz), so it is compared as seconds since the epoch.
const LEGACY_ROW = `row(sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id, extract(epoch from "timestamp")::text)::text`;
const stamp = (v: Record<string, any>) => JSON.stringify(v);

beforeAll(async () => {
  s = await scratchDb('esign-legacy');
  await loadV010(s);
  const rows = (await s.pool.query(`SELECT id, ${LEGACY_ROW} AS r FROM signatures ORDER BY id`)).rows;
  legacyColumns = Object.fromEntries(rows.map(r => [r.id, r.r]));
  const run = runInitDb(s, { MIGRATION_BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: tempDir('esign-up-backups') });
  expect(run.status, run.stderr).toBe(0);
});

describe('migration 0020 on a v0.1.0 installation', () => {
  it('leaves every hash-covered column of the five signatures byte-identical (the guard stays on afterwards)', async () => {
    const rows = (await s.pool.query(`SELECT id, ${LEGACY_ROW} AS r FROM signatures ORDER BY id`)).rows;
    expect(rows).toHaveLength(5);
    expect(Object.fromEntries(rows.map(r => [r.id, r.r]))).toEqual(legacyColumns);
    await expect(s.pool.query(`UPDATE signatures SET signer_name = 'tamper'`)).rejects.toThrow(/not permitted/);
    await expect(s.pool.query(`DELETE FROM signatures`)).rejects.toThrow(/not permitted/);
  });

  it('binds each signature to the record it signed, from its audit entry, and falls back to the sample', async () => {
    const rows = (await s.pool.query('SELECT id, entity_type, entity_id, hash_version, auth_method FROM signatures ORDER BY id')).rows;
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(by['sig-7d8aaf8559f8097d']).toMatchObject({ entity_type: 'Sample', entity_id: 'SMP-2026-00004', hash_version: 1, auth_method: 'password' });
    expect(by['sig-a998fb35a28b73fb']).toMatchObject({ entity_type: 'Sample', entity_id: 'SMP-2026-00004' });
    expect(by['SIG-ELN-395C49EB']).toMatchObject({ entity_type: 'LabNotebook', entity_id: 'ELN-4BB7F906' });
    expect(by['SIG-REL-F284342F']).toMatchObject({ entity_type: 'BatchRelease', entity_id: 'B-FIX-1' });
    expect(by['SIG-O5PMSUG9Y']).toMatchObject({ entity_type: 'Sample', entity_id: 'SMP-2026-00005' }); // no audit entry: the sample it was written against
  });

  it('gives each a meaning code where the text is one the product used, and leaves free text uncoded', async () => {
    const rows = (await s.pool.query('SELECT id, meaning, meaning_code FROM signatures ORDER BY id')).rows;
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(by['sig-7d8aaf8559f8097d'].meaning_code).toBe('SUBMIT_FOR_REVIEW');
    expect(by['sig-a998fb35a28b73fb'].meaning_code).toBe('APPROVAL');
    expect(by['SIG-REL-F284342F'].meaning_code).toBe('BATCH_RELEASE');
    expect(by['SIG-O5PMSUG9Y'].meaning_code).toBe('AUTHORSHIP');
    expect(by['SIG-ELN-395C49EB'].meaning).toBe('Authorship'); // the original text is kept as written
  });

  it('snapshots the signer from the user record as it stands at the upgrade', async () => {
    const rows = (await s.pool.query(`SELECT s.id, s.signer_name, s.signer_role, u.name, u.role FROM signatures s JOIN users u ON u.id = s.signer_id`)).rows;
    expect(rows).toHaveLength(5);
    for (const r of rows) expect({ n: r.signer_name, role: r.signer_role }).toEqual({ n: r.name, role: r.role });
  });

  it('creates the catalog', async () => {
    expect((await s.pool.query('SELECT count(*)::int AS n FROM signature_meanings')).rows[0].n).toBeGreaterThanOrEqual(12);
  });
});

describe('verification of the v0.1.0 signatures after the upgrade', () => {
  let request: ReturnType<typeof supertest>;
  let auth: { Authorization: string };
  beforeAll(async () => {
    Object.assign(process.env, s.env); // src/db/index reads SQL_* once, at first import
    const { createApp } = await import('../../src/server/app');
    const { db } = await import('../../src/db/index');
    request = supertest(createApp({ db, rateLimit: false }));
    const login = await request.post('/api/auth/login-local').send({ email: 'qa@gxp.com', password: 'password' });
    expect(login.status, stamp(login.body)).toBe(200);
    auth = { Authorization: `Bearer ${login.body.token}` };
  });

  const verify = async (id: string) => (await request.get(`/api/signatures/verify/${id}`).set(auth)).body;

  it('the two sample transitions and the ELN signature are recomputed and match', async () => {
    for (const id of ['sig-7d8aaf8559f8097d', 'sig-a998fb35a28b73fb', 'SIG-ELN-395C49EB']) {
      expect(await verify(id), id).toMatchObject({ valid: true, contentHashMatches: true, chainIntact: true, status: 'valid' });
    }
  });

  it("the batch release and the 'N/A' observation are legacy-unverifiable, not valid", async () => {
    for (const id of ['SIG-REL-F284342F', 'SIG-O5PMSUG9Y']) {
      expect(await verify(id), id).toMatchObject({ valid: false, contentHashMatches: null, status: 'legacy-unverifiable' });
    }
  });

  it('an ELN worksheet altered after the upgrade is caught', async () => {
    await s.pool.query(`UPDATE lab_notebook SET content = content || ' (edited)' WHERE id = 'ELN-4BB7F906'`);
    expect(await verify('SIG-ELN-395C49EB')).toMatchObject({ valid: false, contentHashMatches: false, status: 'record-modified' });
  });
});
