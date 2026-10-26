/**
 * Roadmap M24 (r2-ui-foundation): the list contract behind DataGrid and the audited export.
 *
 *   GET  /api/lists/samples          server-side search, filter and sort, keyset (cursor) paging both ways, honest totals
 *   POST /api/lists/samples/export   every matching row (never silently capped), formula-safe CSV / XLSX, audited in the same
 *                                    transaction with the user, the filter, the row count and the sha256 of the delivered bytes
 *
 * Real application, real PostgreSQL. Rows are arranged with SQL (a list test needs many samples, not the registration path).
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let analyst: { Authorization: string };
const STATES = ['Logged', 'Testing', 'Pending Review', 'Approved', 'Rejected'];
const N = 130;

beforeAll(async () => {
  t = await startTestApp();
  analyst = await t.auth('analyst1@gxp.com');
  // 130 samples, one per second, materials Alpha..Mu repeating, states cycling. ids SMP-2026-L0001 ...
  await t.db.pool.query(`
    INSERT INTO samples (id, material, batch, state, created_by, created_at, version)
    SELECT 'SMP-2026-L' || lpad(g::text, 4, '0'),
           (ARRAY['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima','Mu'])[1 + g % 13] || ' 500mg',
           'BATCH-' || (g % 7),
           (ARRAY['Logged','Testing','Pending Review','Approved','Rejected'])[1 + g % 5],
           'usr-analyst1', timestamptz '2026-03-01 08:00:00+00' + make_interval(secs => g), 1
    FROM generate_series(1, ${N}) g`);
});

const list = async (query: Record<string, string | number | undefined> = {}) => {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  return t.request.get(`/api/lists/samples${qs ? `?${qs}` : ''}`).set(analyst);
};

describe('GET /lists/samples: the list contract', () => {
  it('answers page 1 newest first with the total, the position and a cursor for the next page only', async () => {
    const res = await list({ limit: 50 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toHaveLength(50);
    expect(res.body.total).toBe(N);
    expect(res.body.offset).toBe(0);
    expect(res.body.prevCursor).toBeNull();
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.rows[0].id).toBe('SMP-2026-L0130');
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(['batch', 'createdAt', 'createdBy', 'createdByName', 'id', 'material', 'specId', 'specRevision', 'state', 'version'].sort());
    expect(res.body.rows[0].createdByName).toBe('Test Analyst One');
  });

  it('walks every row exactly once forwards, and the previous cursor returns the same page', async () => {
    const seen: string[] = [];
    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(cursor ? { limit: 50, after: cursor } : { limit: 50 });
      expect(res.status).toBe(200);
      pages.push(res.body);
      seen.push(...res.body.rows.map((r: any) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(pages.map(p => p.rows.length)).toEqual([50, 50, 30]);
    expect(pages.map(p => p.offset)).toEqual([0, 50, 100]);
    expect(new Set(seen).size).toBe(N);
    const back = await list({ limit: 50, before: pages[2].prevCursor });
    expect(back.body.rows.map((r: any) => r.id)).toEqual(pages[1].rows.map((r: any) => r.id));
    expect(back.body.offset).toBe(50);
    expect(back.body.nextCursor).toBeTruthy();
    expect(back.body.prevCursor).toBeTruthy();
    const first = await list({ limit: 50, before: pages[1].prevCursor });
    expect(first.body.rows.map((r: any) => r.id)).toEqual(pages[0].rows.map((r: any) => r.id));
    expect(first.body.prevCursor).toBeNull();
  });

  it('sorts on the server by the requested column, ties broken by id, in the database order', async () => {
    const expected = (await t.db.pool.query(`SELECT id FROM samples ORDER BY material ASC, id ASC`)).rows.map(r => r.id);
    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list({ sort: 'material', dir: 'asc', limit: 40, ...(cursor ? { after: cursor } : {}) });
      expect(res.status).toBe(200);
      got.push(...res.body.rows.map((r: any) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(got).toEqual(expected);
  });

  it('searches the whole table on the server (id, material, batch; case-insensitive), not the page in the browser', async () => {
    const res = await list({ q: 'l0003', limit: 10 });
    expect(res.body.rows.map((r: any) => r.id)).toEqual(['SMP-2026-L0003']); // the oldest row: never on page 1
    const byMaterial = await list({ q: 'juliet', limit: 200 });
    expect(byMaterial.body.total).toBe(byMaterial.body.rows.length);
    expect(byMaterial.body.rows.every((r: any) => r.material === 'Juliet 500mg')).toBe(true);
    const literal = await list({ q: '%' });
    expect(literal.body.total).toBe(0); // % and _ are literal characters, not wildcards
  });

  it('filters by state, including Logged', async () => {
    for (const state of STATES) {
      const res = await list({ state, limit: 200 });
      const count = Number((await t.db.pool.query(`SELECT count(*) FROM samples WHERE state = $1`, [state])).rows[0].count);
      expect(res.body.total, state).toBe(count);
      expect(res.body.rows.every((r: any) => r.state === state), state).toBe(true);
    }
  });

  it('pages correctly through timestamps that differ by microseconds (a millisecond cursor would skip rows)', async () => {
    await t.db.pool.query(`
      INSERT INTO samples (id, material, batch, state, created_by, created_at, version) VALUES
      ('SMP-2026-U0001', 'Micro 1', 'MB', 'Logged', 'usr-analyst1', '2027-01-01 00:00:00.123100+00', 1),
      ('SMP-2026-U0002', 'Micro 2', 'MB', 'Logged', 'usr-analyst1', '2027-01-01 00:00:00.123400+00', 1),
      ('SMP-2026-U0003', 'Micro 3', 'MB', 'Logged', 'usr-analyst1', '2027-01-01 00:00:00.123700+00', 1)`);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list({ q: 'Micro', limit: 1, ...(cursor ? { after: cursor } : {}) });
      ids.push(...res.body.rows.map((r: any) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor && ids.length < 10);
    expect(ids).toEqual(['SMP-2026-U0003', 'SMP-2026-U0002', 'SMP-2026-U0001']);
    await t.db.pool.query(`DELETE FROM samples WHERE id LIKE 'SMP-2026-U%'`);
  });

  it('refuses what it does not understand (strict query): unknown keys, sort columns, limits, cursors, both directions', async () => {
    for (const q of [{ foo: 1 }, { sort: 'password' }, { dir: 'up' }, { limit: 0 }, { limit: 201 }, { after: 'not-a-cursor' }, { after: 'x', before: 'y' }]) {
      const res = await list(q as any);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.code, JSON.stringify(q)).toBe('VALIDATION_FAILED');
    }
  });

  it('needs a signed-in user', async () => {
    expect((await t.request.get('/api/lists/samples')).status).toBe(401);
  });
});

// ---- export --------------------------------------------------------------------------------------------------------------------------

const exportSamples = async (body: Record<string, unknown>, who = analyst) => t.request.post('/api/lists/samples/export').set(who).send(body);
const decode = (body: any) => Buffer.from(body.content, 'base64');

describe('POST /lists/samples/export: a controlled output', () => {
  it('delivers every matching row as CSV and audits the user, the filter, the row count and the sha256 in the audit trail', async () => {
    const before = Number((await t.db.pool.query(`SELECT coalesce(max(sequence), 0) AS s FROM audit_trail`)).rows[0].s);
    const res = await exportSamples({ format: 'csv', state: 'Testing', sort: 'id', dir: 'asc', reason: 'Monthly QC review' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bytes = decode(res.body);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 byte-order mark: spreadsheets read non-Latin names correctly
    const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
    const expected = (await t.db.pool.query(`SELECT id FROM samples WHERE state = 'Testing' ORDER BY id`)).rows.map(r => r.id);
    expect(res.body.rowCount).toBe(expected.length);
    expect(lines.length).toBe(expected.length + 1);
    expect(lines[0]).toMatch(/^Sample ID,Material,Batch,State,/);
    expect(lines.slice(1).map(l => l.split(',')[0])).toEqual(expected);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(res.body.sha256).toBe(sha);
    expect(res.body.fileName).toMatch(/^samples-.*\.csv$/);

    const audit = (await t.db.pool.query(`SELECT * FROM audit_trail WHERE sequence > $1 AND action = 'Export'`, [before])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe('usr-analyst1');
    expect(audit[0].entity).toBe('SampleList');
    expect(audit[0].reason).toBe('Monthly QC review');
    const recorded = JSON.parse(audit[0].new_value);
    expect(recorded).toMatchObject({ format: 'csv', rowCount: expected.length, sha256: sha, fileName: res.body.fileName, filter: { state: 'Testing' }, sort: { key: 'id', dir: 'asc' } });
    expect(res.body.auditSequence).toBe(Number(audit[0].sequence));
  });

  it('never caps silently: an export without a filter has every row the list counts', async () => {
    const total = (await list({ limit: 1 })).body.total;
    const res = await exportSamples({ format: 'csv', reason: 'Full extract' });
    expect(res.body.rowCount).toBe(total);
    expect(decode(res.body).toString('utf8').trimEnd().split('\r\n').length).toBe(total + 1);
  });

  it('neutralises spreadsheet formulas in CSV (prefix apostrophe) and writes XLSX cells as text, never as formulas', async () => {
    await t.db.pool.query(`INSERT INTO samples (id, material, batch, state, created_by, version) VALUES
      ('SMP-2026-F0001', '=HYPERLINK("http://evil","x")', '+cmd', 'Logged', 'usr-analyst1', 1),
      ('SMP-2026-F0002', '@SUM(A1)', '-2+3', 'Logged', 'usr-analyst1', 1)`);
    const csv = decode((await exportSamples({ format: 'csv', q: 'SMP-2026-F', sort: 'id', dir: 'asc', reason: 'Formula check' })).body).toString('utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`'+cmd`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(csv).toContain(`'-2+3`);

    const res = await exportSamples({ format: 'xlsx', q: 'SMP-2026-F', sort: 'id', dir: 'asc', reason: 'Formula check' });
    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/\.xlsx$/);
    const bytes = decode(res.body);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(res.body.sha256);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-'));
    const file = path.join(dir, 'x.xlsx');
    fs.writeFileSync(file, bytes);
    const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) expect(listing).toContain(part);
    execFileSync('unzip', ['-tq', file]); // CRCs are right
    const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
    expect(sheet).not.toMatch(/<f[ >]/);
    expect(sheet).toContain('=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)');
    expect((sheet.match(/<row /g) ?? []).length).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates strictly: a reason is required, the actor cannot be supplied, unknown formats are refused', async () => {
    for (const body of [{ format: 'csv' }, { format: 'csv', reason: 'x' }, { format: 'pdf', reason: 'Valid reason' }, { format: 'csv', reason: 'Valid reason', userId: 'usr-admin' }, { format: 'csv', reason: 'Valid reason', limit: 10 }]) {
      const res = await exportSamples(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('needs a signed-in user', async () => {
    expect((await t.request.post('/api/lists/samples/export').send({ format: 'csv', reason: 'No session' })).status).toBe(401);
  });
});

describe('scale', () => {
  it('50 000 samples: page 1, sorted and searched, answers in well under a second', async () => {
    await t.db.pool.query(`
      INSERT INTO samples (id, material, batch, state, created_by, created_at, version)
      SELECT 'SMP-2025-' || lpad(g::text, 5, '0'), 'Scale material ' || (g % 97), 'SB-' || (g % 501),
             (ARRAY['Logged','Testing','Pending Review','Approved','Rejected'])[1 + g % 5], 'usr-analyst1',
             timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => g), 1
      FROM generate_series(1, 50000) g`);
    await t.db.pool.query('ANALYZE samples');
    for (const q of [{ limit: 50 }, { limit: 50, sort: 'material', dir: 'asc' }, { limit: 50, q: 'material 42', state: 'Testing' }]) {
      await list(q); // warm
      const t0 = performance.now();
      const res = await list(q);
      const ms = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(res.body.rows.length).toBeGreaterThan(0);
      expect(ms, `${JSON.stringify(q)} took ${ms.toFixed(0)} ms`).toBeLessThan(500);
    }
  });
});
