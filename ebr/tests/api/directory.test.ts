import type { AddressInfo } from 'node:net';
import ldap from 'ldapjs';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf } from '../../server/audit/index.js';
import { authorizer, passwordCheck } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// A real LDAP server on the wire (ldapjs, test only): users, passwords and groups as a directory holds them.
const BASE = 'ou=people,dc=plant,dc=local', G = 'ou=groups,dc=plant,dc=local';
const people: Record<string, { password: string; displayName: string; memberOf: string[] }> = {
  'amal.h': { password: 'directory password one', displayName: 'Amal Hassan', memberOf: [`cn=ebr-operators,${G}`] },
  'omar.k': { password: 'directory password two', displayName: 'Omar Kamel', memberOf: [`cn=other-app,${G}`] },
};
const SERVICE = { dn: 'cn=svc-ebr,dc=plant,dc=local', password: 'service account password' };
function startDirectory(): Promise<{ port: number; close: () => void }> {
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
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as AddressInfo).port, close: () => srv.close() })));
}

const LOCAL_PW = 'break glass password long';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>, dirServer: { port: number; close: () => void };
async function login(username: string, password: string) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
function configure(port: number) {
  Object.assign(process.env, {
    EBR_LDAP_URL: `ldap://127.0.0.1:${port}`, EBR_LDAP_BIND_DN: SERVICE.dn, EBR_LDAP_BIND_PASSWORD: SERVICE.password, EBR_LDAP_BASE_DN: BASE,
    EBR_LDAP_USER_FILTER: '(uid={username})', EBR_LDAP_GROUP_ROLES: JSON.stringify({ [`cn=ebr-operators,${G}`]: 'operator', [`cn=ebr-supervisors,${G}`]: 'supervisor' }),
  });
}

beforeAll(async () => {
  db = await freshDatabase('directory'); await migrate(db.pool, MIGRATIONS);
  dirServer = await startDirectory(); configure(dirServer.port);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await db.pool.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password, break_glass) VALUES ('breakglass1', 'Break glass', $1, '{supervisor}', false, true)", [await hashPassword(LOCAL_PW)]);
});
afterAll(async () => { for (const k of Object.keys(process.env)) if (k.startsWith('EBR_LDAP_')) delete process.env[k]; dirServer.close(); await close(); await db.drop(); });

describe('directory sign-on (E17)', () => {
  it('E17#1: a directory user signs in with the directory password; the role comes from the group', async () => {
    const r = await login('amal.h', 'directory password one');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'amal.h', displayName: 'Amal Hassan' });
    expect(r.body.permissions).toContain('batch.execute');
    const u = (await db.pool.query("SELECT auth_source, roles, password_hash FROM users WHERE username = 'amal.h'")).rows[0];
    expect(u).toMatchObject({ auth_source: 'directory', roles: ['operator'], password_hash: '!directory' });   // no password stored here
  });
  it('a wrong directory password is refused like any wrong password, and audited', async () => {
    const r = await login('amal.h', 'not the password');
    expect(r.status).toBe(401);
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'amal.h'")).rows[0]!.id;
    expect((await auditOf(db.pool, 'user', id)).map(e => e.action)).toContain('auth.failed');
  });
  it('a directory user in no mapped group is refused with the reason', async () => {
    expect((await login('omar.k', 'directory password two')).body).toMatchObject({ code: 'no_role' });
  });
  it('E17#1: a change of groups in the directory changes the roles at the next sign-in, audited', async () => {
    people['amal.h']!.memberOf = [`cn=ebr-supervisors,${G}`];
    const r = await login('amal.h', 'directory password one');
    expect(r.body.permissions).toContain('batch.create');
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'amal.h'")).rows[0]!.id;
    expect((await auditOf(db.pool, 'user', id)).find(e => e.action === 'user.roles_from_directory')).toMatchObject({ oldValue: { roles: ['operator'] }, newValue: { roles: ['supervisor'] } });
  });
  it('an e-signature of a directory user is checked by the directory', async () => {
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'amal.h'")).rows[0]!.id;
    const check = passwordCheck(db.pool);
    expect(await check(id, 'directory password one')).toBe(true);
    expect(await check(id, 'wrong')).toBe(false);
  });
  it('a user name that tries LDAP filter syntax finds nobody', async () => {
    expect((await login('*)(uid=*', 'directory password one')).status).toBe(401);
  });
  it('E17#2: when the directory cannot be reached, sign-in fails with a clear message and break-glass accounts still work', async () => {
    dirServer.close();
    const r = await login('amal.h', 'directory password one');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'directory_unavailable', message: expect.stringMatching(/break-glass account/) });
    const bg = await login('breakglass1', LOCAL_PW);
    expect(bg.status).toBe(200);
    expect(bg.body.permissions).toContain('batch.create');
  });
});
