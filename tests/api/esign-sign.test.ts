/**
 * Roadmap M07 (r1-esign): the signRecord service, against the real application database.
 *
 *   * one signing test per entity type (gxpRisk of M07), each followed by the verification of what it wrote, and by a change
 *     of the signed record that the verification must catch;
 *   * wrong credentials on any entity type: three SignatureFailed audit rows and a persisted lock, whatever the caller then does;
 *   * the checks that come before the password (role, lock, training, reason) and the TOTP step-up;
 *   * the meaning comes from the catalog, the signer's name and role are snapshots, audit and signature commit together.
 *
 * The signing routes of the other tracks (specifications, OOS, ELN, release, calibration, reagents, training) still use their own
 * code and move to signRecord in their own tracks. `reference route` below is the specification approval written on signRecord,
 * to show what those routes will do over HTTP; it is test code, not a product route.
 */
import express from 'express';
import { generateSync } from 'otplib';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
let esign: typeof import('../../src/server/esign');
let tables: typeof import('../../src/db/schema');
let tx: typeof import('../../src/server/core/tx');
let appDb: typeof import('../../src/db/index')['db'];

beforeAll(async () => {
  t = await startTestApp();
  esign = await import('../../src/server/esign');
  tables = await import('../../src/db/schema');
  tx = await import('../../src/server/core/tx');
  appDb = (await import('../../src/db/index')).db;
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});

const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params);
const one = async (text: string, params: unknown[] = []) => (await sql(text, params)).rows[0];
let seq = 0;

async function newUser(role: string, over: { trained?: boolean; totpSecret?: string } = {}) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-es${process.pid}-${n}`;
  await sql(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training, totp_secret, totp_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, `uid-${id}`, `Signer ${n}`, role, `es${process.pid}.${n}@gxp.test`, generatePasswordHash(TEST_PASSWORD), over.trained ?? true, over.totpSecret ?? null, !!over.totpSecret],
  );
  return { id, email: `es${process.pid}.${n}@gxp.test` };
}

const verify = async (id: string) => {
  const h = await t.auth('qa@gxp.com');
  return t.request.get(`/api/signatures/verify/${id}`).set(h);
};
const failedAudits = async (entityId: string) => (await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND entity_id = $1`, [entityId])).n as number;

/** One signing case per entity type: how to arrange the record, the change the signature belongs to, and how to alter the record afterwards. */
interface Case {
  entityType: string;
  meaningCode: string;
  signerRole: string;
  reason?: string;
  /** Creates the record; returns its id (as the signature will carry it) and whatever execute needs. */
  arrange(): Promise<{ entityId: string; sampleId?: string; ctx?: any }>;
  /** The change the signature belongs to, run inside the signing transaction. */
  change(x: Awaited<ReturnType<Case['arrange']>>, db: any): Promise<{ recordVersion: number; audit: { action: string; field: string; oldValue: string; newValue: string; reason: string } }>;
  /** SQL ($1 = entity id) that alters the signed content afterwards; null where the signature binds an event, which the audit chain protects. */
  tamper: string | null;
}

const cases: Case[] = [
  {
    entityType: 'Sample', meaningCode: 'SUBMIT_FOR_REVIEW', signerRole: 'Analyst',
    arrange: async () => { const s = await registerSample(t); return { entityId: s.id, sampleId: s.id, ctx: { version: s.version } }; },
    change: async (x, db) => {
      const row = await tx.updateVersioned(db, tables.samples, x.entityId, x.ctx.version, { state: 'Pending Review' });
      return { recordVersion: row.version, audit: { action: 'Transition', field: 'state', oldValue: 'Logged', newValue: 'Pending Review', reason: 'Transition via review' } };
    },
    tamper: `UPDATE samples SET batch = 'Tampered batch' WHERE id = $1`,
  },
  {
    entityType: 'OOS', meaningCode: 'OOS_CLOSURE', signerRole: 'QA', reason: 'Root cause confirmed, CAPA agreed',
    arrange: async () => {
      const s = await registerSample(t);
      const id = uniq('OOS');
      await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Assay (%)', '2026-01-02', 'Open')`, [id, s.id, s.result.id]);
      return { entityId: id, sampleId: s.id };
    },
    change: async (x, db) => {
      const row = await tx.updateVersioned(db, tables.oosInvestigations, x.entityId, 1, { status: 'Approved', rootCause: 'Dilution error', conclusion: 'Repeat the test' });
      return { recordVersion: row.version, audit: { action: 'Close OOS', field: 'status', oldValue: 'Open', newValue: 'Approved', reason: 'Root Cause: Dilution error | CAPA: Repeat the test' } };
    },
    tamper: `UPDATE oos_investigations SET conclusion = 'Nothing to do' WHERE id = $1`,
  },
  {
    entityType: 'Specification', meaningCode: 'SPECIFICATION_APPROVAL', signerRole: 'QA',
    arrange: async () => {
      const res = await t.request.post('/api/specifications').set(await t.auth('qa@gxp.com')).send({ material: uniq('Mat'), effectiveDate: '2026-01-01' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await sql(`UPDATE specifications SET parameters = '[{"name":"Assay (%)","min":98,"max":102}]'::jsonb WHERE id = $1`, [res.body.id]);
      return { entityId: res.body.id as string };
    },
    change: async (x, db) => {
      const row = await tx.updateVersioned(db, tables.specifications, x.entityId, 1, { status: 'Active' });
      return { recordVersion: row.version, audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Active', reason: 'Specification approved for use' } };
    },
    tamper: `UPDATE specifications SET effective_date = '2030-01-01' WHERE id = $1`,
  },
  {
    entityType: 'LabNotebook', meaningCode: 'AUTHORSHIP', signerRole: 'Analyst',
    arrange: async () => {
      const res = await t.request.post('/api/eln').set(await t.auth('analyst1@gxp.com')).send({ title: uniq('Worksheet'), content: 'Weighed 10.00 g.' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { entityId: res.body.id as string };
    },
    change: async (x, db) => {
      const row = await tx.updateVersioned(db, tables.labNotebook, x.entityId, 1, { status: 'Signed', locked: true, signedAt: new Date(), signedBy: 'usr-analyst1' });
      return { recordVersion: row.version, audit: { action: 'SIGN_ELN_ENTRY', field: 'status', oldValue: 'Draft', newValue: 'Signed', reason: 'Worksheet execution complete and verified per SOP' } };
    },
    tamper: `UPDATE lab_notebook SET content = 'Weighed 12.00 g.' WHERE id = $1`,
  },
  {
    entityType: 'BatchRelease', meaningCode: 'BATCH_RELEASE', signerRole: 'QA',
    arrange: async () => {
      const batch = uniq('B-REL');
      await sql(`INSERT INTO batch_releases (id, batch, status) VALUES ($1, $2, 'Quarantine Hold')`, [uniq('BR'), batch]);
      return { entityId: batch };
    },
    change: async (x, db) => {
      const [row] = await db.update(tables.batchReleases).set({ status: 'Released', releasedBy: 'usr-qa', releasedAt: new Date(), dispositionRecommendation: 'Meets specification', version: 2 })
        .where((await import('drizzle-orm')).eq(tables.batchReleases.batch, x.entityId)).returning();
      return { recordVersion: row.version, audit: { action: 'Release', field: 'status', oldValue: 'Quarantine Hold', newValue: 'Released', reason: 'QP release authorisation' } };
    },
    tamper: `UPDATE batch_releases SET disposition_recommendation = 'Released regardless' WHERE batch = $1`,
  },
  {
    entityType: 'Instrument', meaningCode: 'CALIBRATION', signerRole: 'Analyst',
    arrange: async () => {
      const id = uniq('INS');
      await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC 1', 'HPLC', 'Out of Service', '2025-12-01', '2025-06-01')`, [id]);
      return { entityId: id };
    },
    change: async (x, db) => {
      await db.update(tables.instruments).set({ status: 'Active', calibrationDueDate: '2027-01-01', lastCalibrationDate: '2026-01-01' })
        .where((await import('drizzle-orm')).eq(tables.instruments.id, x.entityId));
      return { recordVersion: 1, audit: { action: 'Calibrate', field: 'calibrationDueDate', oldValue: '2025-12-01', newValue: '2027-01-01', reason: 'Routine Calibration Logged' } };
    },
    tamper: null,
  },
  {
    entityType: 'Reagent', meaningCode: 'RECEIPT', signerRole: 'Analyst',
    arrange: async () => {
      const id = uniq('RGT');
      await sql(`INSERT INTO reagents (id, name, lot_number, expiry_date, status, quantity) VALUES ($1, 'Acetonitrile', 'LOT-1', '2027-01-01', 'Quarantine', '2.5 L')`, [id]);
      return { entityId: id };
    },
    change: async (x, db) => {
      await db.update(tables.reagents).set({ status: 'Available' }).where((await import('drizzle-orm')).eq(tables.reagents.id, x.entityId));
      return { recordVersion: 1, audit: { action: 'Receive', field: 'status', oldValue: 'Quarantine', newValue: 'Available', reason: 'Received and checked against the certificate' } };
    },
    tamper: null,
  },
  {
    entityType: 'User', meaningCode: 'TRAINING_CERTIFICATION', signerRole: 'QA',
    arrange: async () => { const u = await newUser('Analyst', { trained: false }); return { entityId: u.id }; },
    change: async (x, db) => {
      const target = await tx.lockRow(db, tables.users, x.entityId);
      const row = await tx.updateVersioned(db, tables.users, x.entityId, target.version, { hasCompletedSoftwareTraining: true });
      return { recordVersion: row.version, audit: { action: 'Certify', field: 'hasCompletedSoftwareTraining', oldValue: 'false', newValue: 'true', reason: 'Training certified: Software Training' } };
    },
    tamper: null,
  },
];

async function sign(c: Case, x: Awaited<ReturnType<Case['arrange']>>, signerId: string, over: Record<string, unknown> = {}) {
  return esign.signRecord({
    db: appDb, user: { id: signerId }, meaningCode: c.meaningCode, credentials: { password: TEST_PASSWORD },
    reason: c.reason, entityType: c.entityType, entityId: x.entityId, sampleId: x.sampleId,
    execute: async (txn: any) => ({ ...(await c.change(x, txn)), result: { ok: true } }),
    ...over,
  } as any);
}

describe('signRecord: one signing per entity type', () => {
  describe.each(cases)('$entityType', (c) => {
    it('writes the audit entry and the signature together, with the meaning from the catalog and a snapshot of the signer', async () => {
      const x = await c.arrange();
      const signer = await newUser(c.signerRole);
      const out = await sign(c, x, signer.id);
      expect(out.result).toEqual({ ok: true });

      const row = await one('SELECT * FROM signatures WHERE id = $1', [out.signature.id]);
      expect(row).toMatchObject({
        entity_type: c.entityType, entity_id: x.entityId, meaning_code: c.meaningCode, signer_id: signer.id, signer_name: expect.stringMatching(/^Signer \d+$/),
        signer_role: c.signerRole, auth_method: 'password', hash_version: 2, sample_id: x.sampleId ?? null,
      });
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
      const meaning = await one('SELECT text FROM signature_meanings WHERE code = $1', [c.meaningCode]);
      expect(row.meaning).toBe(meaning.text);

      const audit = await one('SELECT * FROM audit_trail WHERE id = $1', [row.audit_entry_id]);
      expect(audit).toMatchObject({ entity: c.entityType, entity_id: x.entityId, user_id: signer.id });
      const same = await one(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = $1 AND entity_id = $2 AND action = $3`, [c.entityType, x.entityId, audit.action]);
      expect(same.n).toBe(1); // one entry for the change and its signature, not two
      expect(out.signature).toMatchObject({ id: row.id, entityType: c.entityType, entityId: x.entityId, meaningCode: c.meaningCode, meaning: meaning.text, signerName: row.signer_name, signerRole: c.signerRole, recordVersion: row.record_version });
    });

    it('verifies as valid with the hash recomputed from the record', async () => {
      const x = await c.arrange();
      const signer = await newUser(c.signerRole);
      const out = await sign(c, x, signer.id);
      const res = await verify(out.signature.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: true, contentHashMatches: true, chainIntact: true, status: 'valid', entityType: c.entityType, entityId: x.entityId });
    });

    if (c.tamper) {
      it('is no longer valid once the signed record is altered in SQL', async () => {
        const x = await c.arrange();
        const signer = await newUser(c.signerRole);
        const out = await sign(c, x, signer.id);
        await sql(c.tamper!, [x.entityId]);
        const res = await verify(out.signature.id);
        expect(res.body).toMatchObject({ valid: false, contentHashMatches: false, status: 'record-modified' });
      });
    } else {
      it('binds an event: the audit chain is what protects it, and a broken chain makes it invalid', async () => {
        const x = await c.arrange();
        const signer = await newUser(c.signerRole);
        const out = await sign(c, x, signer.id);
        const entryId = (await one('SELECT audit_entry_id FROM signatures WHERE id = $1', [out.signature.id])).audit_entry_id as string;
        const original = (await one('SELECT new_value FROM audit_trail WHERE id = $1', [entryId])).new_value as string;
        await sql('ALTER TABLE audit_trail DISABLE TRIGGER USER');
        try {
          await sql(`UPDATE audit_trail SET new_value = 'altered' WHERE id = $1`, [entryId]);
          const res = await verify(out.signature.id);
          expect(res.body).toMatchObject({ valid: false });
          expect(['chain-broken', 'record-modified']).toContain(res.body.status);
        } finally {
          await sql('UPDATE audit_trail SET new_value = $2 WHERE id = $1', [entryId, original]);
          await sql('ALTER TABLE audit_trail ENABLE TRIGGER USER');
        }
        expect((await verify(out.signature.id)).body.valid).toBe(true);
      });
    }

    it('wrong password three times: three SignatureFailed entries, a persisted lock, and the change never ran', async () => {
      const x = await c.arrange();
      const signer = await newUser(c.signerRole);
      let ran = 0;
      const attempt = (password: string) => sign(c, x, signer.id, { credentials: { password }, execute: async () => { ran++; throw new Error('must not run'); } });

      for (let i = 1; i <= 3; i++) {
        await expect(attempt('wrong-password')).rejects.toMatchObject({ status: 401, code: 'INVALID_PASSWORD' });
        expect(await failedAudits(x.entityId), `after attempt ${i}`).toBe(i);
      }
      const u = await one('SELECT failed_attempts, locked_at FROM users WHERE id = $1', [signer.id]);
      expect(u.failed_attempts).toBe(3);
      expect(new Date(u.locked_at).getTime()).toBeGreaterThan(Date.now());

      await expect(attempt(TEST_PASSWORD)).rejects.toMatchObject({ status: 401, code: 'SIGNING_LOCKED' });
      expect(ran).toBe(0);
      expect(await failedAudits(x.entityId)).toBe(3); // a refused attempt on a locked account adds no fourth entry

      const login = await t.request.post('/api/auth/login-local').send({ email: (await one('SELECT email FROM users WHERE id = $1', [signer.id])).email, password: TEST_PASSWORD });
      expect(login.status, 'the signing lock must not become a sign-in lock').toBe(200);
    });
  });
});

describe('signRecord: the signing lock', () => {
  const spec = cases.find(c => c.entityType === 'Specification')!;

  it('ends by itself, clears the count on the next success, and signs', async () => {
    const x = await spec.arrange();
    const signer = await newUser('QA');
    for (let i = 0; i < 3; i++) await sign(spec, x, signer.id, { credentials: { password: 'nope' } }).catch(() => undefined);
    await sql(`UPDATE users SET locked_at = now() - interval '1 minute' WHERE id = $1`, [signer.id]);
    const out = await sign(spec, x, signer.id);
    expect(out.signature.id).toBeTruthy();
    expect(await one('SELECT failed_attempts, locked_at FROM users WHERE id = $1', [signer.id])).toMatchObject({ failed_attempts: 0, locked_at: null });
  });

  it('counts exactly when three wrong passwords arrive at the same moment', async () => {
    const x = await spec.arrange();
    const signer = await newUser('QA');
    const results = await Promise.allSettled([1, 2, 3].map(() => sign(spec, x, signer.id, { credentials: { password: 'nope' } })));
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(await failedAudits(x.entityId)).toBe(3);
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [signer.id])).failed_attempts).toBe(3);
  });

  it('a right password after two wrong ones starts the count again', async () => {
    const x = await spec.arrange();
    const signer = await newUser('QA');
    for (let i = 0; i < 2; i++) await sign(spec, x, signer.id, { credentials: { password: 'nope' } }).catch(() => undefined);
    await sign(spec, x, signer.id);
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [signer.id])).failed_attempts).toBe(0);
  });
});

describe('signRecord: checks that come before the password', () => {
  const oos = cases.find(c => c.entityType === 'OOS')!;
  const spec = cases.find(c => c.entityType === 'Specification')!;

  it('refuses a role the meaning is not for, without counting a failure or writing anything', async () => {
    const x = await oos.arrange();
    const analyst = await newUser('Analyst');
    let ran = false;
    await expect(sign(oos, x, analyst.id, { execute: async () => { ran = true; throw new Error('x'); } })).rejects.toMatchObject({ status: 403, code: 'ROLE_NOT_ALLOWED' });
    expect(ran).toBe(false);
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [analyst.id])).failed_attempts).toBe(0);
    expect(await failedAudits(x.entityId)).toBe(0);
  });

  it('refuses a user without software training for an ordinary meaning, before the password is looked at', async () => {
    const x = await spec.arrange();
    const untrained = await newUser('QA', { trained: false });
    await expect(sign(spec, x, untrained.id, { credentials: { password: 'wrong' } })).rejects.toMatchObject({ status: 403, code: 'TRAINING_REQUIRED' });
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [untrained.id])).failed_attempts).toBe(0);
  });

  it('lets a user without training sign the training meanings themselves (the exemption belongs to the meaning, not to a flag the caller passes)', async () => {
    const untrained = await newUser('Analyst', { trained: false });
    const out = await esign.signRecord({
      db: appDb, user: { id: untrained.id }, meaningCode: 'TRAINING_ACKNOWLEDGEMENT', credentials: { password: TEST_PASSWORD },
      entityType: 'User', entityId: untrained.id,
      execute: async () => ({ recordVersion: 1, audit: { action: 'Acknowledge', field: 'training', oldValue: '', newValue: 'Software Training read and understood', reason: 'Training read and understood' }, result: null }),
    });
    expect(out.signature.meaningCode).toBe('TRAINING_ACKNOWLEDGEMENT');
    expect((await one('SELECT meaning_code, signer_role FROM signatures WHERE id = $1', [out.signature.id]))).toMatchObject({ meaning_code: 'TRAINING_ACKNOWLEDGEMENT', signer_role: 'Analyst' });
  });

  it('needs a reason for a meaning that requires one (OOS closure)', async () => {
    const x = await oos.arrange();
    const qa = await newUser('QA');
    for (const reason of [undefined, '', '  ', 'abc']) {
      await expect(sign(oos, x, qa.id, { reason }), `reason ${JSON.stringify(reason)}`).rejects.toMatchObject({ status: 400, code: 'REASON_REQUIRED' });
    }
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).failed_attempts).toBe(0);
  });

  it('refuses an inactive or deleted signer', async () => {
    const x = await spec.arrange();
    const gone = await newUser('QA');
    await sql('UPDATE users SET active = false WHERE id = $1', [gone.id]);
    await expect(sign(spec, x, gone.id)).rejects.toMatchObject({ status: 401, code: 'USER_INACTIVE' });
    await expect(sign(spec, x, 'usr-does-not-exist')).rejects.toMatchObject({ status: 401 });
  });
});

describe('signRecord: TOTP step-up', () => {
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const spec = cases.find(c => c.entityType === 'Specification')!;
  const code = (steps = 0) => generateSync({ secret: SECRET, epoch: Math.floor(Date.now() / 1000) + steps * 30 });

  it('asks a user with an authenticator for the code, without counting that as a failure', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA', { totpSecret: SECRET });
    let ran = false;
    await expect(sign(spec, x, qa.id, { execute: async () => { ran = true; throw new Error('x'); } })).rejects.toMatchObject({ status: 401, code: 'MFA_CODE_REQUIRED' });
    expect(ran).toBe(false);
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).failed_attempts).toBe(0);
    expect(await failedAudits(x.entityId)).toBe(0);
  });

  it('counts a wrong code as a failed signature, audited like a wrong password', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA', { totpSecret: SECRET });
    await expect(sign(spec, x, qa.id, { credentials: { password: TEST_PASSWORD, totpCode: '000000' } })).rejects.toMatchObject({ status: 401, code: 'INVALID_CODE' });
    expect(await failedAudits(x.entityId)).toBe(1);
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).failed_attempts).toBe(1);
  });

  it('signs with password and code, records the method, and refuses the same code a second time', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA', { totpSecret: SECRET });
    const out = await sign(spec, x, qa.id, { credentials: { password: TEST_PASSWORD, totpCode: code() } });
    expect((await one('SELECT auth_method FROM signatures WHERE id = $1', [out.signature.id])).auth_method).toBe('password+totp');

    const y = await spec.arrange();
    await expect(sign(spec, y, qa.id, { credentials: { password: TEST_PASSWORD, totpCode: code() } })).rejects.toMatchObject({ status: 401, code: 'INVALID_CODE' });
    // The next 30-second step is accepted.
    const next = await sign(spec, y, qa.id, { credentials: { password: TEST_PASSWORD, totpCode: code(1) } });
    expect(next.signature.id).toBeTruthy();
  });

  it('a right code does not rescue a wrong password', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA', { totpSecret: SECRET });
    await expect(sign(spec, x, qa.id, { credentials: { password: 'wrong', totpCode: code(-1) } })).rejects.toMatchObject({ status: 401, code: 'INVALID_PASSWORD' });
    expect(await failedAudits(x.entityId)).toBe(1);
  });
});

describe('signRecord: the meaning and the signer snapshot', () => {
  const spec = cases.find(c => c.entityType === 'Specification')!;

  it('ignores a meaning text supplied by the caller: the stored text is the catalog text for the code', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA');
    const out = await sign(spec, x, qa.id, { meaning: 'I approve everything, always', meaningText: 'Forged' });
    const catalog = await one(`SELECT text FROM signature_meanings WHERE code = 'SPECIFICATION_APPROVAL'`);
    expect(out.signature.meaning).toBe(catalog.text);
    expect((await one('SELECT meaning FROM signatures WHERE id = $1', [out.signature.id])).meaning).toBe(catalog.text);
  });

  it('refuses a meaning code that is not in the catalog or not active, without counting a failure', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA');
    await expect(sign(spec, x, qa.id, { meaningCode: 'MADE_UP' })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_MEANING' });
    await sql(`UPDATE signature_meanings SET active = false WHERE code = 'SPECIFICATION_APPROVAL'`);
    try {
      await expect(sign(spec, x, qa.id)).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_MEANING' });
    } finally {
      await sql(`UPDATE signature_meanings SET active = true WHERE code = 'SPECIFICATION_APPROVAL'`);
    }
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).failed_attempts).toBe(0);
  });

  it('refuses to register a record type twice or under an invalid name: what a type signs cannot be swapped silently', () => {
    expect(() => esign.registerSignable({ type: 'Sample', canonical: async () => ({}) })).toThrow(/already registered/);
    expect(() => esign.registerSignable({ type: 'not a name', canonical: async () => ({}) })).toThrow(/not a valid record type/);
    expect(esign.signableTypes()).toEqual(expect.arrayContaining(['Sample', 'OOS', 'Specification', 'LabNotebook', 'BatchRelease', 'Instrument', 'Reagent', 'User']));
  });

  it('refuses an entity type nobody registered', async () => {
    const qa = await newUser('QA');
    await expect(esign.signRecord({
      db: appDb, user: { id: qa.id }, meaningCode: 'APPROVAL', credentials: { password: TEST_PASSWORD }, entityType: 'Spaceship', entityId: 'X-1',
      execute: async () => ({ recordVersion: 1, audit: { action: 'A', field: 'f', oldValue: '', newValue: '', reason: 'r' }, result: null }),
    })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_ENTITY_TYPE' });
  });

  it('renaming the user or changing the role later leaves the old signature as it was, and the next one shows the new name', async () => {
    const x1 = await spec.arrange();
    const qa = await newUser('QA');
    const first = await sign(spec, x1, qa.id);
    const before = (await verify(first.signature.id)).body.signature;
    expect(before).toMatchObject({ signerName: expect.stringMatching(/^Signer \d+$/), signerRole: 'QA' });

    await sql(`UPDATE users SET name = 'Dr. Renamed Person', role = 'Admin' WHERE id = $1`, [qa.id]);
    const after = (await verify(first.signature.id)).body.signature;
    expect(after.signerName).toBe(before.signerName);
    expect(after.signerRole).toBe('QA');
    expect((await verify(first.signature.id)).body.valid).toBe(true);

    const x2 = await spec.arrange();
    const second = await sign(spec, x2, qa.id, { meaningCode: 'SPECIFICATION_APPROVAL' });
    expect((await verify(second.signature.id)).body.signature).toMatchObject({ signerName: 'Dr. Renamed Person', signerRole: 'Admin' });
  });
});

describe('signRecord: all or nothing', () => {
  const spec = cases.find(c => c.entityType === 'Specification')!;

  it('a conflict in the change leaves no audit entry, no signature and no failure count', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA');
    const audits = (await one('SELECT count(*)::int AS n FROM audit_trail')).n;
    await expect(sign(spec, x, qa.id, {
      execute: async (txn: any) => {
        const row = await tx.updateVersioned(txn, tables.specifications, x.entityId, 99, { status: 'Active' }); // stale version
        return { recordVersion: row.version, audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Active', reason: 'r' }, result: null };
      },
    })).rejects.toMatchObject({ status: 409 });
    expect((await one('SELECT count(*)::int AS n FROM audit_trail')).n).toBe(audits);
    expect((await one('SELECT count(*)::int AS n FROM signatures WHERE entity_id = $1', [x.entityId])).n).toBe(0);
    expect((await one('SELECT status FROM specifications WHERE id = $1', [x.entityId])).status).toBe('Draft');
    expect((await one('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).failed_attempts).toBe(0);
  });

  it('if the record cannot be hashed, the change, the audit entry and the signature are all rolled back', async () => {
    esign.registerSignable({ type: 'TestBoom', canonical: async () => { throw new Error('cannot canonicalise'); } });
    const qa = await newUser('QA');
    const key = uniq('boom');
    const audits = (await one('SELECT count(*)::int AS n FROM audit_trail')).n;
    await expect(esign.signRecord({
      db: appDb, user: { id: qa.id }, meaningCode: 'APPROVAL', credentials: { password: TEST_PASSWORD }, entityType: 'TestBoom', entityId: key,
      execute: async (txn: any) => {
        await txn.execute((await import('drizzle-orm')).sql`INSERT INTO counters (key, value) VALUES (${key}, 1)`);
        return { recordVersion: 1, audit: { action: 'Approve', field: 'f', oldValue: '', newValue: 'x', reason: 'r' }, result: null };
      },
    })).rejects.toThrow(/cannot canonicalise/);
    expect((await one('SELECT count(*)::int AS n FROM counters WHERE key = $1', [key])).n).toBe(0);
    expect((await one('SELECT count(*)::int AS n FROM audit_trail')).n).toBe(audits);
  });

  it('runs afterCommit hooks only when the signature committed', async () => {
    const x = await spec.arrange();
    const qa = await newUser('QA');
    const fired: string[] = [];
    await expect(sign(spec, x, qa.id, {
      execute: async (_txn: any, afterCommit: any) => { afterCommit(() => fired.push('rolled-back')); throw new Error('stop'); },
    })).rejects.toThrow('stop');
    const y = await spec.arrange();
    await sign(spec, y, qa.id, { execute: async (txn: any, afterCommit: any) => { afterCommit(() => fired.push('committed')); return { ...(await spec.change(y, txn)), result: null }; } });
    expect(fired).toEqual(['committed']);
  });
});

describe('reference route: the specification approval on signRecord, over HTTP', () => {
  // What the specifications route will look like once r1-spec moves it to signRecord. Test code only.
  let ref: ReturnType<typeof supertest>;
  beforeAll(async () => {
    const { createRequireAuth } = await import('../../src/server/auth/requireAuth');
    const { auditContext } = await import('../../src/server/audit/context');
    const { errorHandler } = await import('../../src/server/http/errors');
    const { validate } = await import('../../src/server/http/validate');
    const { z } = await import('zod');
    const { signatureFields } = await import('../../src/lib/validations/signatures');
    const schema = z.object({ ...signatureFields }).strict();

    const app = express();
    app.use(express.json());
    app.use(auditContext);
    app.post('/specifications/:id/approve', createRequireAuth(appDb), validate(schema), async (req, res, next) => {
      try {
        const id = String(req.params.id);
        const { signature, result } = await esign.signRecord({
          db: appDb, user: (req as any).user, meaningCode: req.body.meaningCode, credentials: { password: req.body.password, totpCode: req.body.totpCode }, reason: req.body.reason,
          entityType: 'Specification', entityId: id,
          execute: async (txn) => {
            const spec = await txn.query.specifications.findFirst({ where: (s, { eq }) => eq(s.id, id) });
            if (!spec) throw new (await import('../../src/server/http/errors')).NotFoundError('Specification not found.');
            const row = await tx.updateVersioned(txn, tables.specifications, id, spec.version, { status: 'Active' });
            return { recordVersion: row.version, audit: { action: 'Approve', field: 'status', oldValue: spec.status, newValue: 'Active', reason: 'Specification approved for use' }, result: row };
          },
        });
        res.json({ ...result, signature });
      } catch (e) { next(e); }
    });
    app.use(errorHandler());
    ref = supertest(app);
  });

  const login = async (email: string) => ({ Authorization: `Bearer ${(await t.request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD })).body.token}` });
  const draftSpec = async () => (await t.request.post('/api/specifications').set(await t.auth('qa@gxp.com')).send({ material: uniq('Mat'), effectiveDate: '2026-01-01' })).body.id as string;

  it('Approving a Draft specification as QA returns 200 with a signature row entity_type = Specification (M07 acceptance)', async () => {
    const qa = await newUser('QA');
    const id = await draftSpec();
    const res = await ref.post(`/specifications/${id}/approve`).set(await login(qa.email)).send({ meaningCode: 'SPECIFICATION_APPROVAL', password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('Active');
    const row = await one(`SELECT entity_type, entity_id, sample_id, meaning_code FROM signatures WHERE entity_id = $1`, [id]);
    expect(row).toMatchObject({ entity_type: 'Specification', entity_id: id, sample_id: null, meaning_code: 'SPECIFICATION_APPROVAL' });
  });

  it('Three wrong passwords leave three SignatureFailed entries and a persisted lock (M07 acceptance)', async () => {
    const qa = await newUser('QA');
    const headers = await login(qa.email);
    const id = await draftSpec();
    for (let i = 0; i < 3; i++) {
      const res = await ref.post(`/specifications/${id}/approve`).set(headers).send({ meaningCode: 'SPECIFICATION_APPROVAL', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_PASSWORD');
    }
    expect(await failedAudits(id)).toBe(3);
    const u = await one('SELECT failed_attempts, locked_at FROM users WHERE id = $1', [qa.id]);
    expect(u.failed_attempts).toBe(3);
    expect(new Date(u.locked_at).getTime()).toBeGreaterThan(Date.now());
    const locked = await ref.post(`/specifications/${id}/approve`).set(headers).send({ meaningCode: 'SPECIFICATION_APPROVAL', password: TEST_PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('SIGNING_LOCKED');
    expect((await one('SELECT status FROM specifications WHERE id = $1', [id])).status).toBe('Draft');
  });

  it('the client sends a meaning code and nothing else about the meaning: a meaning text in the body is a 400', async () => {
    const qa = await newUser('QA');
    const id = await draftSpec();
    const res = await ref.post(`/specifications/${id}/approve`).set(await login(qa.email)).send({ meaningCode: 'SPECIFICATION_APPROVAL', meaning: 'Anything I like', password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect((await one('SELECT status FROM specifications WHERE id = $1', [id])).status).toBe('Draft');
  });
});

describe('HTTP: the catalog and the signatures of a record', () => {
  it('GET /signatures/meanings needs a session and tells each role what it may sign with', async () => {
    expect((await t.request.get('/api/signatures/meanings')).status).toBe(401);
    const res = await t.request.get('/api/signatures/meanings').set(await t.auth('analyst1@gxp.com'));
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.map((m: any) => [m.code, m]));
    expect(byCode.AUTHORSHIP).toMatchObject({ allowedForYou: true, requiresReason: false, trainingExempt: false });
    expect(byCode.OOS_CLOSURE).toMatchObject({ allowedForYou: false, requiresReason: true });
    expect(byCode.TRAINING_ACKNOWLEDGEMENT.trainingExempt).toBe(true);
    expect(typeof byCode.AUTHORSHIP.text).toBe('string');
  });

  it('GET /signatures/entity/:type/:id lists the manifestations of one record, newest first, with the snapshot', async () => {
    const c = cases.find(k => k.entityType === 'Specification')!;
    const x = await c.arrange();
    const qa = await newUser('QA');
    await sign(c, x, qa.id);
    const res = await t.request.get(`/api/signatures/entity/Specification/${x.entityId}`).set(await t.auth('analyst1@gxp.com'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ entityType: 'Specification', entityId: x.entityId, meaningCode: 'SPECIFICATION_APPROVAL', signerRole: 'QA', signerName: expect.stringMatching(/^Signer/), hashVersion: 2 });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totpSecret|failedAttempts|lockedAt/);
  });

  it('GET /signatures/entity/:type/:id also lists signatures the unmigrated routes wrote without a binding, through their audit entry', async () => {
    const s = await registerSample(t);
    const analyst = await t.auth('analyst1@gxp.com');
    // r1-results-oos: the sample route now signs through signRecord. The rows below are what an unmigrated (v0.1.0) route wrote:
    // a Transition audit entry and a signature with no entity binding that points at it.
    const { db } = await import('../../src/db/index');
    const { writeAudit } = await import('../../src/db/utils');
    const audit = await db.transaction(tx => writeAudit(tx, 'usr-analyst1', 'Transition', 'Sample', s.id, 'state', 'Testing', 'Pending Review', 'legacy review'));
    await t.db.pool.query(`INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id) VALUES ($1, $2, 'usr-analyst1', 'Review & Verification of Analytical Results', 'review', 2, $3, $4)`, [uniq('sig-legacy'), s.id, 'b'.repeat(64), audit.id]);
    const res = await t.request.get(`/api/signatures/entity/Sample/${s.id}`).set(analyst);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ entityType: 'Sample', entityId: s.id, hashVersion: 1 });
  });

  it('rejects a malformed type or id with 400 and answers an empty list for a record nobody signed', async () => {
    const h = await t.auth('analyst1@gxp.com');
    expect((await t.request.get('/api/signatures/entity/Bad%20Type/x').set(h)).status).toBe(400);
    const none = await t.request.get('/api/signatures/entity/Sample/SMP-NEVER').set(h);
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
  });
});
