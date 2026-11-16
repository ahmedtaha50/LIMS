import type { AddressInfo } from 'node:net';
import ldap from 'ldapjs';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf } from '../../server/audit/index.js';
import { authorizer } from '../../server/identity/index.js';
import { base32Encode, totp } from '../../server/identity/totp.js';
import { hashPassword } from '../../server/identity/password.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// E31: the directory configured through the site settings only. A real LDAP server on the wire (ldapjs, test only): users, passwords and groups as a directory holds them.
const BASE = 'ou=people,dc=plant,dc=local', G = 'ou=groups,dc=plant,dc=local';
const people: Record<string, { password: string; displayName: string; memberOf: string[] }> = {
  'amal.h': { password: 'directory password one', displayName: 'Amal Hassan', memberOf: [`cn=ebr-operators,${G}`] },
  'omar.k': { password: 'directory password two', displayName: 'Omar Kamel', memberOf: [`cn=other-app,${G}`] },
};
const SERVICE = { dn: 'cn=svc-ebr,dc=plant,dc=local', password: 'service account password' };
function startDirectory(): Promise<{ port: number; close: () => void }> { return startDirectoryOn(0); }
function startDirectoryOn(at: number): Promise<{ port: number; close: () => void }> {
  const server = ldap.createServer();
  server.bind('dc=plant,dc=local', (req: any, res: any, next: (e?: unknown) => void) => {
    const dn = req.dn.toString().replace(/\s/g, ''), pw = String(req.credentials);
    if (dn === SERVICE.dn && pw === SERVICE.password) { res.end(); return next(); }
    const uid = /^uid=([^,]+),/.exec(dn)?.[1];
    if (uid && people[uid] && people[uid].password === pw) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
  });
  server.search(BASE, (req: any, res: any, next: () => void) => {
    const want = /uid=([^)]+)\)/.exec(req.filter.toString())?.[1];
    for (const [uid, p] of Object.entries(people)) if (uid === want) res.send({ dn: `uid=${uid},${BASE}`, attributes: { uid, displayname: p.displayName, memberof: p.memberOf } } as never);   // ldapjs matches requested attribute names in lower case
    res.end(); next();
  });
  const srv = server as any;
  return new Promise(r => srv.listen(at, '127.0.0.1', () => r({ port: (srv.address() as AddressInfo).port, close: () => srv.close() })));
}

const PW = 'directory settings admin password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>, dirServer: { port: number; close: () => void }, admin = '';
async function login(username: string, password: string, code?: string) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...(code ? { totp: code } : {}) }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)?.[1] ?? '', body: await r.json() as Record<string, any> };
}
async function call(method: string, path: string, body?: unknown, cookie = admin) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : undefined };
}
async function set(key: string, value: unknown, reason = 'directory of the plant, IT ticket 4711') {
  const cur = (await call('GET', '/api/settings')).body.find((s: { key: string }) => s.key === key);
  return call('PUT', `/api/settings/${key}`, { value, rowVersion: cur.rowVersion, reason, password: PW });
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('EBR_LDAP_')) delete process.env[k];
  process.env.EBR_LDAP_BIND_PASSWORD = SERVICE.password;                                     // the one secret: environment only
  db = await freshDatabase('dirsettings'); await migrate(db.pool, MIGRATIONS);
  dirServer = await startDirectory();
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  const secret = base32Encode(Buffer.from('dir-admin-secret-0001'.slice(0, 20)));
  await db.pool.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled, break_glass) VALUES ('adm-d', 'adm-d', $1, '{admin}', false, $2, true, true)", [await hashPassword(PW), secret]);
  admin = (await login('adm-d', PW, totp(secret))).cookie;
});
afterAll(async () => { delete process.env.EBR_LDAP_BIND_PASSWORD; dirServer.close(); await close(); await db.drop(); });

describe('directory settings managed in the application (E31)', () => {
  it('E31#1: with no directory set, sign-in is local only and the connection test says so', async () => {
    expect((await call('POST', '/api/settings/directory/test')).body.code).toBe('no_directory');
    expect((await login('amal.h', people['amal.h']!.password)).status).toBe(401);
  });

  it('E31#1: an administrator sets the directory with a reason and a signature; wrong values are refused', async () => {
    expect((await set('directory.userFilter', '(uid=amal.h)')).body.code).toBe('out_of_bounds');                      // no {username}
    expect((await set('directory.groupRoles', { [`cn=ebr-operators,${G}`]: 'superuser' })).body.code).toBe('out_of_bounds');
    expect((await set('directory.url', 'http://dc1')).body.code).toBe('out_of_bounds');
    for (const [k, v] of [['directory.url', `ldap://127.0.0.1:${dirServer.port}`], ['directory.baseDn', BASE], ['directory.userFilter', '(uid={username})'],
      ['directory.bindDn', SERVICE.dn], ['directory.groupRoles', { [`cn=ebr-operators,${G}`]: 'operator' }]] as const) expect((await set(k, v)).status).toBe(200);
    const list = (await call('GET', '/api/settings')).body;
    expect(list.some((s: { key: string }) => /password/i.test(s.key))).toBe(false);                                   // the secret is never a setting
    const a = await auditOf(db.pool, 'site_setting', 'directory.groupRoles');
    expect(a.filter(e => e.action === 'setting.changed').map(e => e.newValue)).toEqual([{ [`cn=ebr-operators,${G}`]: 'operator' }]);
  });

  it('E31#2: the connection test reports the directory, the service account and the base, and signs nobody in', async () => {
    const users = async () => (await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const before = await users();
    expect((await call('POST', '/api/settings/directory/test')).body).toMatchObject({ reachable: true, serviceAccount: true, baseFound: true });
    await set('directory.bindDn', 'cn=nobody,dc=plant,dc=local', 'testing a wrong service account');
    expect((await call('POST', '/api/settings/directory/test')).body).toMatchObject({ reachable: true, serviceAccount: false, message: expect.stringMatching(/refused the service account/) });
    await set('directory.bindDn', SERVICE.dn, 'back to the right service account');
    const port = dirServer.port; dirServer.close();
    expect((await call('POST', '/api/settings/directory/test')).body).toMatchObject({ reachable: false, serviceAccount: false });
    dirServer = await startDirectoryOn(port);
    expect(await users()).toBe(before);
    expect((await login('amal.h', 'wrong')).status).toBe(401);                                               // a wrong password still fails
  });

  it('E31#3: a change holds for the next sign-in: the group mapped to another role gives that role', async () => {
    const first = await login('amal.h', people['amal.h']!.password);
    expect(first.status).toBe(200);
    const roles = async () => (await db.pool.query("SELECT roles FROM users WHERE username = 'amal.h'")).rows[0].roles;
    expect(await roles()).toEqual(['operator']);
    expect((await call('GET', '/api/auth/me', undefined, first.cookie)).body.permissions).not.toContain('batch.create');
    await set('directory.groupRoles', { [`cn=ebr-operators,${G}`]: 'supervisor' }, 'operators group now holds supervisors');
    const next = await login('amal.h', people['amal.h']!.password);
    expect(await roles()).toEqual(['supervisor']);
    expect((await call('GET', '/api/auth/me', undefined, next.cookie)).body.permissions).toContain('batch.create');
  });
});
