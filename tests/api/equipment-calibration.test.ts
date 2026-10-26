/**
 * Roadmap M13 (r1-quality-fixes), calibration.
 *
 * Before: any role could calibrate; the due date was any string (including one in the past); an Out of Service instrument was set
 * back to Active; no history was kept beyond one audit entry; the calibration was "signed" with a password that was compared to the
 * session's copy of the hash and never counted when wrong; an instrument was due from 00:00 UTC of its due date.
 *
 * After: QA or Admin, through signRecord (CALIBRATION), a due date that is a real date after the calibration, no reactivation of an
 * Out of Service instrument, an append-only calibration_history row per calibration, a version on the instrument, and a due date
 * that is valid through the end of its day.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

const dateFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

async function newInstrument(status = 'Active', due = dateFromToday(10)) {
  const id = uniq('INST-CAL');
  await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'Analytical balance', 'Weighing', $2, $3, '2025-01-01T00:00:00.000Z')`, [id, status, due]);
  return id;
}
const calibrate = (id: string, body: Record<string, unknown>, who: keyof typeof H = 'qa') =>
  t.request.post(`/api/instruments/${id}/calibrate`).set(H[who]).send({ password: TEST_PASSWORD, ...body });

describe('who may calibrate', () => {
  it('an Analyst or a Reviewer gets 403 and nothing changes', async () => {
    const id = await newInstrument();
    const due = dateFromToday(10);
    for (const who of ['analyst1', 'reviewer'] as const) {
      const res = await calibrate(id, { newDueDate: dateFromToday(200) }, who);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect((await one('SELECT calibration_due_date AS d FROM instruments WHERE id = $1', [id])).d).toBe(due);
    expect((await one('SELECT count(*)::int AS n FROM calibration_history WHERE instrument_id = $1', [id])).n).toBe(0);
  });

  it('QA and Admin may', async () => {
    for (const who of ['qa', 'admin'] as const) {
      const id = await newInstrument();
      const res = await calibrate(id, { newDueDate: dateFromToday(180) }, who);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});

describe('the new due date', () => {
  it('a past date returns 400, so does today (it must be after the calibration), and the instrument is unchanged', async () => {
    const id = await newInstrument();
    for (const newDueDate of [dateFromToday(-1), dateFromToday(-400), dateFromToday(0)]) {
      const res = await calibrate(id, { newDueDate });
      expect(res.status, `${newDueDate}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error).toMatch(/due date/i);
    }
    expect((await one('SELECT version FROM instruments WHERE id = $1', [id])).version).toBe(1);
    expect((await one('SELECT count(*)::int AS n FROM calibration_history WHERE instrument_id = $1', [id])).n).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Instrument' AND entity_id = $1`, [id])).n).toBe(0);
  });

  it('anything that is not a real calendar date is 400', async () => {
    const id = await newInstrument();
    for (const newDueDate of ['soon', '2030-02-30', '2030-13-01', '30/01/2030', '2030-1-5', '', '2030-01-01T00:00:00Z extra', 20300101 as any, null as any]) {
      const res = await calibrate(id, { newDueDate });
      expect(res.status, `${String(newDueDate)}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it('tomorrow is accepted', async () => {
    const id = await newInstrument();
    expect((await calibrate(id, { newDueDate: dateFromToday(1) })).status).toBe(200);
  });
});

describe('a calibration', () => {
  it('writes the history row, the signature (CALIBRATION, hash version 2, linked to the audit entry) and the audit entry, and moves the version', async () => {
    const id = await newInstrument('Active', '2026-12-31');
    const newDueDate = dateFromToday(365);
    const res = await calibrate(id, { newDueDate });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id, calibrationDueDate: newDueDate, status: 'Active', version: 2 });

    const hist = await sql('SELECT * FROM calibration_history WHERE instrument_id = $1', [id]);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ performed_by: 'usr-qa', previous_due_date: '2026-12-31', new_due_date: newDueDate, status_before: 'Active', status_after: 'Active', instrument_version: 2 });
    expect(hist[0].reason.length).toBeGreaterThan(0);

    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'Instrument' AND entity_id = $1`, [id]);
    expect(sig).toMatchObject({ meaning_code: 'CALIBRATION', signer_id: 'usr-qa', record_version: hist[0].instrument_version, hash_version: 2 });
    expect(sig.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await one('SELECT * FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(audit).toMatchObject({ action: 'Calibrate', entity: 'Instrument', entity_id: id, field: 'calibrationDueDate', old_value: '2026-12-31', new_value: newDueDate, user_id: 'usr-qa' });
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true, status: 'valid' });

    // lastCalibrationDate is the moment of this calibration, as a timestamp the server took.
    const row = await one('SELECT last_calibration_date AS l FROM instruments WHERE id = $1', [id]);
    expect(Math.abs(Date.now() - Date.parse(row.l))).toBeLessThan(60_000);
  });

  it('a wrong password is 401, counted and audited (SignatureFailed), and changes nothing', async () => {
    const id = await newInstrument();
    const res = await calibrate(id, { newDueDate: dateFromToday(100), password: 'wrong-password' }, 'admin');
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND entity = 'Instrument' AND entity_id = $1`, [id])).n).toBe(1);
    expect((await one('SELECT version FROM instruments WHERE id = $1', [id])).version).toBe(1);
    expect((await one('SELECT count(*)::int AS n FROM calibration_history WHERE instrument_id = $1', [id])).n).toBe(0);
    // (cleared again by the next good signature so this file's Admin is not locked for the rest of the run)
    expect((await calibrate(await newInstrument(), { newDueDate: dateFromToday(100) }, 'admin')).status).toBe(200);
  });

  it('two calibrations in a row are two events: the second one sees the first (versions 2 and 3, previous due date carried forward)', async () => {
    const id = await newInstrument('Active', '2026-12-31');
    expect((await calibrate(id, { newDueDate: dateFromToday(50) })).status).toBe(200);
    expect((await calibrate(id, { newDueDate: dateFromToday(60) })).status).toBe(200);
    const hist = await sql('SELECT instrument_version, previous_due_date, new_due_date FROM calibration_history WHERE instrument_id = $1 ORDER BY instrument_version', [id]);
    expect(hist).toEqual([
      { instrument_version: 2, previous_due_date: '2026-12-31', new_due_date: dateFromToday(50) },
      { instrument_version: 3, previous_due_date: dateFromToday(50), new_due_date: dateFromToday(60) },
    ]);
  });

  it('two simultaneous calibrations never lose one: both are written, one after the other, under the row lock', async () => {
    const id = await newInstrument('Active', '2026-12-31');
    const [a, b] = await Promise.all([
      calibrate(id, { newDueDate: dateFromToday(70) }),
      calibrate(id, { newDueDate: dateFromToday(71) }, 'admin'),
    ]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    const hist = await sql('SELECT instrument_version, previous_due_date, new_due_date FROM calibration_history WHERE instrument_id = $1 ORDER BY instrument_version', [id]);
    expect(hist.map(h => h.instrument_version)).toEqual([2, 3]);
    expect(hist[1].previous_due_date).toBe(hist[0].new_due_date); // the chain of due dates has no gap and no fork
    expect((await one('SELECT version, calibration_due_date AS d FROM instruments WHERE id = $1', [id]))).toEqual({ version: 3, d: hist[1].new_due_date });
  });

  it('unknown keys and a missing password are 400; an unknown instrument is 404', async () => {
    const id = await newInstrument();
    expect((await calibrate(id, { newDueDate: dateFromToday(10), status: 'Active' })).status).toBe(400);
    expect((await t.request.post(`/api/instruments/${id}/calibrate`).set(H.qa).send({ newDueDate: dateFromToday(10) })).status).toBe(400);
    expect((await calibrate('INST-NOPE', { newDueDate: dateFromToday(10) })).status).toBe(404);
  });
});

describe('status', () => {
  it('an Out of Service instrument is calibrated (the event is recorded) but is NOT set back to Active', async () => {
    const id = await newInstrument('Out of Service');
    const res = await calibrate(id, { newDueDate: dateFromToday(120) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('Out of Service');
    expect((await one('SELECT status FROM instruments WHERE id = $1', [id])).status).toBe('Out of Service');
    expect(await one('SELECT status_before, status_after FROM calibration_history WHERE instrument_id = $1', [id])).toEqual({ status_before: 'Out of Service', status_after: 'Out of Service' });
    expect(JSON.stringify(res.body.warnings ?? [])).toMatch(/Out of Service/);
  });

  it('an instrument In Calibration returns to Active when the calibration is signed', async () => {
    const id = await newInstrument('In Calibration');
    const res = await calibrate(id, { newDueDate: dateFromToday(120) });
    expect(res.status).toBe(200);
    expect(await one('SELECT status_before, status_after FROM calibration_history WHERE instrument_id = $1', [id])).toEqual({ status_before: 'In Calibration', status_after: 'Active' });
  });

  it('a Retired instrument is final (423)', async () => {
    const id = await newInstrument('Retired');
    expect((await calibrate(id, { newDueDate: dateFromToday(120) })).status).toBe(423);
  });
});

describe('calibration_history is append-only', () => {
  it('UPDATE, DELETE and TRUNCATE are refused by the database', async () => {
    const id = await newInstrument();
    expect((await calibrate(id, { newDueDate: dateFromToday(30) })).status).toBe(200);
    await expect(sql(`UPDATE calibration_history SET new_due_date = '2099-01-01' WHERE instrument_id = $1`, [id])).rejects.toThrow(/not permitted/);
    await expect(sql(`DELETE FROM calibration_history WHERE instrument_id = $1`, [id])).rejects.toThrow(/not permitted/);
    await expect(sql('TRUNCATE calibration_history')).rejects.toThrow(/not permitted/);
  });
});

describe('GET /instruments', () => {
  it('shows each instrument with its calibrations, newest first', async () => {
    const id = await newInstrument();
    await calibrate(id, { newDueDate: dateFromToday(30) });
    await calibrate(id, { newDueDate: dateFromToday(60) });
    const res = await t.request.get('/api/instruments').set(H.analyst1);
    const inst = res.body.find((i: any) => i.id === id);
    expect(inst.version).toBe(3);
    expect(inst.calibrations.map((c: any) => c.newDueDate)).toEqual([dateFromToday(60), dateFromToday(30)]);
  });
});

describe('registering an instrument', () => {
  const register = (body: Record<string, unknown>) => t.request.post('/api/instruments').set(H.qa).send(body);

  it('the due date and the last calibration date must be real dates; the last calibration is what the registrar states, not "now"', async () => {
    const base = { name: uniq('Balance'), type: 'Weighing', calibrationDueDate: dateFromToday(200), lastCalibrationDate: dateFromToday(-30) };
    for (const bad of [{ calibrationDueDate: 'later' }, { calibrationDueDate: '2030-02-30' }, { lastCalibrationDate: 'yesterday' }, { lastCalibrationDate: dateFromToday(5) }, { lastCalibrationDate: undefined }]) {
      const res = await register({ ...base, ...bad });
      expect(res.status, JSON.stringify(bad) + JSON.stringify(res.body)).toBe(400);
    }
    const ok = await register(base);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'Active', lastCalibrationDate: base.lastCalibrationDate, calibrationDueDate: base.calibrationDueDate });
  });
});

describe('the end of the due date', () => {
  it('an instrument is in calibration through the end of its due date (UTC) and out of it from the next second', async () => {
    const { calibrationState } = await import('../../src/lib/validations/instruments');
    expect(calibrationState('2026-10-13', new Date('2026-10-13T00:00:00Z'))).toMatchObject({ expired: false, daysRemaining: 0 });
    expect(calibrationState('2026-10-13', new Date('2026-10-13T23:59:59.999Z'))).toMatchObject({ expired: false, daysRemaining: 0 });
    expect(calibrationState('2026-10-13', new Date('2026-10-14T00:00:00Z'))).toMatchObject({ expired: true, daysRemaining: -1 });
    expect(calibrationState('2026-10-20', new Date('2026-10-13T12:00:00Z'))).toMatchObject({ expired: false, daysRemaining: 7 });
    expect(calibrationState('not a date', new Date())).toMatchObject({ expired: true });
  });
});
