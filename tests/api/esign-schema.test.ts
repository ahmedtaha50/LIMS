/**
 * Roadmap M07 (r1-esign), schema level: the signatures table binds to any record, not only to a sample, and the meaning of a
 * signature comes from a catalog. Runs on a database built from the migrations by the product's installer.
 *
 * The defect behind it: signatures.sample_id was NOT NULL with a foreign key to samples, but a specification approval wrote the
 * specification id into it (and the ELN and the batch release wrote their own ids), so a fresh installation could not approve a
 * specification and therefore could not register a sample.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

let db: TestDb;
beforeAll(async () => { db = await useTestDb(); });

const sql = (text: string, params: unknown[] = []) => db.pool.query(text, params);
let seq = 0;
const sigId = () => `sig-schema-${process.pid}-${++seq}`;

/** Every column of a v2 row; override what a test wants to break. */
function v2(over: Record<string, unknown> = {}) {
  return {
    id: sigId(), sample_id: null, signer_id: 'usr-qa', meaning: 'Master Data Approval: I approve this specification for use.', reason: 'because',
    record_version: 2, content_hash: 'a'.repeat(64), audit_entry_id: 'adt-x', entity_type: 'Specification', entity_id: 'SPEC-1',
    meaning_code: 'SPECIFICATION_APPROVAL', signer_name: 'Test QA Officer', signer_role: 'QA', auth_method: 'password', hash_version: 2, ...over,
  };
}
async function insertSignature(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await sql(`INSERT INTO signatures (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(c => row[c]));
}

describe('signatures: polymorphic binding', () => {
  it('has the new columns and no longer requires a sample', async () => {
    const cols = (await sql(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'signatures'`)).rows;
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c.is_nullable]));
    for (const c of ['entity_type', 'entity_id', 'meaning_code', 'signer_name', 'signer_role', 'auth_method', 'hash_version']) expect(byName, c).toHaveProperty(c);
    expect(byName.sample_id).toBe('YES');
  });

  it('accepts a signature on a specification: sample_id null, entity_type Specification (the fresh-install defect)', async () => {
    const row = v2();
    await insertSignature(row);
    const back = (await sql('SELECT entity_type, entity_id, sample_id, hash_version FROM signatures WHERE id = $1', [row.id])).rows[0];
    expect(back).toMatchObject({ entity_type: 'Specification', entity_id: 'SPEC-1', sample_id: null, hash_version: 2 });
  });

  it('keeps the foreign key: a sample id that is not a sample is still refused', async () => {
    await expect(insertSignature(v2({ sample_id: 'SPEC-1' }))).rejects.toThrow(/foreign key|violates/i);
  });

  it('refuses a version 2 row that lacks its binding, snapshot or meaning', async () => {
    for (const missing of ['entity_type', 'entity_id', 'meaning_code', 'signer_name', 'signer_role', 'auth_method']) {
      await expect(insertSignature(v2({ [missing]: null })), missing).rejects.toThrow(/signatures_v2_complete|null value|check/i);
    }
  });

  it('refuses a meaning code that is not in the catalog', async () => {
    await expect(insertSignature(v2({ meaning_code: 'MADE_UP' }))).rejects.toThrow(/foreign key|violates/i);
  });

  it('still accepts the row shape that the not-yet-migrated signing routes write (hash_version defaults to 1, binding columns null)', async () => {
    const id = sigId();
    // A fresh template holds no sample: insert one so the legacy shape (sample_id set, none of the new columns) can be tried.
    await sql(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ('SMP-SCHEMA-1', 'm', 'b', 'Logged', 'usr-analyst1') ON CONFLICT DO NOTHING`);
    await sql(
      `INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id)
       VALUES ($1, 'SMP-SCHEMA-1', 'usr-qa', 'Approval (Release Disposition)', 'r', 1, 'h', 'adt-y')`, [id]);
    const back = (await sql('SELECT hash_version, entity_type FROM signatures WHERE id = $1', [id])).rows[0];
    expect(back).toMatchObject({ hash_version: 1, entity_type: null });
  });
});

describe('signatures: stays append-only', () => {
  it('refuses UPDATE, DELETE and TRUNCATE, new columns included', async () => {
    const row = v2();
    await insertSignature(row);
    for (const q of [
      `UPDATE signatures SET meaning = 'tamper' WHERE id = '${row.id}'`,
      `UPDATE signatures SET signer_name = 'tamper' WHERE id = '${row.id}'`,
      `UPDATE signatures SET entity_id = 'SPEC-2' WHERE id = '${row.id}'`,
      `DELETE FROM signatures WHERE id = '${row.id}'`,
      'TRUNCATE signatures',
    ]) await expect(sql(q), q).rejects.toThrow(/not permitted/);
  });

  it('keeps the link-once rule: a pending audit link may be set once, nothing else may change with it', async () => {
    const row = v2({ audit_entry_id: 'pending' });
    await insertSignature(row);
    await expect(sql(`UPDATE signatures SET audit_entry_id = 'adt-z', signer_name = 'tamper' WHERE id = $1`, [row.id])).rejects.toThrow(/not permitted/);
    await sql(`UPDATE signatures SET audit_entry_id = 'adt-z' WHERE id = $1`, [row.id]);
    await expect(sql(`UPDATE signatures SET audit_entry_id = 'adt-q' WHERE id = $1`, [row.id])).rejects.toThrow(/not permitted/);
  });
});

describe('signature_meanings: the catalog', () => {
  it('holds the meanings the product signs with, each with a text, the roles that may use it and its flags', async () => {
    const rows = (await sql('SELECT * FROM signature_meanings ORDER BY code')).rows;
    const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
    for (const code of ['AUTHORSHIP', 'SUBMIT_FOR_REVIEW', 'APPROVAL', 'REJECTION', 'OOS_CLOSURE', 'SPECIFICATION_APPROVAL', 'BATCH_RELEASE',
      'CALIBRATION', 'RECEIPT', 'TRAINING_ACKNOWLEDGEMENT', 'TRAINING_CERTIFICATION', 'ADMIN_AUTHORISATION']) {
      expect(byCode, code).toHaveProperty(code);
      expect(byCode[code].text.length, code).toBeGreaterThan(15);
      expect(byCode[code].allowed_roles.length, code).toBeGreaterThan(0);
      expect(byCode[code].active, code).toBe(true);
    }
    expect(byCode.REJECTION.requires_reason).toBe(true);
    expect(byCode.OOS_CLOSURE.requires_reason).toBe(true);
    expect(byCode.APPROVAL.requires_reason).toBe(false);
  });

  it('exempts from the software-training requirement only the meanings that grant or acknowledge that training (and administrator authorisation)', async () => {
    const exempt = (await sql('SELECT code FROM signature_meanings WHERE training_exempt ORDER BY code')).rows.map(r => r.code);
    expect(exempt).toEqual(['ADMIN_AUTHORISATION', 'TRAINING_ACKNOWLEDGEMENT', 'TRAINING_CERTIFICATION']);
  });

  it('gives the roles in the catalog only the four roles of the product', async () => {
    const roles = new Set((await sql('SELECT unnest(allowed_roles) AS r FROM signature_meanings')).rows.map(r => r.r));
    expect([...roles].every(r => ['Admin', 'QA', 'Reviewer', 'Analyst'].includes(r))).toBe(true);
  });
});
