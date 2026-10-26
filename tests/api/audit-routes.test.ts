/**
 * Audit trail routes (roadmap M08): verification access, keyset paging and filters, CSV export that is itself audited,
 * the per-record history, and the activity aggregate that replaces the randomly padded heat map.
 */
import { createHash } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { extractRouteTable } from '../helpers/routeTable';

let t: TestApp;
// Headers are built up front: a supertest request created before an await can lose its server (see tests/helpers/app.ts).
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst', { Authorization: string }>;
let writeAudit: typeof import('../../src/db/utils').writeAudit;
let db: any;

/** Writes through the real writer, one transaction per entry. */
async function seed(n: number, o: { user?: string; entity?: string; entityId?: string; action?: string; reason?: string } = {}) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = await db.transaction((tx: any) =>
      writeAudit(tx, o.user ?? 'usr-qa', o.action ?? 'Update', o.entity ?? 'Sample', o.entityId ?? 'S-1', 'state', `old ${i}`, `new ${i}`, o.reason ?? `reason ${i}`));
    out.push(e.sequence);
  }
  return out;
}

async function asOwner(sqlText: string, params: unknown[] = []) {
  const c = await t.db.pool.connect();
  try {
    await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    try { await c.query(sqlText, params); } finally { await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER'); }
  } finally { c.release(); }
}

/** RFC 4180 reader, enough for the export. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst: await t.auth('analyst1@gxp.com') };
  ({ db } = await import('../../src/db/index'));
  ({ writeAudit } = await import('../../src/db/utils'));
});

describe('POST /api/audit/verify', () => {
  it('is registered exactly once, behind authentication', () => {
    const routes = extractRouteTable(t.app).filter(r => r.method === 'POST' && r.path === '/api/audit/verify');
    expect(routes).toEqual([{ method: 'POST', path: '/api/audit/verify', auth: true }]);
  });

  it('is for Admin and QA only: Analyst and Reviewer get 403, no token gets 401', async () => {
    expect((await t.request.post('/api/audit/verify').set(H.analyst)).status).toBe(403);
    expect((await t.request.post('/api/audit/verify').set(H.reviewer)).status).toBe(403);
    expect((await t.request.post('/api/audit/verify')).status).toBe(401);
  });

  it('verifies the chain and reports what it covered', async () => {
    await seed(5);
    const res = await t.request.post('/api/audit/verify').set(H.qa);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isValid: true, compromisedSequence: null, reason: null });
    expect(res.body.totalRecords).toBeGreaterThanOrEqual(6);
    expect(res.body.headSequence).toBe(res.body.totalRecords);
    expect(res.body.versions['2']).toBeGreaterThanOrEqual(5);
    expect((await t.request.post('/api/audit/verify').set(H.admin)).status).toBe(200);
  });

  // Since the keyed chain (r2-audit-tamper, M35) the migration runner is the one writer that still appends unkeyed v1 rows after keyed
  // ones; any other unkeyed row after a keyed row is DOWNGRADE (tests/api/audit-tamper-review.test.ts).
  it('still verifies a chain that holds rows written by the old writer (no actor snapshot, hash_version 1)', async () => {
    const head = (await t.db.pool.query('SELECT sequence, hash FROM audit_trail ORDER BY sequence DESC LIMIT 1')).rows[0];
    const sequence = head.sequence + 1;
    const ts = new Date().toISOString();
    const content = JSON.stringify({ sequence, timestamp: ts, userId: 'usr-admin', action: 'Create', entity: 'SYSTEM_MIGRATION', entityId: 'L-1', field: 'all', oldValue: '', newValue: '{}', reason: 'old writer' });
    const hash = createHash('sha256').update(content + head.hash).digest('hex');
    // The column list of the writer that existed before this release (also the one src/server/migrate.ts still uses).
    await t.db.pool.query(
      `INSERT INTO audit_trail (id, sequence, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash, timestamp_str)
       VALUES ('adt-legacy-1', $1, 'usr-admin', 'Create', 'SYSTEM_MIGRATION', 'L-1', 'all', '', '{}', 'old writer', $2, $3, $4)`, [sequence, hash, head.hash, ts]);
    await seed(2);
    const res = await t.request.post('/api/audit/verify').set(H.qa);
    expect(res.body).toMatchObject({ isValid: true });
    expect(res.body.versions['1']).toBeGreaterThanOrEqual(1);
  });

  it('records the verification as a security event', async () => {
    const before = (await t.db.pool.query(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUDIT_VERIFY'`)).rows[0].n;
    await t.request.post('/api/audit/verify').set(H.qa);
    const rows = (await t.db.pool.query(`SELECT actor_id, outcome FROM security_events WHERE event_type = 'AUDIT_VERIFY' ORDER BY sequence`)).rows;
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]).toEqual({ actor_id: 'usr-qa', outcome: 'success' });
  });
});

describe('GET /api/audit', () => {
  it('is for Admin and QA only', async () => {
    expect((await t.request.get('/api/audit').set(H.analyst)).status).toBe(403);
    expect((await t.request.get('/api/audit').set(H.reviewer)).status).toBe(403);
    expect((await t.request.get('/api/audit')).status).toBe(401);
    expect((await t.request.get('/api/audit').set(H.qa)).status).toBe(200);
  });

  it('pages by cursor, newest first, without gaps or repeats even while entries are being added', async () => {
    await seed(120, { entity: 'Sample', entityId: 'PAGE-1' });
    await seed(30, { entity: 'Sample', entityId: 'PAGE-2', user: 'usr-admin' });
    const h = H.qa;
    const p1 = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-1', limit: 50 }).set(h);
    expect(p1.status).toBe(200);
    expect(p1.body.entries).toHaveLength(50);
    expect(p1.body.hasMore).toBe(true);
    const seqs1: number[] = p1.body.entries.map((e: any) => e.sequence);
    expect(seqs1).toEqual([...seqs1].sort((a, b) => b - a));
    expect(p1.body.nextCursor).toBe(seqs1[seqs1.length - 1]);

    await seed(1, { entity: 'Sample', entityId: 'PAGE-1' }); // arrives between two page requests

    const p2 = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-1', limit: 50, cursor: p1.body.nextCursor }).set(h);
    const p3 = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-1', limit: 50, cursor: p2.body.nextCursor }).set(h);
    expect(p2.body.entries).toHaveLength(50);
    expect(p3.body.entries).toHaveLength(20);
    expect(p3.body).toMatchObject({ hasMore: false, nextCursor: null });
    const all = [...p1.body.entries, ...p2.body.entries, ...p3.body.entries].map((e: any) => e.sequence);
    expect(new Set(all).size).toBe(120);
    expect(Math.max(...p2.body.entries.map((e: any) => e.sequence))).toBeLessThan(p1.body.nextCursor);
  });

  it('returns the whole record: actor snapshot, reason, hash fields', async () => {
    const res = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-2', limit: 1 }).set(H.qa);
    expect(res.body.entries[0]).toMatchObject({
      userId: 'usr-admin', actorName: 'Test Admin', actorRole: 'Admin', action: 'Update', entity: 'Sample', entityId: 'PAGE-2', field: 'state',
      hashVersion: 2, hashAlg: 'hmac-sha256-v1',
    });
    expect(res.body.entries[0].reason).toMatch(/^reason /);
    expect(res.body.entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters by user, role, action and time', async () => {
    await seed(3, { entity: 'Reagent', entityId: 'R-1', action: 'Calibrate', user: 'usr-analyst1' });
    const h = H.qa;
    const get = (q: Record<string, unknown>) => t.request.get('/api/audit').query({ limit: 500, ...q }).set(h);
    const byUser = await get({ userId: 'usr-admin', entity: 'Sample', entityId: 'PAGE-2' });
    expect(byUser.body.entries).toHaveLength(30);
    expect(byUser.body.entries.every((e: any) => e.userId === 'usr-admin')).toBe(true);
    const byAction = await get({ action: 'Calibrate' });
    expect(byAction.body.entries).toHaveLength(3);
    const byRole = await get({ actorRole: 'Analyst', entity: 'Reagent' });
    expect(byRole.body.entries).toHaveLength(3);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3600_000).toISOString();
    expect((await get({ action: 'Calibrate', from: hourAgo, to: hourAhead })).body.entries).toHaveLength(3);
    expect((await get({ action: 'Calibrate', to: hourAgo })).body.entries).toHaveLength(0);
    expect((await get({ action: 'Calibrate', from: hourAhead })).body.entries).toHaveLength(0);
  });

  it('can page oldest first', async () => {
    const h = H.qa;
    const a = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-2', order: 'asc', limit: 10 }).set(h);
    const seqs: number[] = a.body.entries.map((e: any) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const b = await t.request.get('/api/audit').query({ entity: 'Sample', entityId: 'PAGE-2', order: 'asc', limit: 10, cursor: a.body.nextCursor }).set(h);
    expect(b.body.entries[0].sequence).toBeGreaterThan(seqs[seqs.length - 1]);
  });

  it('rejects unknown, out-of-range and malformed query parameters with 400', async () => {
    const h = H.qa;
    for (const q of [{ bogus: 1 }, { limit: 501 }, { limit: 0 }, { cursor: 'abc' }, { cursor: -1 }, { from: 'yesterday' }, { order: 'sideways' }]) {
      const res = await t.request.get('/api/audit').query(q as any).set(h);
      expect(res.status, JSON.stringify(q)).toBe(400);
    }
  });

  it('GET /api/audit/head still reports the newest entry', async () => {
    const res = await t.request.get('/api/audit/head').set(H.qa);
    const head = (await t.db.pool.query('SELECT sequence, hash FROM audit_trail ORDER BY sequence DESC LIMIT 1')).rows[0];
    expect(res.body).toMatchObject({ sequence: head.sequence, hash: head.hash });
    expect((await t.request.get('/api/audit/head').set(H.analyst)).status).toBe(403);
  });
});

describe('GET /api/audit/history (the History tab of a record)', () => {
  it('is open to Admin, QA and Reviewer, not to Analyst', async () => {
    const q = { entity: 'Sample', entityId: 'PAGE-2' };
    expect((await t.request.get('/api/audit/history').query(q).set(H.reviewer)).status).toBe(200);
    expect((await t.request.get('/api/audit/history').query(q).set(H.qa)).status).toBe(200);
    expect((await t.request.get('/api/audit/history').query(q).set(H.admin)).status).toBe(200);
    expect((await t.request.get('/api/audit/history').query(q).set(H.analyst)).status).toBe(403);
    expect((await t.request.get('/api/audit/history').query(q)).status).toBe(401);
  });

  it('keeps the history of accounts, settings and the audit trail from a Reviewer, not from Admin or QA', async () => {
    for (const q of [{ entity: 'User', entityId: 'usr-qa' }, { entity: 'SystemSettings', entityId: 'default' }, { entity: 'Sample', entityId: 'PAGE-2', refs: 'System:backup-1' }, { entity: 'AuditTrail', entityId: 'x' }]) {
      expect((await t.request.get('/api/audit/history').query(q).set(H.reviewer)).status, JSON.stringify(q)).toBe(403);
    }
    expect((await t.request.get('/api/audit/history').query({ entity: 'User', entityId: 'usr-qa' }).set(H.qa)).status).toBe(200);
    expect((await t.request.get('/api/audit/history').query({ entity: 'SystemSettings', entityId: 'default' }).set(H.admin)).status).toBe(200);
  });

  it('needs the entity and its id, pages like /audit, and can include related records', async () => {
    const h = H.reviewer;
    expect((await t.request.get('/api/audit/history').query({ entity: 'Sample' }).set(h)).status).toBe(400);
    expect((await t.request.get('/api/audit/history').set(h)).status).toBe(400);
    expect((await t.request.get('/api/audit/history').query({ entity: 'Sample', entityId: 'PAGE-2', userId: 'x' }).set(h)).status).toBe(400);

    const one = await t.request.get('/api/audit/history').query({ entity: 'Sample', entityId: 'PAGE-2', limit: 25 }).set(h);
    expect(one.body.entries).toHaveLength(25);
    expect(one.body.hasMore).toBe(true);
    expect(one.body.entries.every((e: any) => e.entity === 'Sample' && e.entityId === 'PAGE-2')).toBe(true);

    const withRelated = await t.request.get('/api/audit/history').query({ entity: 'Sample', entityId: 'PAGE-2', refs: 'Reagent:R-1', limit: 100 }).set(h);
    const kinds = new Set(withRelated.body.entries.map((e: any) => `${e.entity}:${e.entityId}`));
    expect(kinds).toEqual(new Set(['Sample:PAGE-2', 'Reagent:R-1']));
    expect(withRelated.body.entries).toHaveLength(33);
    expect((await t.request.get('/api/audit/history').query({ entity: 'Sample', entityId: 'PAGE-2', refs: 'not-a-ref' }).set(h)).status).toBe(400);
  });
});

describe('POST /api/audit/export', () => {
  it('is for Admin and QA, and needs a reason', async () => {
    const body = { reason: 'Quarterly audit trail review', entity: 'Sample', entityId: 'PAGE-2' };
    expect((await t.request.post('/api/audit/export').send(body)).status).toBe(401);
    expect((await t.request.post('/api/audit/export').set(H.analyst).send(body)).status).toBe(403);
    expect((await t.request.post('/api/audit/export').set(H.reviewer).send(body)).status).toBe(403);
    expect((await t.request.post('/api/audit/export').set(H.qa).send({ entity: 'Sample' })).status).toBe(400);
    expect((await t.request.post('/api/audit/export').set(H.qa).send({ ...body, reason: 'x' })).status).toBe(400);
    expect((await t.request.post('/api/audit/export').set(H.qa).send({ ...body, limit: 5 })).status).toBe(400);
  });

  it('streams every matching row as CSV with a header, and the export is itself audited', async () => {
    const before = (await t.db.pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n;
    const res = await t.request.post('/api/audit/export').set(H.qa)
      .send({ reason: 'Quarterly audit trail review', entity: 'Sample', entityId: 'PAGE-2' })
      .buffer(true).parse((r, cb) => { let s = ''; r.setEncoding('utf8'); r.on('data', c => { s += c; }); r.on('end', () => cb(null, s)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-trail-.*\.csv"$/);
    const rows = parseCsv(res.body as string);
    expect(rows[0]).toEqual(['sequence', 'timestamp', 'user_id', 'actor_name', 'actor_role', 'session_id', 'app_version', 'action', 'entity', 'entity_id', 'field', 'old_value', 'new_value', 'reason', 'hash_version', 'hash_alg', 'hash', 'prev_hash', 'seal']);
    expect(rows).toHaveLength(31); // header + 30 matching rows
    const seqs = rows.slice(1).map(r => Number(r[0]));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // chain order
    expect(rows[1][2]).toBe('usr-admin');
    expect(rows[1][3]).toBe('Test Admin');

    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n).toBe(before + 1);
    const exp = (await t.db.pool.query(`SELECT * FROM audit_trail WHERE action = 'Export' ORDER BY sequence DESC LIMIT 1`)).rows[0];
    expect(exp).toMatchObject({ user_id: 'usr-qa', entity: 'AuditTrail', actor_role: 'QA', reason: 'Quarterly audit trail review' });
    const detail = JSON.parse(exp.new_value);
    expect(detail).toMatchObject({ filters: { entity: 'Sample', entityId: 'PAGE-2' } });
    expect(detail.throughSequence).toBe(exp.sequence - 1);
    expect(detail.throughSequence).toBeGreaterThanOrEqual(Math.max(...seqs));
    const ev = (await t.db.pool.query(`SELECT actor_id, outcome FROM security_events WHERE event_type = 'EXPORT' ORDER BY sequence DESC LIMIT 1`)).rows[0];
    expect(ev).toEqual({ actor_id: 'usr-qa', outcome: 'success' });
  });

  it('quotes commas, quotes and line breaks, and neutralises cells a spreadsheet would run as a formula', async () => {
    await seed(1, { entity: 'Csv', entityId: 'C-1', reason: 'He said "hi", then\nleft' });
    await seed(1, { entity: 'Csv', entityId: 'C-1', reason: '=HYPERLINK("http://x","y")' });
    await seed(1, { entity: 'Csv', entityId: 'C-1', reason: '+1' });
    await seed(1, { entity: 'Csv', entityId: 'C-1', reason: '@SUM(A1)' });
    const res = await t.request.post('/api/audit/export').set(H.admin)
      .send({ reason: 'csv check', entity: 'Csv' })
      .buffer(true).parse((r, cb) => { let s = ''; r.setEncoding('utf8'); r.on('data', c => { s += c; }); r.on('end', () => cb(null, s)); });
    const rows = parseCsv(res.body as string).slice(1);
    const reasons = rows.map(r => r[13]);
    expect(reasons).toEqual(['He said "hi", then\nleft', `'=HYPERLINK("http://x","y")`, "'+1", "'@SUM(A1)"]);
  });
});

describe('tamper evidence through the route', () => {
  it('POST /api/audit/verify names the altered entry', async () => {
    const [target] = await seed(1, { entity: 'Tamper', entityId: 'X-1' });
    await seed(3);
    await asOwner(`UPDATE audit_trail SET new_value = 'rewritten in SQL' WHERE sequence = $1`, [target]);
    const res = await t.request.post('/api/audit/verify').set(H.qa);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isValid: false, compromisedSequence: target, reason: 'LINK_BROKEN' });
    const ev = (await t.db.pool.query(`SELECT outcome FROM security_events WHERE event_type = 'AUDIT_VERIFY' ORDER BY sequence DESC LIMIT 1`)).rows[0];
    expect(ev.outcome).toBe('failure');
  });
});

describe('activity aggregate (replaces the randomly padded heat map)', () => {
  it('counts real audit rows by role and hour, with no invented workload', async () => {
    const { activityHeatmap } = await import('../../src/server/audit/activity');
    const total = (await t.db.pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n;
    const a = await activityHeatmap(db, 'UTC');
    const b = await activityHeatmap(db, 'UTC');
    expect(a).toEqual(b); // deterministic
    expect(a.every(c => Number.isInteger(c.hour) && c.hour >= 0 && c.hour < 24 && c.value >= 0)).toBe(true);
    expect(a.reduce((s, c) => s + c.value, 0)).toBe(total);
    // 'System' collects entries whose actor is not a user account (the installer and migration entries).
    expect(new Set(a.map(c => c.role))).toEqual(new Set(['Analyst', 'Reviewer', 'QA', 'Admin', 'System']));
    expect(a).toHaveLength(5 * 24);
  });

  it('uses the role recorded with the entry, and the time zone it is given', async () => {
    const { activityHeatmap } = await import('../../src/server/audit/activity');
    await t.db.pool.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    try {
      await t.db.pool.query(`UPDATE audit_trail SET actor_role = 'Admin', timestamp = '2026-03-01T22:30:00Z' WHERE entity = 'Csv'`);
    } finally { await t.db.pool.query('ALTER TABLE audit_trail ENABLE TRIGGER USER'); }
    const utc = await activityHeatmap(db, 'UTC');
    const cairo = await activityHeatmap(db, 'Africa/Cairo'); // UTC+2 in March: 22:30 is hour 0 of the next day
    const at = (cells: typeof utc, role: string, hour: number) => cells.find(c => c.role === role && c.hour === hour)!.value;
    expect(at(utc, 'Admin', 22)).toBeGreaterThanOrEqual(4);
    expect(at(cairo, 'Admin', 0)).toBeGreaterThanOrEqual(4);
  });
});
