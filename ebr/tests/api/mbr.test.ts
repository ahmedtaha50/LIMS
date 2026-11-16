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

const PW = 'mbr test password long';
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
  db = await freshDatabase('mbr'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-m', ['supervisor']); await account('qa-m', ['qa']); await account('both-m', ['supervisor', 'qa']); await account('op-m', ['operator']);
});
afterAll(async () => { await close(); await db.drop(); });

describe('master batch records (E09)', () => {
  let id = '', v1 = '';
  it('a supervisor creates a recipe; an operator can read but not design', async () => {
    const r = await call('sup-m', 'POST', '/api/mbrs', { code: 'PCM-500', productName: 'Paracetamol 500 mg tablets', design: design() });
    expect(r.status).toBe(201);
    id = r.body.id; v1 = r.body.version.id;
    expect((await call('op-m', 'POST', '/api/mbrs', { code: 'X-1', productName: 'X', design: design() })).status).toBe(403);
    expect((await call('op-m', 'GET', '/api/mbrs')).status).toBe(200);
    expect((await call('sup-m', 'POST', '/api/mbrs', { code: 'BAD-1', productName: 'X', design: { batchSize: { value: 1, unit: 'kg' }, phases: [] } })).status).toBe(400);
  });
  it('E09#1: draft -> in review -> approved -> effective; approval by QA and not by the author', async () => {
    expect((await call('sup-m', 'POST', `/api/mbrs/${id}/versions/${v1}/approve`, { rowVersion: 1, password: PW })).status).toBe(403);
    expect((await call('sup-m', 'POST', `/api/mbrs/${id}/versions/${v1}/submit`, { rowVersion: 1, password: PW })).body.status).toBe('in_review');
    expect((await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${v1}/make-effective`, { rowVersion: 2, password: PW })).body.code).toBe('wrong_state');
    expect((await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${v1}/approve`, { rowVersion: 2, password: PW, comment: 'checked against the registration dossier' })).body).toMatchObject({ status: 'approved', approvedBy: 'qa-m' });
    expect((await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${v1}/make-effective`, { rowVersion: 3, password: PW })).body.status).toBe('effective');
    const sigs = (await call('qa-m', 'GET', `/api/signatures?entity=mbr_version&entityId=${v1}`)).body;
    expect(sigs.map((s: { meaning: string; signerName: string }) => `${s.meaning}:${s.signerName}`)).toEqual(['authored:sup-m', 'approved:qa-m', 'approved:qa-m']);
  });
  it('E09#1: someone who holds both roles cannot approve the version they wrote', async () => {
    const r = await call('both-m', 'POST', '/api/mbrs', { code: 'SELF-1', productName: 'Self approval', design: design() });
    await call('both-m', 'POST', `/api/mbrs/${r.body.id}/versions/${r.body.version.id}/submit`, { rowVersion: 1, password: PW });
    const a = await call('both-m', 'POST', `/api/mbrs/${r.body.id}/versions/${r.body.version.id}/approve`, { rowVersion: 2, password: PW });
    expect(a.status).toBe(403); expect(a.body.code).toBe('same_person');
  });
  it('E09#3: an approved version cannot be edited, by the API or directly in the database; a change is a new draft', async () => {
    expect((await call('sup-m', 'PUT', `/api/mbrs/${id}/versions/${v1}`, { rowVersion: 4, design: design(13) })).body.code).toBe('wrong_state');
    await expect(db.pool.query("UPDATE mbr_versions SET design = '{}' WHERE id = $1", [v1])).rejects.toThrow(/its design cannot change/);
    await expect(db.pool.query('DELETE FROM mbr_versions WHERE id = $1', [v1])).rejects.toThrow(/never deleted/);
    const d = await call('sup-m', 'POST', `/api/mbrs/${id}/versions`);
    expect(d.body).toMatchObject({ versionNo: 2, status: 'draft', basedOn: v1 });
    expect((await call('sup-m', 'POST', `/api/mbrs/${id}/versions`)).body.code).toBe('version_open');
    const e = await call('sup-m', 'PUT', `/api/mbrs/${id}/versions/${d.body.id}`, { rowVersion: 1, design: design(13) });
    expect(e.status).toBe(200);
    expect((await call('sup-m', 'PUT', `/api/mbrs/${id}/versions/${d.body.id}`, { rowVersion: 1, design: design(14) })).status).toBe(409);
  });
  it('E09#2: one effective version at a time; making the new one effective retires the old one', async () => {
    const list = (await call('qa-m', 'GET', '/api/mbrs')).body.find((m: { code: string }) => m.code === 'PCM-500');
    const v2 = list.versions[1];
    await call('sup-m', 'POST', `/api/mbrs/${id}/versions/${v2.id}/submit`, { rowVersion: v2.rowVersion, password: PW });
    await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${v2.id}/approve`, { rowVersion: v2.rowVersion + 1, password: PW });
    await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${v2.id}/make-effective`, { rowVersion: v2.rowVersion + 2, password: PW });
    const after = (await call('qa-m', 'GET', '/api/mbrs')).body.find((m: { code: string }) => m.code === 'PCM-500');
    expect(after.versions.map((v: { status: string }) => v.status)).toEqual(['retired', 'effective']);
    await expect(db.pool.query("UPDATE mbr_versions SET status = 'effective' WHERE id = $1", [v1])).rejects.toThrow(/mbr_versions_one_effective/);
  });
  it('QA can send a version back with a signed reason; every step is in the audit trail', async () => {
    const d = await call('sup-m', 'POST', `/api/mbrs/${id}/versions`);
    await call('sup-m', 'POST', `/api/mbrs/${id}/versions/${d.body.id}/submit`, { rowVersion: 1, password: PW });
    expect((await call('qa-m', 'POST', `/api/mbrs/${id}/versions/${d.body.id}/reject`, { rowVersion: 2, password: PW, reason: 'limits differ from the validation report' })).body.status).toBe('draft');
    const actions = (await auditOf(db.pool, 'mbr', id)).map(e => e.action);
    expect(actions).toEqual(['mbr.created', 'mbr.submitted', 'mbr.approved', 'mbr.effective', 'mbr.new_version', 'mbr.draft_changed', 'mbr.submitted', 'mbr.approved', 'mbr.effective', 'mbr.new_version', 'mbr.submitted', 'mbr.rejected']);
  });
});
