/**
 * Roadmap M13 (r1-quality-fixes), environmental monitoring.
 *
 * Before: every grade was judged by "viable count > 10", so a Grade A plate with 5 CFU passed; the status was 'Pass' or 'Action Level'
 * while the screen styled 'Alert' and 'Action'; anyone could edit a count without a reason; the seed marked Grade D 15 and 22 CFU
 * 'Pass' against the rule that was applied to new rows.
 *
 * After: a limits table (seeded with the roadmap's Annex 1 (2022) example values, editable site data) is evaluated by grade and
 * sample type; Grade A is "any growth is Action"; the vocabulary is Pass / Alert / Action; an Action opens an excursion; a count
 * edit needs QA or Admin, a reason, the current version, and is audited with the full old and new record.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const log = (grade: string, sampleType: string, viableCount: number | string, over: Record<string, unknown> = {}, who: keyof typeof H = 'analyst1') =>
  t.request.post('/api/env-records').set(H[who]).send({ location: uniq('Room'), grade, sampleType, date: today(), viableCount, nonViableCount: 100, ...over });

describe('the limits table', () => {
  it('is seeded with the example limits by the installer, as data the site approves: no alert levels, nobody has approved them yet', async () => {
    const rows = await sql('SELECT grade, sample_type, unit, alert_limit, action_limit, approved_by, active, source FROM env_limits ORDER BY grade, sample_type');
    expect(rows).toHaveLength(14);
    const limit = (g: string, s: string) => rows.find(r => r.grade === g && r.sample_type === s)?.action_limit;
    for (const s of ['Air', 'Settle plate', 'Contact plate', 'Glove print']) expect(limit('Grade A', s), `A ${s}`).toBe(0); // no growth
    expect([limit('Grade B', 'Air'), limit('Grade B', 'Settle plate'), limit('Grade B', 'Contact plate'), limit('Grade B', 'Glove print')]).toEqual([10, 5, 5, 5]);
    expect([limit('Grade C', 'Air'), limit('Grade C', 'Settle plate'), limit('Grade C', 'Contact plate'), limit('Grade C', 'Glove print')]).toEqual([100, 50, 25, undefined]);
    expect([limit('Grade D', 'Air'), limit('Grade D', 'Settle plate'), limit('Grade D', 'Contact plate'), limit('Grade D', 'Glove print')]).toEqual([200, 100, 50, undefined]);
    expect(rows.every(r => r.alert_limit === null && r.approved_by === null && r.active === true)).toBe(true);
    expect(rows.every(r => /Annex 1/.test(r.source) && /not site-approved/i.test(r.source))).toBe(true);
    expect(rows.find(r => r.grade === 'Grade B' && r.sample_type === 'Air')!.unit).toBe('CFU/m3');
  });
});

describe('Grade A: any growth is Action', () => {
  it('1 CFU gives Action and opens an excursion; the record keeps the limit it was judged against', async () => {
    const res = await log('Grade A', 'Settle plate', 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ grade: 'Grade A', sampleType: 'Settle plate', viableCount: 1, status: 'Action', testedBy: 'usr-analyst1', limitAction: 0, limitAlert: null });
    const exc = await sql(`SELECT * FROM env_excursions WHERE env_record_id = $1`, [res.body.id]);
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ level: 'Action', status: 'Open', grade: 'Grade A', sample_type: 'Settle plate', viable_count: 1, limit_value: 0, opened_by: 'usr-analyst1' });
    expect(res.body.excursionId).toBe(exc[0].id);
    const audited = await sql(`SELECT entity, action, user_id FROM audit_trail WHERE entity_id IN ($1, $2) ORDER BY sequence`, [res.body.id, exc[0].id]);
    expect(audited).toEqual([
      { entity: 'EnvRecord', action: 'Create', user_id: 'usr-analyst1' },
      { entity: 'EnvExcursion', action: 'Create', user_id: 'usr-analyst1' },
    ]);
  });

  it('0 CFU is Pass and opens nothing; the old words are gone (no "Action Level")', async () => {
    const res = await log('Grade A', 'Air', 0);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Pass');
    expect((await one('SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1', [res.body.id])).n).toBe(0);
    expect((await sql(`SELECT 1 FROM env_records WHERE status = 'Action Level' AND id = $1`, [res.body.id]))).toHaveLength(0);
  });

  it('5 CFU on a Grade A plate no longer passes (it did under "count > 10")', async () => {
    expect((await log('Grade A', 'Contact plate', 5)).body.status).toBe('Action');
  });
});

describe('the other grades follow the profile of their sample type', () => {
  const cases: Array<[grade: string, type: string, count: number, status: string]> = [
    ['Grade C', 'Air', 40, 'Pass'],
    ['Grade C', 'Settle plate', 40, 'Pass'],
    ['Grade C', 'Contact plate', 40, 'Action'],      // 40 > 25
    ['Grade C', 'Contact plate', 25, 'Pass'],        // at the limit is not above it
    ['Grade B', 'Settle plate', 5, 'Pass'],
    ['Grade B', 'Settle plate', 6, 'Action'],
    ['Grade B', 'Air', 10, 'Pass'],
    ['Grade B', 'Air', 11, 'Action'],
    ['Grade D', 'Contact plate', 22, 'Pass'],        // the seed's Grade D 15 and 22 CFU are Pass under these limits
    ['Grade D', 'Air', 200, 'Pass'],
    ['Grade D', 'Air', 201, 'Action'],
    ['Grade D', 'Contact plate', 51, 'Action'],
  ];
  it.each(cases)('%s %s with %i CFU is %s', async (grade, type, count, status) => {
    const res = await log(grade, type, count);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe(status);
    const excursions = (await one('SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1', [res.body.id])).n;
    expect(excursions).toBe(status === 'Action' ? 1 : 0);
  });

  it('an Alert level, once the site has set one, gives Alert below Action', async () => {
    await sql(`UPDATE env_limits SET alert_limit = 20 WHERE grade = 'Grade C' AND sample_type = 'Contact plate'`);
    try {
      expect((await log('Grade C', 'Contact plate', 20)).body.status).toBe('Pass');
      const alert = await log('Grade C', 'Contact plate', 21);
      expect(alert.body).toMatchObject({ status: 'Alert', limitAlert: 20, limitAction: 25 });
      expect((await one('SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1', [alert.body.id])).n).toBe(0);
      expect((await log('Grade C', 'Contact plate', 26)).body.status).toBe('Action');
    } finally {
      await sql(`UPDATE env_limits SET alert_limit = NULL WHERE grade = 'Grade C' AND sample_type = 'Contact plate'`);
    }
  });

  it('a combination with no limit (Grade C glove print) is refused: 400 and nothing is recorded', async () => {
    const location = uniq('NoLimit');
    const res = await log('Grade C', 'Glove print', 1, { location });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
    expect((await one('SELECT count(*)::int AS n FROM env_records WHERE location = $1', [location])).n).toBe(0);
  });

  it('a deactivated limit is not used (the combination is refused until the site approves a new one)', async () => {
    await sql(`UPDATE env_limits SET active = false WHERE grade = 'Grade D' AND sample_type = 'Air'`);
    try { expect((await log('Grade D', 'Air', 1)).status).toBe(400); }
    finally { await sql(`UPDATE env_limits SET active = true WHERE grade = 'Grade D' AND sample_type = 'Air'`); }
  });
});

describe('the input', () => {
  it('"D" and "Grade D" are the same grade, stored as "Grade D"; a counts may be digits in a string (the screen sends strings)', async () => {
    const res = await log('D', 'Air', '15', { nonViableCount: '18000' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ grade: 'Grade D', viableCount: 15, nonViableCount: 18000, status: 'Pass' });
  });

  it('is refused when it is not a measurement: unknown grade or sample type, missing sample type, negative, fractional or non-numeric counts, a future date', async () => {
    const bad: Array<Record<string, unknown>> = [
      { grade: 'Grade E' }, { grade: 'CNC' }, { sampleType: 'Swab' }, { sampleType: undefined }, { sampleType: '' },
      { viableCount: -1 }, { viableCount: 1.5 }, { viableCount: 'many' }, { viableCount: '' }, { nonViableCount: -5 },
      { date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) }, { date: 'today' }, { date: '2026-02-30' }, { location: '' },
    ];
    for (const over of bad) {
      const res = await t.request.post('/api/env-records').set(H.analyst1).send({ location: uniq('Room'), grade: 'Grade B', sampleType: 'Air', date: today(), viableCount: 1, nonViableCount: 1, ...over });
      expect(res.status, JSON.stringify(over) + JSON.stringify(res.body)).toBe(400);
    }
  });

  it('server-controlled fields are refused: status, testedBy, version, id', async () => {
    for (const extra of [{ status: 'Pass' }, { testedBy: 'usr-qa' }, { version: 9 }, { id: 'ENV-forged' }, { limitAction: 99 }]) {
      expect((await log('Grade A', 'Air', 1, extra)).status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('editing a count', () => {
  async function record(count = 0, grade = 'Grade A', type = 'Air') {
    const res = await log(grade, type, count);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; version: number };
  }
  const edit = (id: string, body: Record<string, unknown>, who: keyof typeof H = 'qa') =>
    t.request.put(`/api/env-records/${id}`).set(H[who]).send(body);

  it('an Analyst or a Reviewer gets 403 and the record is unchanged', async () => {
    const r = await record(0);
    for (const who of ['analyst1', 'reviewer'] as const) {
      const res = await edit(r.id, { viableCount: 3, reason: 'Recount of the plate', expectedVersion: 1 }, who);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(await one('SELECT viable_count, version, status FROM env_records WHERE id = $1', [r.id])).toEqual({ viable_count: 0, version: 1, status: 'Pass' });
  });

  it('QA needs a reason (400 without one, or with a token one) and the current version', async () => {
    const r = await record(0);
    expect((await edit(r.id, { viableCount: 3, expectedVersion: 1 })).status).toBe(400);
    expect((await edit(r.id, { viableCount: 3, reason: 'ok', expectedVersion: 1 })).status).toBe(400);
    expect((await edit(r.id, { viableCount: 3, reason: 'Recount of the plate', expectedVersion: 7 })).status).toBe(409);
    expect((await edit(r.id, { viableCount: 3, reason: 'Recount of the plate' })).status).toBe(400);
    expect((await one('SELECT viable_count, version FROM env_records WHERE id = $1', [r.id]))).toEqual({ viable_count: 0, version: 1 });
  });

  it('a QA edit makes a new version, re-evaluates the status, opens the excursion and audits the full record before and after with the reason', async () => {
    const r = await record(0);
    const res = await edit(r.id, { viableCount: 3, reason: 'Recount of the plate by a second analyst', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ viableCount: 3, version: 2, status: 'Action' });
    const audit = await one(`SELECT * FROM audit_trail WHERE entity = 'EnvRecord' AND entity_id = $1 AND action = 'Update'`, [r.id]);
    expect(audit).toMatchObject({ user_id: 'usr-qa', reason: 'Recount of the plate by a second analyst' });
    expect(JSON.parse(audit.old_value)).toMatchObject({ viableCount: 0, status: 'Pass', version: 1 });
    expect(JSON.parse(audit.new_value)).toMatchObject({ viableCount: 3, status: 'Action', version: 2 });
    expect((await one(`SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1 AND status = 'Open'`, [r.id])).n).toBe(1);
  });

  it('lowering a count never closes an excursion that was opened', async () => {
    const r = await record(4);
    expect((await one(`SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1`, [r.id])).n).toBe(1);
    const res = await edit(r.id, { viableCount: 0, reason: 'Transcription error corrected', expectedVersion: 1 }, 'admin');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('Pass');
    expect(await sql(`SELECT status FROM env_excursions WHERE env_record_id = $1`, [r.id])).toEqual([{ status: 'Open' }]);
  });

  it('a second edit that stays Action does not open a second excursion', async () => {
    const r = await record(2);
    await edit(r.id, { viableCount: 3, reason: 'Recount of the plate', expectedVersion: 1 });
    expect((await one(`SELECT count(*)::int AS n FROM env_excursions WHERE env_record_id = $1`, [r.id])).n).toBe(1);
  });

  it('changing the grade or sample type re-evaluates against that profile', async () => {
    const r = await record(30, 'Grade C', 'Air'); // Pass
    expect(r).toBeTruthy();
    const res = await edit(r.id, { grade: 'Grade B', reason: 'Room reclassified in the zoning plan', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ grade: 'Grade B', status: 'Action', limitAction: 10 });
  });

  it('a record from before sample types existed must be given one when it is edited', async () => {
    const id = uniq('ENV-LEGACY');
    await sql(`INSERT INTO env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by) VALUES ($1, 'Old room', 'Grade D', '2026-02-11', 15, 18000, 'Pass', 'usr-qa')`, [id]);
    const without = await edit(id, { viableCount: 16, reason: 'Recount of the plate', expectedVersion: 1 });
    expect(without.status, JSON.stringify(without.body)).toBe(400);
    expect(without.body.error).toMatch(/sample type/i);
    const withType = await edit(id, { viableCount: 16, sampleType: 'Air', reason: 'Recount of the plate', expectedVersion: 1 });
    expect(withType.status, JSON.stringify(withType.body)).toBe(200);
    expect(withType.body).toMatchObject({ sampleType: 'Air', status: 'Pass' });
  });

  it('simultaneous edits with the same version: one wins, the other is 409', async () => {
    const r = await record(0);
    const body = (n: number) => ({ viableCount: n, reason: 'Recount of the plate', expectedVersion: 1 });
    const [a, b, c] = await Promise.all([edit(r.id, body(1)), edit(r.id, body(2), 'admin'), edit(r.id, body(3))]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 409, 409]);
  });

  it('an unknown record is 404; unknown keys are 400', async () => {
    expect((await edit('ENV-NOPE', { viableCount: 1, reason: 'Recount of the plate', expectedVersion: 1 })).status).toBe(404);
    const r = await record(0);
    expect((await edit(r.id, { viableCount: 1, reason: 'Recount of the plate', expectedVersion: 1, status: 'Pass' })).status).toBe(400);
  });
});

describe('reading the records', () => {
  it('GET /env-records returns the status vocabulary Pass / Alert / Action and the excursion of an Action', async () => {
    const pass = (await log('Grade B', 'Air', 1)).body;
    const action = (await log('Grade B', 'Air', 50)).body;
    const list = (await t.request.get('/api/env-records').set(H.analyst1)).body as any[];
    expect(list.find(r => r.id === pass.id)).toMatchObject({ status: 'Pass', excursionId: null });
    expect(list.find(r => r.id === action.id)).toMatchObject({ status: 'Action', excursionStatus: 'Open' });
    expect(list.every(r => ['Pass', 'Alert', 'Action'].includes(r.status))).toBe(true);
  });
});
