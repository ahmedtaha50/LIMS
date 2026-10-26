/**
 * Roadmap M41 (r3-directory), the part of directory sign-on that needs no database: filter escaping, DN comparison, the TLS
 * settings of the ldapts connector (LDAPS with a verified certificate; StartTLS before any bind), and the real ldapts client against a
 * real TLS socket (trusted CA, untrusted CA, nothing listening). No directory server is needed.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLdaptsConnector, clientOptionsOf, DirectoryUnavailableError, escapeFilterValue, leastPrivileged, normalizeDn, personFilter, tlsOptionsOf,
  type ConnectionSettings,
} from '../../src/server/auth/ldap';

const cfg = (over: Partial<ConnectionSettings> = {}): ConnectionSettings => ({
  url: 'ldaps://dc.corp.example:636', security: 'ldaps', caPem: null, bindDn: 'CN=svc,DC=corp,DC=example', bindPassword: 'x',
  baseDn: 'DC=corp,DC=example', groupAttribute: 'memberOf', timeoutMs: 2000, ...over,
});

describe('filter escaping (RFC 4515)', () => {
  it.each([
    ['plain.name@corp.example', 'plain.name@corp.example'],
    ['*', '\\2a'],
    ['a)(uid=*', 'a\\29\\28uid=\\2a'],
    ['x)(|(objectClass=*', 'x\\29\\28|\\28objectClass=\\2a'],
    ['back\\slash', 'back\\5cslash'],
    ['nul\0byte', 'nul\\00byte'],
    ['münchen', 'm\\c3\\bcnchen'],
  ])('%j is escaped to %j', (input, escaped) => expect(escapeFilterValue(input)).toBe(escaped));

  it('a hostile name can only ever be a value: the filter has exactly the fixed structure and no unescaped metacharacter from the input', () => {
    const hostile = 'x)(|(objectClass=*))(&(sAMAccountName=*';
    const f = personFilter(hostile);
    expect(f).toBe(`(&(objectClass=user)(objectCategory=person)(|(userPrincipalName=${escapeFilterValue(hostile)})(sAMAccountName=${escapeFilterValue(hostile)})(mail=${escapeFilterValue(hostile)})))`);
    // every ( and ) of the filter belongs to the fixed template: 7 pairs
    expect((f.match(/\(/g) ?? []).length).toBe(7);
    expect((f.match(/\)/g) ?? []).length).toBe(7);
    expect(f).not.toContain('=*');
  });
});

describe('DN comparison and role choice', () => {
  it('normalises case and the space around separators, and keeps an escaped comma inside its value', () => {
    expect(normalizeDn('CN=LIMS-QA , OU=Groups,DC=Corp, DC=Example')).toBe('cn=lims-qa,ou=groups,dc=corp,dc=example');
    expect(normalizeDn('CN=Doe\\, Jane,OU=Users')).toBe('cn=doe\\, jane,ou=users');
  });
  it('several mapped roles resolve to the least privileged one', () => {
    expect(leastPrivileged(['QA', 'Analyst', 'Reviewer'])).toBe('Analyst');
    expect(leastPrivileged(['QA', 'Reviewer'])).toBe('Reviewer');
    expect(leastPrivileged(['QA'])).toBe('QA');
  });
});

describe('TLS settings', () => {
  it('always verifies the server certificate, TLS 1.2 or newer, and trusts only the stored CA when there is one', () => {
    expect(tlsOptionsOf({ caPem: null })).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(tlsOptionsOf({ caPem: 'PEM' })).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: ['PEM'] });
  });
  it('refuses a URL whose scheme does not match the security mode: there is no plain-text LDAP', () => {
    expect(() => clientOptionsOf(cfg({ url: 'ldap://dc.corp.example', security: 'ldaps' }))).toThrow(DirectoryUnavailableError);
    expect(() => clientOptionsOf(cfg({ url: 'ldaps://dc.corp.example', security: 'starttls' }))).toThrow(DirectoryUnavailableError);
    expect(clientOptionsOf(cfg()).tlsOptions).toMatchObject({ rejectUnauthorized: true });
  });

  function recordingClient(failStartTls = false) {
    const calls: Array<[string, unknown?]> = [];
    const made: any[] = [];
    const make = (options: any) => {
      made.push(options);
      return {
        startTLS: async (o: unknown) => { calls.push(['startTLS', o]); if (failStartTls) throw new Error('TLS not supported'); },
        bind: async (dn: string) => { calls.push(['bind', dn]); },
        search: async () => ({ searchEntries: [], searchReferences: [] }),
        unbind: async () => { calls.push(['unbind']); },
      } as any;
    };
    return { calls, made, make };
  }

  it('LDAPS: TLS options go to the client, StartTLS is not used', async () => {
    const r = recordingClient();
    const conn = await createLdaptsConnector(r.make)(cfg({ caPem: 'PEM' }));
    await conn.bind('CN=svc', 'pw');
    expect(r.made[0].url).toBe('ldaps://dc.corp.example:636');
    expect(r.made[0].tlsOptions).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: ['PEM'] });
    expect(r.calls.map(c => c[0])).toEqual(['bind']);
  });

  it('StartTLS: upgraded with the verifying options BEFORE the first bind', async () => {
    const r = recordingClient();
    const conn = await createLdaptsConnector(r.make)(cfg({ url: 'ldap://dc.corp.example:389', security: 'starttls' }));
    await conn.bind('CN=svc', 'pw');
    expect(r.calls.map(c => c[0])).toEqual(['startTLS', 'bind']);
    expect(r.calls[0][1]).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it('StartTLS that fails ends the connection and nothing is bound (no credentials in clear)', async () => {
    const r = recordingClient(true);
    await expect(createLdaptsConnector(r.make)(cfg({ url: 'ldap://dc.corp.example:389', security: 'starttls' }))).rejects.toBeInstanceOf(DirectoryUnavailableError);
    expect(r.calls.map(c => c[0])).toEqual(['startTLS', 'unbind']);
  });
});

describe('the real ldapts client over a real TLS socket', () => {
  let dir: string;
  let server: tls.Server;
  let port: number;
  let caPem: string;
  let otherCa: string;
  const handshakes: string[] = [];

  function makeCert(name: string, san: string) {
    const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirtls-'));
    const good = makeCert('server', 'IP:127.0.0.1');
    caPem = good.cert;
    otherCa = makeCert('other', 'IP:127.0.0.1').cert;
    // Accepts the TLS handshake and then speaks no LDAP: enough to see whether the client verified the certificate.
    server = tls.createServer({ key: good.key, cert: good.cert, minVersion: 'TLSv1.2' }, socket => { handshakes.push(socket.getProtocol() ?? '?'); socket.on('error', () => {}); socket.end(); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const url = () => `ldaps://127.0.0.1:${port}`;

  it('trusts the server whose certificate the stored CA vouches for (the handshake completes, then there is no LDAP to speak)', async () => {
    const before = handshakes.length;
    const conn = await createLdaptsConnector()(cfg({ url: url(), caPem }));
    await expect(conn.bind('CN=svc', 'pw')).rejects.toBeInstanceOf(DirectoryUnavailableError);
    expect(handshakes.length).toBe(before + 1);
    expect(handshakes.at(-1)).toMatch(/^TLSv1\.[23]$/);
  });

  it('refuses a server whose certificate the stored CA does not vouch for: the handshake never completes', async () => {
    const before = handshakes.length;
    const conn = await createLdaptsConnector()(cfg({ url: url(), caPem: otherCa }));
    await expect(conn.bind('CN=svc', 'pw')).rejects.toBeInstanceOf(DirectoryUnavailableError);
    expect(handshakes.length).toBe(before);
  });

  it('a self-signed certificate is not trusted without the CA (system store only)', async () => {
    const before = handshakes.length;
    const conn = await createLdaptsConnector()(cfg({ url: url(), caPem: null }));
    await expect(conn.bind('CN=svc', 'pw')).rejects.toBeInstanceOf(DirectoryUnavailableError);
    expect(handshakes.length).toBe(before);
  });

  it('nothing listening: the directory is unavailable, quickly', async () => {
    const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
    const closedPort = (s.address() as net.AddressInfo).port; await new Promise(r => s.close(r));
    const conn = await createLdaptsConnector()(cfg({ url: `ldaps://127.0.0.1:${closedPort}`, caPem, timeoutMs: 2000 }));
    await expect(conn.bind('CN=svc', 'pw')).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });
});
