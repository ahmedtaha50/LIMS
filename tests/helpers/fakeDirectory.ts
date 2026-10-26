/**
 * An in-process stand-in for an Active Directory, for tests of src/server/auth/ldap.ts. It is a DirectoryConnector (the seam
 * setDirectoryConnector replaces), so everything above the wire is the product code. It behaves like the real thing where the code
 * depends on it:
 *   - a search filter is parsed the way a server does: the values of userPrincipalName / sAMAccountName / mail are un-escaped
 *     (RFC 4515) and an UNESCAPED * is a wildcard, so a filter built without escaping would match too much;
 *   - a bind with an EMPTY password succeeds (the unauthenticated-bind quirk of many servers) - the product must never send one;
 *   - while `reachable` is false every connection fails as a network error would.
 * It records every connection, bind and search so a test can assert what was sent.
 */
type Ldap = typeof import('../../src/server/auth/ldap');

export interface FakePerson {
  dn: string; guid: string; upn: string; sam: string; mail?: string; displayName: string; password: string;
  groups: string[]; uac?: number; accountExpires?: string;
}

export function createFakeDirectory(ldap: Ldap) {
  const state = {
    reachable: true,
    serviceDn: 'CN=svc-lims,OU=Service,DC=corp,DC=example', servicePassword: 'service-secret-1',
    people: new Map<string, FakePerson>(),
    connections: [] as Array<{ url: string; security: string; caPem: string | null }>,
    binds: [] as Array<{ dn: string; empty: boolean }>,
    searches: [] as Array<{ base: string; filter: string; scope: string }>,
  };
  const unescape = (v: string) => v.replace(/\\([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  const matches = (raw: string, value: string) => {
    const wild = raw.includes('*');
    const want = unescape(raw.replace(/\*/g, '\u0001')).toLowerCase();
    if (!wild) return unescape(raw).toLowerCase() === value.toLowerCase();
    const re = new RegExp('^' + want.split('\u0001').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(value.toLowerCase());
  };
  const entryOf = (p: FakePerson, groupAttribute: string) => ({
    dn: p.dn,
    attributes: {
      objectGUID: [p.guid], userAccountControl: [String(p.uac ?? 512)], accountExpires: [p.accountExpires ?? '9223372036854775807'],
      displayName: [p.displayName], userPrincipalName: [p.upn], sAMAccountName: [p.sam], ...(p.mail ? { mail: [p.mail] } : {}), [groupAttribute]: p.groups,
    } as Record<string, string[]>,
  });

  const connector: import('../../src/server/auth/ldap').DirectoryConnector = async (cfg) => {
    state.connections.push({ url: cfg.url, security: cfg.security, caPem: cfg.caPem });
    if (!state.reachable) throw new ldap.DirectoryUnavailableError('connect ECONNREFUSED (fake)');
    return {
      async bind(dn, password) {
        state.binds.push({ dn, empty: password === '' });
        if (dn === state.serviceDn) { if (password === state.servicePassword) return; throw new ldap.DirectoryInvalidCredentialsError(); }
        const p = [...state.people.values()].find(x => x.dn === dn);
        if (password === '') return; // unauthenticated bind "succeeds"
        if (p && p.password === password) return;
        throw new ldap.DirectoryInvalidCredentialsError();
      },
      async search(base, filter, _attributes, scope) {
        state.searches.push({ base, filter, scope });
        const groupAttribute = _attributes.find(a => !['objectGUID', 'entryUUID', 'userAccountControl', 'accountExpires', 'displayName', 'cn', 'mail', 'userPrincipalName', 'sAMAccountName'].includes(a)) ?? 'memberOf';
        if (scope === 'base') return [...state.people.values()].filter(p => p.dn === base).map(p => entryOf(p, groupAttribute));
        const m = /^\(&\(objectClass=user\)\(objectCategory=person\)\(\|\(userPrincipalName=(.*)\)\(sAMAccountName=(.*)\)\(mail=(.*)\)\)\)$/.exec(filter);
        if (!m) return [];
        return [...state.people.values()].filter(p => matches(m[1], p.upn) || matches(m[2], p.sam) || (p.mail !== undefined && matches(m[3], p.mail))).map(p => entryOf(p, groupAttribute));
      },
      async close() { /* nothing to release */ },
    };
  };

  return {
    state, connector,
    add(p: FakePerson) { state.people.set(p.guid, p); return p; },
    reset() { state.connections.length = 0; state.binds.length = 0; state.searches.length = 0; },
  };
}
