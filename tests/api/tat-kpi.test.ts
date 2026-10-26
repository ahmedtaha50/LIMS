/**
 * Roadmap M34 (r2-tat-kpi): turnaround time and honest, role-based key figures.
 *
 *   business calendar   weekend days, time zone, holidays and SLA rules are master data (QA, Admin): strict, audited with a reason, versioned
 *   due date            receipt + the SLA of the priority in business days; calculated once, by the sweep or when the priority changes
 *   /metrics/tat        median and P90 cycle time, on-time %, aging, OOS rate, right-first-time: SQL aggregates, cycle time from the audit trail
 *   /metrics/kpi        tiles by role; each tile's list is the same predicate as its count
 *   the sweep           starts clocks and announces due-in-24h and overdue once
 *
 * Acceptance: a Thursday 16:00 receipt with a 2-business-day SLA and a Fri-Sat weekend is due Monday; tile counts equal the row totals of
 * the linked list and closing an OOS reduces Active OOS by one; the TAT endpoint matches the hand-computed on-time % and P90 of a
 * 10-sample fixture. (Rows that no route can place in the past, such as audit entries at a chosen time, are inserted with SQL.)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
let sweep: (opts?: { now?: Date }) => Promise<{ started: number; announced: number }>;

beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
  const { db } = await import('../../src/db/index');
  const mod = await import('../../src/server/schedules/tat');
  sweep = opts => mod.runTatSweep(db, opts);
});

const THU_1600 = '2026-10-22T16:00:00.000Z'; // a Thursday
const H1 = 3_600_000;

describe('the business calendar, holidays and SLA rules', () => {
  it('start from the built-in defaults, marked as such', async () => {
    const res = await t.request.get('/api/tat/settings').set(H.analyst1);
    expect(res.status).toBe(200);
    expect(res.body.calendar).toMatchObject({ weekendDays: [0, 6], timeZone: 'UTC', source: 'default', version: null });
    expect(res.body.sla).toEqual([
      { priority: 'Routine', businessDays: 10, version: null, source: 'default' },
      { priority: 'Urgent', businessDays: 3, version: null, source: 'default' },
      { priority: 'Critical', businessDays: 1, version: null, source: 'default' },
    ]);
  });

  it('are changed by QA only, with a reason, as a strict body, and every change is audited', async () => {
    const body = { weekendDays: [5, 6], timeZone: 'UTC', reason: 'Site works Sunday to Thursday' };
    expect((await t.request.put('/api/tat/calendar').set(H.analyst1).send(body)).status).toBe(403);
    expect((await t.request.put('/api/tat/calendar').set(H.reviewer).send(body)).status).toBe(403);
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, reason: '' })).status).toBe(400);
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, version: 9 })).status).toBe(400);
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, weekendDays: [5, 5] })).status).toBe(400);
    const created = await t.request.put('/api/tat/calendar').set(H.qa).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ weekendDays: [5, 6], timeZone: 'UTC', version: 1 });
    expect(await sql("SELECT action, user_id, reason FROM audit_trail WHERE entity = 'BusinessCalendar'"))
      .toEqual([{ action: 'Create', user_id: 'usr-qa', reason: 'Site works Sunday to Thursday' }]);
  });

  it('use optimistic concurrency: a second save needs the current version', async () => {
    const body = { weekendDays: [5, 6], timeZone: 'Africa/Cairo', reason: 'Time zone of the site' };
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send(body)).status).toBe(409); // no version
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, expectedVersion: 7 })).status).toBe(409); // stale
    const ok = await t.request.put('/api/tat/calendar').set(H.qa).send({ ...body, expectedVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBe(2);
    const audit = await sql("SELECT action, old_value, new_value FROM audit_trail WHERE entity = 'BusinessCalendar' ORDER BY sequence DESC LIMIT 1");
    expect(audit[0]).toMatchObject({ action: 'Update' });
    expect(JSON.parse(audit[0].old_value)).toEqual({ weekendDays: [5, 6], timeZone: 'UTC' });
    expect(JSON.parse(audit[0].new_value)).toEqual({ weekendDays: [5, 6], timeZone: 'Africa/Cairo' });
    // back to UTC for the due-date arithmetic below
    expect((await t.request.put('/api/tat/calendar').set(H.qa).send({ weekendDays: [5, 6], timeZone: 'UTC', reason: 'Back to UTC', expectedVersion: 2 })).status).toBe(200);
  });

  it('hold holidays: added once per date, removed with a reason and the version, both audited', async () => {
    const add = await t.request.post('/api/tat/holidays').set(H.qa).send({ date: '2026-12-25', name: 'Winter holiday', reason: 'Site calendar 2026' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await t.request.post('/api/tat/holidays').set(H.qa).send({ date: '2026-12-25', name: 'Again', reason: 'Duplicate' })).status).toBe(409);
    expect((await t.request.post('/api/tat/holidays').set(H.qa).send({ date: '2026-02-30', name: 'Not a day', reason: 'Bad date' })).status).toBe(400);
    expect((await t.request.post('/api/tat/holidays').set(H.analyst1).send({ date: '2026-12-26', name: 'x', reason: 'not allowed' })).status).toBe(403);
    expect((await t.request.post(`/api/tat/holidays/${add.body.id}/remove`).set(H.qa).send({ reason: 'Wrong day', expectedVersion: 5 })).status).toBe(409);
    expect((await t.request.post(`/api/tat/holidays/${add.body.id}/remove`).set(H.qa).send({ reason: 'Wrong day', expectedVersion: 1 })).status).toBe(200);
    expect((await sql("SELECT action FROM audit_trail WHERE entity = 'BusinessHoliday' ORDER BY sequence")).map(r => r.action)).toEqual(['Create', 'Delete']);
    expect(await sql('SELECT 1 FROM business_holidays')).toEqual([]);
  });

  it('keep an SLA rule per priority, versioned and audited', async () => {
    expect((await t.request.put('/api/tat/sla/Routine').set(H.analyst1).send({ businessDays: 5, reason: 'faster' })).status).toBe(403);
    expect((await t.request.put('/api/tat/sla/Whenever').set(H.qa).send({ businessDays: 5, reason: 'faster' })).status).toBe(400);
    expect((await t.request.put('/api/tat/sla/Routine').set(H.qa).send({ businessDays: 0, reason: 'zero' })).status).toBe(400);
    const urgent = await t.request.put('/api/tat/sla/Urgent').set(H.qa).send({ businessDays: 2, reason: 'Two business days for urgent samples' });
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    expect((await t.request.put('/api/tat/sla/Urgent').set(H.qa).send({ businessDays: 2, reason: 'again' })).status).toBe(409);
    const settings = await t.request.get('/api/tat/settings').set(H.analyst1);
    expect(settings.body.sla.find((r: any) => r.priority === 'Urgent')).toMatchObject({ businessDays: 2, source: 'configured', version: 1 });
    expect((await sql("SELECT user_id FROM audit_trail WHERE entity = 'TatSlaRule'")).map(r => r.user_id)).toEqual(['usr-qa']);
  });
});

describe('the due date of a sample', () => {
  /** A registered, received sample whose receipt is moved to a known time (the clock reads the custody record). */
  async function received(at: string) {
    const s = await registerSample(t);
    await sql('UPDATE sample_custody SET received_at = $2::timestamptz WHERE sample_id = $1', [s.id, at]);
    return s;
  }

  it('a Thursday 16:00 receipt with a 2-business-day SLA and a Fri-Sat weekend is due Monday 16:00 (the sweep starts the clock)', async () => {
    const s = await received(THU_1600);
    await sweep();
    const row = await one('SELECT priority, sla_business_days, started_at, due_at, set_by FROM sample_tat WHERE id = $1', [s.id]);
    expect(row.priority).toBe('Routine');
    // Routine is 10 business days by default: Sun 25, Mon 26, Tue 27, Wed 28, Thu 29, Sun 1, Mon 2, Tue 3, Wed 4, Thu 5 November.
    expect(row.sla_business_days).toBe(10);
    expect(row.due_at.toISOString()).toBe('2026-11-05T16:00:00.000Z');
    expect(row.set_by).toBe('svc-scheduler');
    const audit = await sql("SELECT action, user_id, reason FROM audit_trail WHERE entity = 'SampleTat' AND entity_id = $1", [s.id]);
    expect(audit).toEqual([{ action: 'Create', user_id: 'svc-scheduler', reason: expect.stringContaining('tat.sweep') }]);
  });

  it('Urgent (2 business days) is due Monday 16:00; the priority is set by the person, audited, and recalculates the due date', async () => {
    const s = await received(THU_1600);
    const set = await t.request.put(`/api/tat/samples/${s.id}`).set(H.analyst1).send({ priority: 'Urgent', reason: 'Customer release deadline' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ priority: 'Urgent', slaBusinessDays: 2, dueAt: '2026-10-26T16:00:00.000Z', startedAt: THU_1600, setBy: 'usr-analyst1', version: 1 });
    // changing it again needs the version, and is audited with old and new
    expect((await t.request.put(`/api/tat/samples/${s.id}`).set(H.analyst1).send({ priority: 'Critical', reason: 'Escalated' })).status).toBe(409);
    expect((await t.request.put(`/api/tat/samples/${s.id}`).set(H.analyst1).send({ priority: 'Critical', reason: 'Escalated', expectedVersion: 4 })).status).toBe(409);
    const crit = await t.request.put(`/api/tat/samples/${s.id}`).set(H.qa).send({ priority: 'Critical', reason: 'Escalated', expectedVersion: 1 });
    expect(crit.status, JSON.stringify(crit.body)).toBe(200);
    expect(crit.body).toMatchObject({ priority: 'Critical', slaBusinessDays: 1, dueAt: '2026-10-25T16:00:00.000Z', version: 2 });
    const audit = await sql("SELECT action, user_id FROM audit_trail WHERE entity = 'SampleTat' AND entity_id = $1 ORDER BY sequence", [s.id]);
    expect(audit).toEqual([{ action: 'Create', user_id: 'usr-analyst1' }, { action: 'Update', user_id: 'usr-qa' }]);
    // a second sweep leaves a clock that is running alone
    await sweep();
    expect((await one('SELECT version FROM sample_tat WHERE id = $1', [s.id])).version).toBe(2);
  });

  it('a priority set before the receipt waits for it: the due date follows when the sample is received', async () => {
    const material = uniq('Material');
    const { insertActiveSpec } = await import('../helpers/fixtures');
    await insertActiveSpec(t, material);
    const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
    expect(created.status).toBe(200);
    const set = await t.request.put(`/api/tat/samples/${created.body.id}`).set(H.analyst1).send({ priority: 'Critical', reason: 'Needed first' });
    expect(set.body).toMatchObject({ priority: 'Critical', dueAt: null, startedAt: null });
    await sweep();
    expect((await one('SELECT due_at FROM sample_tat WHERE id = $1', [created.body.id])).due_at).toBeNull(); // not received: no clock
    const { receiveSample } = await import('../helpers/fixtures');
    await receiveSample(t, created.body.id);
    await sweep();
    const row = await one('SELECT priority, due_at, started_at FROM sample_tat WHERE id = $1', [created.body.id]);
    expect(row.priority).toBe('Critical');
    expect(row.due_at).not.toBeNull();
    expect(row.due_at.getTime()).toBeGreaterThan(row.started_at.getTime());
  });

  it('refuses an unknown priority, an unknown key, an unknown sample and a finished sample', async () => {
    const s = await received(THU_1600);
    expect((await t.request.put(`/api/tat/samples/${s.id}`).set(H.qa).send({ priority: 'Whenever', reason: 'x1x' })).status).toBe(400);
    expect((await t.request.put(`/api/tat/samples/${s.id}`).set(H.qa).send({ priority: 'Urgent', reason: 'x1x', dueAt: '2030-01-01' })).status).toBe(400);
    expect((await t.request.put('/api/tat/samples/SMP-0000-00000').set(H.qa).send({ priority: 'Urgent', reason: 'x1x' })).status).toBe(404);
    await sql("UPDATE samples SET state = 'Approved' WHERE id = $1", [s.id]);
    expect((await t.request.put(`/api/tat/samples/${s.id}`).set(H.qa).send({ priority: 'Urgent', reason: 'x1x' })).status).toBe(400);
  });

  it('GET shows the default for a sample that has no record', async () => {
    const s = await registerSample(t);
    const res = await t.request.get(`/api/tat/samples/${s.id}`).set(H.analyst1);
    expect(res.body).toMatchObject({ sampleId: s.id, priority: 'Routine', dueAt: null, source: 'default' });
    expect((await t.request.get('/api/tat/samples/NOPE').set(H.analyst1)).status).toBe(404);
  });
});

describe('the sweep announces once', () => {
  it('raises due-in-24h and then overdue, one event each per sample and due date, and nothing for a finished sample', async () => {
    const soon = await registerSample(t);
    const late = await registerSample(t);
    const done = await registerSample(t);
    const now = new Date('2026-11-10T12:00:00Z');
    for (const [s, dueAt] of [[soon, new Date(now.getTime() + 5 * H1)], [late, new Date(now.getTime() - 2 * H1)], [done, new Date(now.getTime() - 2 * H1)]] as const) {
      await sql(`INSERT INTO sample_tat (id, priority, started_at, sla_business_days, due_at, set_by) VALUES ($1, 'Routine', $2::timestamptz, 1, $3::timestamptz, 'usr-qa')
                 ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, due_at = EXCLUDED.due_at`, [s.id, new Date(dueAt.getTime() - 86_400_000).toISOString(), dueAt.toISOString()]);
    }
    await sql("UPDATE samples SET state = 'Approved' WHERE id = $1", [done.id]);
    const first = await sweep({ now });
    expect(first.announced).toBeGreaterThanOrEqual(2);
    const events = await sql("SELECT entity_id, payload FROM outbox_events WHERE type = 'sample.tat_alert' AND entity_id = ANY($1)", [[soon.id, late.id, done.id]]);
    expect(events.map(e => [e.entity_id, e.payload.kind]).sort()).toEqual([[late.id, 'overdue'], [soon.id, 'due_soon']].sort());
    expect((await sweep({ now })).announced).toBe(0);
    // later the soon-due sample becomes overdue: one more event, for the same due date
    const later = new Date(now.getTime() + 6 * H1);
    await sweep({ now: later });
    const after = await sql("SELECT payload->>'kind' AS kind FROM outbox_events WHERE type = 'sample.tat_alert' AND entity_id = $1 ORDER BY kind", [soon.id]);
    expect(after.map(r => r.kind)).toEqual(['due_soon', 'overdue']);
    expect((await sweep({ now: later })).announced).toBe(0);
  });
});

describe('GET /metrics/tat on a 10-sample fixture', () => {
  // Cycle times in hours, due after the stated hours, and which samples are right first time. All finished inside September 2026.
  const CYCLE = [2, 4, 6, 8, 10, 12, 14, 16, 18, 40];
  const DUE =   [24, 24, 24, 24, 24, 24, 24, 12, 10, 24]; // the last three finish after their due date: 7 of 10 on time
  const ids: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 10; i++) {
      const s = await registerSample(t);
      ids.push(s.id);
      const start = new Date(Date.UTC(2026, 8, 1 + i, 8, 0, 0));
      const done = new Date(start.getTime() + CYCLE[i] * H1);
      await sql('UPDATE sample_custody SET received_at = $2::timestamptz WHERE sample_id = $1', [s.id, start.toISOString()]);
      await sql("UPDATE samples SET state = 'Approved' WHERE id = $1", [s.id]);
      await sql(`INSERT INTO sample_tat (id, priority, started_at, sla_business_days, due_at, set_by) VALUES ($1, $2, $3::timestamptz, 1, $4::timestamptz, 'usr-qa')
                 ON CONFLICT (id) DO UPDATE SET priority = EXCLUDED.priority, started_at = EXCLUDED.started_at, due_at = EXCLUDED.due_at`,
        [s.id, i < 4 ? 'Urgent' : 'Routine', start.toISOString(), new Date(start.getTime() + DUE[i] * H1).toISOString()]);
      // the immutable record of the move, placed at its time (no route can approve a sample in the past)
      await sql(`INSERT INTO audit_trail (id, sequence, timestamp, timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash)
                 VALUES ($1, (SELECT coalesce(max(sequence), 0) + 1 FROM audit_trail), $2::timestamptz, $3, 'usr-reviewer', 'Transition', 'Sample', $4, 'state', 'Pending Review', 'Approved', 'fixture', 'fixture', 'fixture')`,
        [`adt-fixture-${i}`, done.toISOString(), done.toISOString(), s.id]);
      // a value for the OOS rate; samples 0 and 1 are out of specification, and sample 0 has an investigation
      await sql('UPDATE results SET value = $2, entered_at = $3::timestamptz, entered_by = $4, is_oos = $5 WHERE id = $1', [s.result.id, '99.0', done.toISOString(), 'usr-analyst1', i < 2]);
    }
    await sql("INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) SELECT $1, $2, id, parameter, '2026-09-01', 'Closed' FROM results WHERE sample_id = $2 LIMIT 1", [uniq('OOS'), ids[0]]);
  });

  const get = async (query = '?from=2026-09-01&to=2026-09-30') => {
    const res = await t.request.get(`/api/metrics/tat${query}`).set(H.analyst1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  it('matches the hand-computed on-time % (7 of 10), median (11 h) and P90 (20.2 h: 18 + 0.1 x (40 - 18))', async () => {
    const d = await get();
    expect(d).toMatchObject({ completed: 10, approved: 10, withDueDate: 10, onTime: 7, onTimePct: 70, medianHours: 11, p90Hours: 20.2 });
    expect(d.window.from).toBe('2026-09-01T00:00:00.000Z');
    expect(typeof d.definitions.cycleTime).toBe('string');
  });

  it('splits by priority and filters by priority', async () => {
    const d = await get();
    expect(d.byPriority.map((p: any) => [p.priority, p.completed, p.onTime])).toEqual([['Routine', 6, 3], ['Urgent', 4, 4]]);
    const urgent = await get('?from=2026-09-01&to=2026-09-30&priority=Urgent');
    expect(urgent).toMatchObject({ completed: 4, onTimePct: 100, medianHours: 5 });
  });

  it('counts only the samples that finished inside the window', async () => {
    expect((await get('?from=2026-09-01&to=2026-09-05')).completed).toBe(5);
    expect((await get('?from=2025-01-01&to=2025-01-31')).completed).toBe(0);
    expect((await get('?from=2025-01-01&to=2025-01-31')).onTimePct).toBeNull();
  });

  it('gives the OOS rate by parameter and the right-first-time share', async () => {
    const d = await get();
    expect(d.oosRate).toContainEqual({ parameter: 'Assay (%)', results: 10, oos: 2, ratePct: 20 });
    expect(d.rightFirstTime).toEqual({ approved: 10, firstTime: 9, pct: 90 });
  });

  it('ages the open samples into buckets and counts the overdue ones', async () => {
    const before = await get();
    const mk = async (daysAgo: number, dueOffsetH: number) => {
      const s = await registerSample(t);
      const at = new Date(Date.now() - daysAgo * 86_400_000 - H1);
      await sql('UPDATE sample_custody SET received_at = $2::timestamptz WHERE sample_id = $1', [s.id, at.toISOString()]);
      await sql(`INSERT INTO sample_tat (id, priority, started_at, sla_business_days, due_at, set_by) VALUES ($1, 'Routine', $2::timestamptz, 1, $3::timestamptz, 'usr-qa')
                 ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, due_at = EXCLUDED.due_at`, [s.id, at.toISOString(), new Date(Date.now() + dueOffsetH * H1).toISOString()]);
    };
    await mk(0, 5); await mk(3, -5); await mk(20, -100);
    const after = await get();
    const n = (d: any, b: string) => d.aging.find((x: any) => x.bucket === b).n;
    expect(n(after, '0-1 days') - n(before, '0-1 days')).toBe(1);
    expect(n(after, '2-3 days') - n(before, '2-3 days')).toBe(1);
    expect(n(after, '15+ days') - n(before, '15+ days')).toBe(1);
    expect(after.open.overdue - before.open.overdue).toBe(2);
    expect(after.open.total - before.open.total).toBe(3);
  });

  it('refuses an unknown parameter, a bad date and an inverted window', async () => {
    expect((await t.request.get('/api/metrics/tat?foo=1').set(H.analyst1)).status).toBe(400);
    expect((await t.request.get('/api/metrics/tat?from=yesterday').set(H.analyst1)).status).toBe(400);
    expect((await t.request.get('/api/metrics/tat?from=2026-10-01&to=2026-09-01').set(H.analyst1)).status).toBe(400);
  });
});

describe('GET /metrics/kpi: role-based tiles that agree with their lists', () => {
  const tiles = async (who: string) => {
    const res = await t.request.get('/api/metrics/kpi').set(H[who]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { role: string; tiles: Array<{ key: string; count: number; view: string; label: string }>; facts: any };
  };
  const keys = (d: { tiles: Array<{ key: string }> }) => d.tiles.map(x => x.key);

  it('shows each role its own tiles', async () => {
    const analyst = await tiles('analyst1'); const qa = await tiles('qa'); const admin = await tiles('admin'); const reviewer = await tiles('reviewer');
    expect(keys(analyst)).toEqual(expect.arrayContaining(['tat.overdue', 'samples.logged', 'samples.testing', 'instruments.overdue']));
    expect(keys(analyst)).not.toContain('batches.hold');
    expect(keys(analyst)).not.toContain('samples.pending_review');
    expect(keys(reviewer)).toContain('samples.pending_review');
    expect(keys(qa)).toEqual(expect.arrayContaining(['batches.hold', 'oos.overdue', 'training.overdue', 'samples.pending_review']));
    expect(keys(admin).length).toBeGreaterThanOrEqual(keys(qa).length);
    expect(analyst.role).toBe('Analyst');
  });

  it('every tile count equals the total of its list, for every role', async () => {
    for (const who of ['analyst1', 'reviewer', 'qa', 'admin']) {
      for (const tile of (await tiles(who)).tiles) {
        const list = await t.request.get(`/api/metrics/kpi/${tile.key}`).set(H[who]);
        expect(list.status, `${who} ${tile.key}`).toBe(200);
        expect(list.body.total, `${who} ${tile.key}`).toBe(tile.count);
        expect(list.body.rows.length, `${who} ${tile.key}`).toBe(Math.min(tile.count, 200));
        expect(list.body.view).toBe(tile.view);
      }
    }
  });

  it('the TAT tiles list exactly the open samples past their due date', async () => {
    const d = await tiles('analyst1');
    const overdue = d.tiles.find(x => x.key === 'tat.overdue')!;
    expect(overdue.count).toBe((await one("SELECT count(*)::int AS n FROM samples s JOIN sample_tat t ON t.id = s.id WHERE s.state NOT IN ('Approved', 'Rejected') AND t.due_at < now()")).n);
    expect(overdue.count).toBeGreaterThan(0);
  });

  it('closing an OOS investigation reduces Active OOS by exactly one, and its list loses that row', async () => {
    const s = await registerSample(t);
    const opened = await t.request.post('/api/oos').set(H.analyst1).send({ sampleId: s.id, resultId: s.result.id });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const active = async () => (await tiles('qa')).tiles.find(x => x.key === 'oos.active')!.count;
    const before = await active();
    const list = await t.request.get('/api/metrics/kpi/oos.active').set(H.qa);
    expect(list.body.rows.map((r: any) => r.id)).toContain(opened.body.id);
    const p2 = await t.request.put(`/api/oos/${opened.body.id}`).set(H.qa).send({ phase: 'Phase II', expectedVersion: opened.body.version });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    const closed = await t.request.post(`/api/oos/${opened.body.id}/close`).set(H.qa)
      .send({ rootCause: 'Degradation during storage', conclusion: 'Confirmed; batch to be rejected, CAPA raised', decision: 'Confirmed OOS', password: 'password', expectedVersion: p2.body.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await active()).toBe(before - 1);
    const after = await t.request.get('/api/metrics/kpi/oos.active').set(H.qa);
    expect(after.body.rows.map((r: any) => r.id)).not.toContain(opened.body.id);
    expect(after.body.total).toBe(before - 1);
    // the dashboard agrees
    expect((await t.request.get('/api/dashboard').set(H.qa)).body.activeOos).toBe(before - 1);
  });

  it('refuses a tile that is not part of the role, and an unknown tile', async () => {
    expect((await t.request.get('/api/metrics/kpi/batches.hold').set(H.analyst1)).status).toBe(403);
    expect((await t.request.get('/api/metrics/kpi/nope').set(H.qa)).status).toBe(404);
  });

  it('shows dated facts, not scores, to the quality unit only', async () => {
    expect((await tiles('analyst1')).facts).toBeNull();
    const qa = await tiles('qa');
    expect(qa.facts).toEqual({ lastChainVerification: null, lastBackup: null });
    await sql(`INSERT INTO backup_runs (id, kind, started_at, finished_at, status, verified, created_by) VALUES ('bk-1', 'scheduled', '2026-10-24T02:00:00Z', '2026-10-24T02:01:00Z', 'ok', true, 'usr-admin')`);
    const withBackup = await tiles('admin');
    expect(withBackup.facts.lastBackup).toEqual({ at: '2026-10-24T02:01:00.000Z', outcome: 'ok', verified: true });
  });

  it('counts the reagents that expire within 30 days from the same predicate as the list', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const before = (await tiles('qa')).tiles.find(x => x.key === 'reagents.expiring')!.count;
    await sql("INSERT INTO reagents (id, name, lot_number, expiry_date, status, quantity) VALUES ('RGT-K1', 'Acetonitrile', 'L1', $1, 'Active', '1 L'), ('RGT-K2', 'Methanol', 'L2', $2, 'Active', '1 L')", [soon, far]);
    const after = await t.request.get('/api/metrics/kpi/reagents.expiring').set(H.qa);
    expect(after.body.total).toBe(before + 1);
    expect(after.body.rows.map((r: any) => r.id)).toContain('RGT-K1');
    expect(after.body.rows.map((r: any) => r.id)).not.toContain('RGT-K2');
  });
});

describe('the dashboard no longer invents a figure', () => {
  it('has no composite score, and its pending approvals agree between the number and the chart', async () => {
    const d = (await t.request.get('/api/dashboard').set(H.qa)).body;
    expect(d.complianceOverview).not.toHaveProperty('compositeScore');
    expect(d.complianceOverview).not.toHaveProperty('compositeStatus');
    expect(d.complianceOverview).not.toHaveProperty('summaryPillars');
    expect(d.complianceOverview.scoreBasis).toMatch(/No composite score/);
    expect(d.pendingApprovals).toBe(d.complianceOverview.pendingApprovals.total);
    expect(d.workloadData.find((w: any) => w.name === 'Pending Approvals').count).toBe(d.pendingApprovals);
    expect(d.complianceOverview.pendingApprovals.chartData.reduce((n: number, c: any) => n + c.count, 0)).toBe(d.pendingApprovals);
    expect(typeof d.complianceOverview.generatedAt).toBe('string');
  });
});
