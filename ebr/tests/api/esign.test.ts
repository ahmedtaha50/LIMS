import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditOf } from '../../server/audit/index.js';
import { withTx } from '../../server/core/db.js';
import { HttpError } from '../../server/core/errors.js';
import { assertDifferentPerson, isValid, MEANINGS, sign, signaturesOf, type PasswordCheck } from '../../server/esign/index.js';
import { migrate } from '../../server/migrate/runner.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeAll(async () => { db = await freshDatabase('esign'); await migrate(db.pool, MIGRATIONS); });
afterAll(async () => { await db.drop(); });
const check: PasswordCheck = async (_u, pw) => pw === 'correct horse battery';
const signer = { userId: 'u-qa', username: 'qa1', displayName: 'QA One' };
const record = { batch: 'B-001', step: 3, value: 12.5 };

describe('electronic signatures (E04)', () => {
  it('E04#1: a signature records signer, meaning, server time and the record version; it is audited', async () => {
    const s = await withTx(db.pool, (c) => sign(c, db.pool, check, { signer, password: 'correct horse battery', meaning: 'approved', entity: 'mbr', entityId: 'M1', recordVersion: 2, record }));
    expect(s).toMatchObject({ signerId: 'u-qa', signerName: 'QA One', meaning: 'approved', recordVersion: 2 });
    expect(Math.abs(Date.parse(s.signedAt) - Date.now())).toBeLessThan(60_000);
    expect((await signaturesOf(db.pool, 'mbr', 'M1')).length).toBe(1);
    expect((await auditOf(db.pool, 'mbr', 'M1')).map(e => e.action)).toEqual(['esign.signed']);
  });

  it('E04#1: a wrong password is refused, nothing is signed, and the attempt is audited although the signing rolled back', async () => {
    const err = await withTx(db.pool, (c) => sign(c, db.pool, check, { signer, password: 'wrong', meaning: 'approved', entity: 'mbr', entityId: 'M2', recordVersion: 1, record })).catch(e => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(await signaturesOf(db.pool, 'mbr', 'M2')).toEqual([]);
    expect((await auditOf(db.pool, 'mbr', 'M2')).map(e => e.action)).toEqual(['esign.refused']);
  });

  it('E04#2: a record changed after signing shows the signature as invalid', async () => {
    const [s] = await signaturesOf(db.pool, 'mbr', 'M1');
    expect(isValid(s!, { version: 2, record })).toBe(true);
    expect(isValid(s!, { version: 2, record: { ...record, value: 12.6 } })).toBe(false);
    expect(isValid(s!, { version: 3, record })).toBe(false);
    expect(isValid(s!, { version: 2, record: { value: 12.5, step: 3, batch: 'B-001' } })).toBe(true);
  });

  it('E04#3: the verifier cannot be the performer (server-side check)', () => {
    expect(() => assertDifferentPerson('u1', 'u1')).toThrow(/different person/);
    expect(() => assertDifferentPerson('u1', 'u2')).not.toThrow();
  });

  it('an unknown meaning is refused, and signatures cannot be changed afterwards', async () => {
    await expect(withTx(db.pool, (c) => sign(c, db.pool, check, { signer, password: 'correct horse battery', meaning: 'liked' as never, entity: 'mbr', entityId: 'M3', recordVersion: 1, record }))).rejects.toThrow(/Unknown signature meaning/);
    await expect(db.pool.query("UPDATE signatures SET meaning = 'reviewed'")).rejects.toThrow(/permanent/);
    await expect(db.pool.query('DELETE FROM signatures')).rejects.toThrow(/permanent/);
  });

  it('the meanings catalogue has 9 entries (a new meaning is a deliberate change of this number)', () => {
    expect(MEANINGS.length).toBe(9);
  });
});
