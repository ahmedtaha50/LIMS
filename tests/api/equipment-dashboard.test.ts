/**
 * Roadmap M13 (r1-quality-fixes), the dashboard tells the truth.
 *
 * Before: the trend chart was four hard-coded months plus two derived ones ("Jan 40 samples, 2 OOS"), an empty OOS list became a
 * one-slice "None" chart, reagent counts read a column that does not exist, every batch that was not Released (a Rejected one too)
 * counted as awaiting release, an instrument was overdue from 00:00 UTC of its due date, and the composite score said "GxP Audit Ready"
 * whatever it was computed from.
 *
 * After: every figure is an aggregate of real rows. With nothing recorded the charts are empty and the screen says so.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
let analyst: { Authorization: string };
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const dateFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const get = async () => { const res = await t.request.get('/api/dashboard').set(analyst); expect(res.status, JSON.stringify(res.body)).toBe(200); return res.body; };

/** The first day of the month `back` months ago (UTC), as 'YYYY-MM-DD'. */
function monthStart(back: number) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
}

beforeAll(async () => {
  t = await startTestApp();
  analyst = await t.auth('analyst1@gxp.com');
});

describe('with nothing recorded', () => {
  it('the dashboard with no samples shows an empty trend: no literals, no placeholder slice, zero counts', async () => {
    const d = await get();
    expect(d.trendData).toEqual([]);
    expect(d.oosChartData).toEqual([]);
    expect(d).toMatchObject({ activeOos: 0, pendingReviews: 0, overdueInstruments: 0, reagentsActive: 0, reagentsExpired: 0 });
    expect(d.upcomingCalibrations).toEqual([]);
    expect(d.complianceOverview.pendingApprovals.total).toBe(0);
    expect(d.complianceOverview.calibrations.totalInstruments).toBe(0);
    expect(JSON.stringify(d)).not.toMatch(/"name":"(Jan|Feb|Mar|Apr)"/);
  });

  it('does not describe an empty system as audit ready', async () => {
    const d = await get();
    expect(JSON.stringify(d.complianceOverview)).not.toMatch(/Audit Ready/i);
    expect(typeof d.complianceOverview.scoreBasis).toBe('string');
  });
});

describe('the trend is the real monthly count', () => {
  it('counts samples registered and OOS raised per calendar month for the last six months, zero where nothing happened', async () => {
    const s1 = await registerSample(t);
    const s2 = await registerSample(t);
    const s3 = await registerSample(t);
    await sql(`UPDATE samples SET created_at = $2::timestamptz WHERE id = $1`, [s1.id, `${monthStart(1)}T10:00:00Z`]);
    await sql(`UPDATE samples SET created_at = $2::timestamptz WHERE id = $1`, [s2.id, `${monthStart(1)}T11:00:00Z`]);
    await sql(`UPDATE samples SET created_at = $2::timestamptz WHERE id = $1`, [s3.id, `${monthStart(4)}T09:00:00Z`]);
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Assay (%)', $4, 'Open')`, [uniq('OOS'), s1.id, s1.result.id, `${monthStart(1)}`]);

    const d = await get();
    expect(d.trendData).toHaveLength(6);
    const byMonth = Object.fromEntries(d.trendData.map((p: any) => [p.month, p]));
    expect(Object.keys(byMonth)).toEqual([5, 4, 3, 2, 1, 0].map(k => monthStart(k).slice(0, 7)));
    expect(byMonth[monthStart(1).slice(0, 7)]).toMatchObject({ samples: 2, oos: 1 });
    expect(byMonth[monthStart(4).slice(0, 7)]).toMatchObject({ samples: 1, oos: 0 });
    expect(byMonth[monthStart(0).slice(0, 7)]).toMatchObject({ samples: 0, oos: 0 });
    expect(byMonth[monthStart(2).slice(0, 7)]).toMatchObject({ samples: 0, oos: 0 });
    expect(d.trendData.every((p: any) => typeof p.name === 'string' && p.name.length > 0)).toBe(true);
  });

  it('a sample or OOS older than the window is not in the trend', async () => {
    const s = await registerSample(t);
    await sql(`UPDATE samples SET created_at = '2019-03-04T10:00:00Z' WHERE id = $1`, [s.id]);
    const d = await get();
    const total = d.trendData.reduce((n: number, p: any) => n + p.samples, 0);
    expect(total).toBe(3);
  });
});

describe('the OOS distribution', () => {
  it('lists the real parameters with their counts, and nothing when there are none', async () => {
    const s = await registerSample(t);
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Dissolution (%)', $4, 'Open')`, [uniq('OOS'), s.id, s.result.id, dateFromToday(0)]);
    const d = await get();
    const rows = await sql(`SELECT parameter, count(*)::int AS n FROM oos_investigations GROUP BY parameter ORDER BY parameter`);
    expect([...d.oosChartData].sort((a: any, b: any) => a.name.localeCompare(b.name))).toEqual(rows.map(r => ({ name: r.parameter, value: r.n })));
    // A closed investigation has the status 'Approved' today ('Closed' is the word the roadmap moves to): neither is active.
    expect(d.activeOos).toBe((await one(`SELECT count(*)::int AS n FROM oos_investigations WHERE status NOT IN ('Approved', 'Closed')`)).n);
  });
});

describe('calibration horizon: an instrument is current through the end of its due date', () => {
  it('buckets by whole days from today (UTC): due today is Critical, yesterday Overdue, 8 days Approaching, 31 days Compliant', async () => {
    const add = (id: string, due: string, status = 'Active') => sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, $1, 'Weighing', $2, $3, '2025-01-01T00:00:00.000Z')`, [id, status, due]);
    await add('INST-DASH-TODAY', dateFromToday(0));
    await add('INST-DASH-YEST', dateFromToday(-1));
    await add('INST-DASH-8', dateFromToday(8));
    await add('INST-DASH-31', dateFromToday(31));
    const d = await get();
    const items = Object.fromEntries(d.complianceOverview.calibrations.items.map((i: any) => [i.id, i]));
    expect(items['INST-DASH-TODAY']).toMatchObject({ daysRemaining: 0, urgency: 'Critical' });
    expect(items['INST-DASH-YEST']).toMatchObject({ daysRemaining: -1, urgency: 'Overdue' });
    expect(items['INST-DASH-8']).toMatchObject({ daysRemaining: 8, urgency: 'Approaching' });
    expect(items['INST-DASH-31']).toMatchObject({ daysRemaining: 31, urgency: 'Compliant' });
    expect(d.overdueInstruments).toBe(1);
    expect(d.complianceOverview.calibrations).toMatchObject({ totalInstruments: 4, overdueCount: 1, criticalCount: 1, approachingCount: 1, compliantCount: 1 });
    expect(d.upcomingCalibrations.map((i: any) => i.id).sort()).toEqual(['INST-DASH-8', 'INST-DASH-TODAY']);
  });
});

describe('what awaits an approval', () => {
  it('counts only Quarantine Hold batches (a Rejected or Released one does not wait), Pending Review samples and unsigned worksheets', async () => {
    const s = await registerSample(t);
    await sql(`UPDATE samples SET state = 'Pending Review' WHERE id = $1`, [s.id]);
    await sql(`INSERT INTO batch_releases (id, batch, status) VALUES ($1, $2, 'Quarantine Hold'), ($3, $4, 'Rejected'), ($5, $6, 'Released')`,
      [uniq('BR'), uniq('B-HOLD'), uniq('BR'), uniq('B-REJ'), uniq('BR'), uniq('B-REL')]);
    const w = await t.request.post('/api/eln').set(analyst).send({ title: uniq('W'), content: 'c' });
    const signed = await t.request.post('/api/eln').set(analyst).send({ title: uniq('W'), content: 'c' });
    await sql(`UPDATE lab_notebook SET status = 'Signed', locked = true WHERE id = $1`, [signed.body.id]);

    const d = await get();
    const p = d.complianceOverview.pendingApprovals;
    expect(p.batchCount).toBe(1);
    expect(p.sampleCount).toBe((await one(`SELECT count(*)::int AS n FROM samples WHERE state = 'Pending Review'`)).n);
    expect(p.elnCount).toBe((await one(`SELECT count(*)::int AS n FROM lab_notebook WHERE status = 'Draft'`)).n);
    expect(p.items.some((i: any) => i.id === w.body.id)).toBe(true);
    expect(p.items.some((i: any) => i.id === signed.body.id)).toBe(false);
    expect(p.total).toBe(p.sampleCount + p.elnCount + p.oosCount + p.batchCount);
    expect(d.pendingReviews).toBe(p.sampleCount);
  });
});

describe('how the dashboard is computed', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes/dashboard.ts'), 'utf8');
  const widget = fs.readFileSync(path.resolve(__dirname, '../../src/components/ComplianceOverviewWidget.tsx'), 'utf8');
  const screen = fs.readFileSync(path.resolve(__dirname, '../../src/components/Dashboard.tsx'), 'utf8');

  it('has no invented figure: no Math.random, no month literals, no "None" placeholder, no reads of a column that does not exist', () => {
    expect(route).not.toMatch(/Math\.random/);
    expect(route).not.toMatch(/name:\s*'(Jan|Feb|Mar|Apr|May|Jun)'/);
    expect(route).not.toMatch(/name:\s*'None'/);
    expect(route).not.toMatch(/expirationDate/);
  });

  it('loads no whole table into memory for a count (findMany of samples, notebook, users, training, batches, reagents)', () => {
    for (const table of ['samples', 'labNotebook', 'users', 'trainingRecords', 'batchReleases', 'reagents', 'oosInvestigations']) {
      expect(route, table).not.toContain(`db.query.${table}.findMany`);
    }
  });

  it('the screen does not claim validation, does not hide a failed load, and says when there is nothing to chart; the widget has no "Audit Ready" default', () => {
    expect(screen).not.toMatch(/Part 11 Validated/);
    expect(screen).toMatch(/res\.ok|apiFetch/);
    // r3-i18n: the empty-chart sentence moved from the source into the English catalogue (key dash.trend.empty), which the screen reads.
    expect(screen).toContain("t('dash.trend.empty')");
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'i18n', 'en.json'), 'utf8')).toMatch(/"dash\.trend\.empty": "No (samples|data)/i);
    expect(widget).not.toMatch(/Audit Ready/);
  });
});
