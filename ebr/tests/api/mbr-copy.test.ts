import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf } from '../../server/audit/index.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { base32Encode, totp } from '../../server/identity/totp.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'mbr copy test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}
async function account(username: string, roles: string[]) {
  const secret = base32Encode(Buffer.from(username.padEnd(20, 'y').slice(0, 20)));
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $1, $2, $3, false, $4, true)', [username, await hashPassword(PW), roles, secret]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW, totp: totp(secret) }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
const design = (water = 12) => ({ batchSize: { value: 120, unit: 'kg' }, phases: [{ key: 'granulation', label: 'Granulation', steps: [
  { key: 'clearance', label: 'Line clearance', type: 'verified', text: 'Free of the previous product' },
  { key: 'water', label: 'Water added', type: 'data', unit: 'L', min: water - 2, max: water + 2 },
  { key: 'ratio', label: 'Water per kg', type: 'calculation', formula: 'water / 60', unit: 'L/kg' }] }] });

beforeAll(async () => {
  db = await freshDatabase('mbrcopy'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-m', ['supervisor']); await account('sup2-m', ['supervisor']); await account('qa-m', ['qa']); await account('op-m', ['operator']);
});
afterAll(async () => { await close(); await db.drop(); });

describe('copy a recipe into a new master (E23)', () => {
  let src = '', v1 = '', copy: any;   // eslint-disable-line @typescript-eslint/no-explicit-any
  let before: unknown;
  beforeAll(async () => {
    const r = await call('sup-m', 'POST', '/api/mbrs', { code: 'PCM-500', productName: 'Paracetamol 500 mg tablets', design: design() });
    src = r.body.id; v1 = r.body.version.id;
    await call('sup-m', 'POST', `/api/mbrs/${src}/versions/${v1}/submit`, { rowVersion: 1, password: PW });
    await call('qa-m', 'POST', `/api/mbrs/${src}/versions/${v1}/approve`, { rowVersion: 2, password: PW });
    await call('qa-m', 'POST', `/api/mbrs/${src}/versions/${v1}/make-effective`, { rowVersion: 3, password: PW });
    before = (await db.pool.query('SELECT * FROM mbr_versions WHERE master_id = $1 ORDER BY version_no', [src])).rows;
  });

  it('E23#1: a designer copies an effective version into a new master in draft, carrying the design and recording the source', async () => {
    expect((await call('op-m', 'POST', `/api/mbrs/${src}/versions/${v1}/copy`, { code: 'PCM-1000', productName: 'Paracetamol 1000 mg' })).status).toBe(403);
    const r = await call('sup2-m', 'POST', `/api/mbrs/${src}/versions/${v1}/copy`, { code: 'PCM-1000', productName: 'Paracetamol 1000 mg tablets' });
    expect(r.status).toBe(201);
    copy = r.body;
    expect(copy).toMatchObject({ code: 'PCM-1000', copiedFrom: { masterId: src, code: 'PCM-500', versionId: v1, versionNo: 1 } });
    expect(copy.version).toMatchObject({ versionNo: 1, status: 'draft', basedOn: v1, authorName: 'sup2-m', design: design() });
    expect(copy.id).not.toBe(src);
    expect((await call('sup2-m', 'POST', `/api/mbrs/${src}/versions/${v1}/copy`, { code: 'pcm-1000', productName: 'again' })).body.code).toBe('code_taken');
    expect((await call('sup2-m', 'POST', `/api/mbrs/${copy.id}/versions/${v1}/copy`, { code: 'X-2', productName: 'wrong master' })).status).toBe(404);
  });

  it('E23#1: any version can be copied, a draft or a retired one too', async () => {
    const d = await call('sup-m', 'POST', `/api/mbrs/${src}/versions`);
    const r = await call('sup-m', 'POST', `/api/mbrs/${src}/versions/${d.body.id}/copy`, { code: 'PCM-DRAFT-COPY', productName: 'From a draft' });
    expect(r.body.copiedFrom).toMatchObject({ versionNo: 2 });
  });

  it('E23#2: the copy is audited with its source, and changes nothing in the source', async () => {
    const a = await auditOf(db.pool, 'mbr', copy.id);
    expect(a.map((e: { action: string }) => e.action)).toEqual(['mbr.copied']);
    expect(a[0]).toMatchObject({ actorName: 'sup2-m', newValue: { code: 'PCM-1000', copiedFrom: { code: 'PCM-500', versionNo: 1 } } });
    const after = (await db.pool.query('SELECT * FROM mbr_versions WHERE master_id = $1 AND version_no = 1', [src])).rows;
    expect(after).toEqual([(before as unknown[])[0]]);
    expect((await auditOf(db.pool, 'mbr', src)).map((e: { action: string }) => e.action)).not.toContain('mbr.copied');
  });

  it('E23#2: the copy needs its own review and QA approval: its author cannot approve it, and no batch can use it before', async () => {
    const vid = copy.version.id;
    expect((await call('sup2-m', 'POST', `/api/mbrs/${copy.id}/versions/${vid}/approve`, { rowVersion: 1, password: PW })).status).toBe(403);
    const early = await call('sup2-m', 'POST', '/api/batches', { mbrMasterId: copy.id, batchNumber: 'B-COPY-1' });
    expect(early.body.code).toBe('no_effective_mbr');
    expect((await call('sup2-m', 'POST', `/api/mbrs/${copy.id}/versions/${vid}/submit`, { rowVersion: 1, password: PW })).body.status).toBe('in_review');
    expect((await call('qa-m', 'POST', `/api/mbrs/${copy.id}/versions/${vid}/approve`, { rowVersion: 2, password: PW })).body).toMatchObject({ status: 'approved', approvedBy: 'qa-m' });
    const sigs = (await call('qa-m', 'GET', `/api/signatures?entity=mbr_version&entityId=${vid}`)).body;
    expect(sigs.map((s: { meaning: string; signerName: string }) => `${s.meaning}:${s.signerName}`)).toEqual(['authored:sup2-m', 'approved:qa-m']);
  });
});
