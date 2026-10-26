/**
 * Directory (LDAP / Active Directory) sign-on (roadmap M41, r3-directory; migration 0310_directory).
 *
 * The directory is one more principal resolver (src/server/auth/directory/index.ts). It proves who a person is; everything after that
 * (lockouts, the TOTP second factor, sessions, audit) is the existing identity module working on a local users row, so a directory
 * account has the same controls as a local one. What it adds:
 *
 *   transport      LDAPS, or StartTLS on ldap://; the server certificate is always verified (against the stored CA when there is one),
 *                  TLS 1.2 at least. There is no plain-text mode: the settings check constraint and the connector both refuse it.
 *   search         a service account (bind password = keystore ciphertext) finds the person by UPN, sAMAccountName or mail. The typed
 *                  name only ever enters a filter through escapeFilterValue (RFC 4515). The person's own password is then checked by
 *                  binding as the DN the search returned, after userAccountControl / lockout / expiry were checked: a disabled account
 *                  is refused before its password is tried. An empty password is refused (it would be an anonymous bind).
 *   roles          the groups of the person (memberOf) are matched with the QA-approved mapping (directory_group_roles) at EVERY sign-in.
 *                  The role of the account follows the mapping; no approved mapping for any of the groups = no account and no sign-in.
 *                  The Administrator role cannot be mapped. A directory account is created only when a mapping gives it a role.
 *   break-glass    a local Administrator flagged in directory_accounts (kind break-glass, MFA enrolled) may sign in with its local
 *                  password only while the directory cannot be reached; every use is a security event. While the directory answers,
 *                  that account is refused: the directory is the one source of truth.
 *   failures       every refusal answers with the generic INVALID_CREDENTIALS; the reason goes to the security event only.
 *
 * Errors from the directory never carry its own text to the client. A directory that is switched off costs one settings read and
 * changes nothing else: local sign-in is untouched.
 */
import { Client, InvalidCredentialsError, type ClientOptions } from 'ldapts';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { directoryAccounts, directoryGroupRoles, directorySettings, roles, users } from '../../db/schema';
import { verifyPassword, writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { log, serializeError } from '../core/logger';
import { lockRow, updateVersioned, type Executor } from '../core/tx';
import { getKeystore } from '../crypto/keystore';
import type { PrincipalResolver, PrincipalResult } from './directory';
import { recordSecurityEvent, type EventContext } from './events';
import { loginLockedUntil } from './lockout';
import { revokeUserSessions, type UserRow } from './sessions';

// ---------------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------------

/** RFC 4515 escaping of an assertion value: * ( ) \ NUL and every non-ASCII byte become \xx, so the value can only ever be a value. */
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    out += byte === 0x2a || byte === 0x28 || byte === 0x29 || byte === 0x5c || byte === 0x00 || byte >= 0x80
      ? `\\${byte.toString(16).padStart(2, '0')}` : String.fromCharCode(byte);
  }
  return out;
}

/** The form two DNs are compared in: lower case, no space around the separators. */
export function normalizeDn(dn: string): string {
  return dn.split(/(?<!\\),/).map(rdn => {
    const i = rdn.indexOf('=');
    return i < 0 ? rdn.trim().toLowerCase() : `${rdn.slice(0, i).trim().toLowerCase()}=${rdn.slice(i + 1).trim().toLowerCase()}`;
  }).join(',');
}

/** Roles in increasing privilege. When a person's groups map to several roles the LEAST privileged one is used. */
const ROLE_RANK = ['Analyst', 'Reviewer', 'QA'];
export const leastPrivileged = (names: string[]): string =>
  [...names].sort((a, b) => (ROLE_RANK.indexOf(a) + 1 || 99) - (ROLE_RANK.indexOf(b) + 1 || 99) || a.localeCompare(b))[0];

// ---------------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------------

export const BIND_PASSWORD_CONTEXT = 'directory_settings.bind_password:default';
export const sealBindPassword = (plain: string) => getKeystore().encrypt(plain, BIND_PASSWORD_CONTEXT);

export interface ConnectionSettings {
  url: string;
  security: 'ldaps' | 'starttls';
  caPem: string | null;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  groupAttribute: string;
  timeoutMs: number;
}
export type DirectoryConfig = ConnectionSettings & { enabled: boolean; localAccountsAllowed: boolean; version: number };

/** The stored settings with the bind password opened, or null when there is none (directory sign-on has never been configured). */
export async function loadDirectoryConfig(ex: Executor): Promise<DirectoryConfig | null> {
  const [row] = await ex.select().from(directorySettings).where(eq(directorySettings.id, 'default')).limit(1);
  if (!row) return null;
  let bindPassword = '';
  if (row.bindPasswordEnc) {
    try { bindPassword = getKeystore().decrypt(row.bindPasswordEnc, BIND_PASSWORD_CONTEXT); } catch (e) {
      log.error({ err: serializeError(e) }, 'directory bind password could not be decrypted'); // enabled stays true: sign-in reports the directory unavailable
    }
  }
  return {
    enabled: row.enabled, localAccountsAllowed: row.localAccountsAllowed, version: row.version, url: row.url ?? '', security: row.security as ConnectionSettings['security'], caPem: row.caPem,
    bindDn: row.bindDn ?? '', bindPassword, baseDn: row.baseDn ?? '', groupAttribute: row.groupAttribute, timeoutMs: row.timeoutMs,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Protocol: connector (replaceable in tests), search, bind
// ---------------------------------------------------------------------------------------------------------------------------

export interface DirectoryEntry { dn: string; attributes: Record<string, string[]> }

export interface DirectoryConnection {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, filter: string, attributes: string[], scope: 'base' | 'sub'): Promise<DirectoryEntry[]>;
  close(): Promise<void>;
}

/** The directory cannot be used: network, TLS (including a certificate that does not verify), timeout, or the service account is refused. */
export class DirectoryUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectoryUnavailableError'; }
}
/** The server refused a bind because the credentials are wrong. */
export class DirectoryInvalidCredentialsError extends Error {
  constructor() { super('bind refused: invalid credentials'); this.name = 'DirectoryInvalidCredentialsError'; }
}

export type DirectoryConnector = (cfg: ConnectionSettings) => Promise<DirectoryConnection>;

/** TLS options for every connection: the server certificate is verified, against the stored CA when one is given; TLS 1.2 or newer. */
export function tlsOptionsOf(cfg: Pick<ConnectionSettings, 'caPem'>) {
  return { rejectUnauthorized: true as const, minVersion: 'TLSv1.2' as const, ...(cfg.caPem ? { ca: [cfg.caPem] } : {}) };
}

export function clientOptionsOf(cfg: ConnectionSettings): ClientOptions {
  const scheme = cfg.security === 'ldaps' ? 'ldaps://' : 'ldap://';
  if (!cfg.url.startsWith(scheme)) throw new DirectoryUnavailableError(`The directory URL must start with ${scheme} for ${cfg.security}.`);
  return { url: cfg.url, timeout: cfg.timeoutMs, connectTimeout: cfg.timeoutMs, strictDN: false, tlsOptions: tlsOptionsOf(cfg) };
}

type ClientLike = Pick<Client, 'startTLS' | 'bind' | 'search' | 'unbind'>;

const GUID_ATTRIBUTES = ['objectGUID', 'entryUUID'];

function toAttributes(raw: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'dn') continue;
    out[key] = (Array.isArray(value) ? value : [value]).map(v => Buffer.isBuffer(v) ? (GUID_ATTRIBUTES.includes(key) ? v.toString('hex') : v.toString('utf8')) : String(v));
  }
  return out;
}

/** The connector for ldapts. `makeClient` is a seam for tests that check what is sent (StartTLS before bind, TLS options). */
export function createLdaptsConnector(makeClient: (options: ClientOptions) => ClientLike = o => new Client(o)): DirectoryConnector {
  return async (cfg) => {
    const options = clientOptionsOf(cfg);
    const client = makeClient(options);
    const unavailable = (e: unknown) => new DirectoryUnavailableError(e instanceof Error ? e.message : String(e));
    const close = async () => { try { await client.unbind(); } catch { /* the connection is gone already */ } };
    if (cfg.security === 'starttls') {
      try { await client.startTLS(options.tlsOptions); } catch (e) { await close(); throw unavailable(e); } // nothing is sent in clear after this fails
    }
    return {
      async bind(dn, password) {
        try { await client.bind(dn, password); } catch (e) {
          if (e instanceof InvalidCredentialsError) throw new DirectoryInvalidCredentialsError();
          throw unavailable(e);
        }
      },
      async search(base, filter, attributes, scope) {
        try {
          const { searchEntries } = await client.search(base, { scope, filter, attributes, sizeLimit: 3, explicitBufferAttributes: GUID_ATTRIBUTES });
          return searchEntries.map(e => ({ dn: e.dn, attributes: toAttributes(e as unknown as Record<string, unknown>) }));
        } catch (e) {
          if ((e as Error)?.name === 'NoSuchObjectError') return [];
          throw unavailable(e);
        }
      },
      close,
    };
  };
}

let connector: DirectoryConnector = createLdaptsConnector();
/** Tests replace the connector with an in-process fake directory; null restores ldapts. */
export function setDirectoryConnector(next: DirectoryConnector | null): void { connector = next ?? createLdaptsConnector(); }

export interface DirectoryPerson { dn: string; externalId: string; name: string; email: string | null; groups: string[] }
export type DirectoryOutcome =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-found'; reason: string }
  | { kind: 'refused'; reason: 'disabled' | 'locked' | 'expired'; person: DirectoryPerson }
  | { kind: 'bad-password'; person: DirectoryPerson }
  | { kind: 'ok'; person: DirectoryPerson };

const UF_ACCOUNTDISABLE = 0x2;
const UF_LOCKOUT = 0x10;
const NEVER_EXPIRES = new Set(['0', '9223372036854775807']);
const FILETIME_EPOCH_MS = 11_644_473_600_000;

/** The attributes read from the person's entry. */
const PERSON_ATTRIBUTES = ['objectGUID', 'entryUUID', 'userAccountControl', 'accountExpires', 'displayName', 'cn', 'mail', 'userPrincipalName', 'sAMAccountName'];

/** The filter that finds a person by what they typed. The only place a typed value enters a filter. */
export const personFilter = (login: string) => {
  const v = escapeFilterValue(login);
  return `(&(objectClass=user)(objectCategory=person)(|(userPrincipalName=${v})(sAMAccountName=${v})(mail=${v})))`;
};

function personOf(entry: DirectoryEntry, groupAttribute: string): DirectoryPerson | null {
  const first = (k: string) => entry.attributes[k]?.[0];
  const externalId = first('objectGUID') ?? first('entryUUID');
  if (!externalId) return null;
  return {
    dn: entry.dn, externalId: externalId.toLowerCase(), name: first('displayName') ?? first('cn') ?? first('sAMAccountName') ?? entry.dn,
    email: (first('mail') ?? first('userPrincipalName') ?? '').trim().toLowerCase() || null, groups: entry.attributes[groupAttribute] ?? [],
  };
}

function accountRefusal(entry: DirectoryEntry, now = Date.now()): 'disabled' | 'locked' | 'expired' | null {
  const uac = Number(entry.attributes.userAccountControl?.[0] ?? 0);
  if (uac & UF_ACCOUNTDISABLE) return 'disabled';
  if (uac & UF_LOCKOUT) return 'locked';
  const expires = entry.attributes.accountExpires?.[0];
  if (expires && !NEVER_EXPIRES.has(expires) && /^\d+$/.test(expires) && Number(BigInt(expires) / 10_000n) - FILETIME_EPOCH_MS < now) return 'expired';
  return null;
}

/** Opens a connection and binds the service account. */
async function serviceConnection(cfg: ConnectionSettings): Promise<DirectoryConnection> {
  const conn = await connector(cfg);
  try { await conn.bind(cfg.bindDn, cfg.bindPassword); } catch (e) {
    await conn.close();
    throw e instanceof DirectoryInvalidCredentialsError ? new DirectoryUnavailableError('the service account was refused') : e;
  }
  return conn;
}

/** True when the directory answers: TLS verified and the service account accepted. */
export async function probeDirectory(cfg: ConnectionSettings): Promise<{ ok: true } | { ok: false; reason: string }> {
  try { await (await serviceConnection(cfg)).close(); return { ok: true }; } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Finds the person (by what was typed, or by the DN and identifier stored at provisioning), refuses a disabled / locked / expired
 * account BEFORE trying its password, then binds as the person's DN. Never throws for a wrong password or a missing person.
 */
export async function directoryAuthenticate(
  cfg: ConnectionSettings, who: { login: string } | { dn: string; externalId: string }, password: string,
  /** Asked once the person is found, before their password is tried; false = do not try it (the account is locked here, and each try would count in the directory too). */
  mayTryPassword: (person: DirectoryPerson) => Promise<boolean> = async () => true,
): Promise<DirectoryOutcome> {
  if (password.length === 0 || password.includes('\0')) return { kind: 'not-found', reason: 'empty password' }; // an empty password is an anonymous bind
  let conn: DirectoryConnection | undefined;
  try {
    conn = await serviceConnection(cfg);
    const entries = 'login' in who
      ? await conn.search(cfg.baseDn, personFilter(who.login), [...PERSON_ATTRIBUTES, cfg.groupAttribute], 'sub')
      : await conn.search(who.dn, '(objectClass=user)', [...PERSON_ATTRIBUTES, cfg.groupAttribute], 'base');
    if (entries.length !== 1) return { kind: 'not-found', reason: entries.length === 0 ? 'no such person' : 'more than one match' };
    const person = personOf(entries[0], cfg.groupAttribute);
    if (!person) return { kind: 'not-found', reason: 'the entry has no immutable identifier' };
    if (!('login' in who) && person.externalId !== who.externalId.toLowerCase()) return { kind: 'not-found', reason: 'the identifier of the entry changed' };
    const refusal = accountRefusal(entries[0]);
    if (refusal) return { kind: 'refused', reason: refusal, person };
    if (!(await mayTryPassword(person))) return { kind: 'bad-password', person };
    try { await conn.bind(person.dn, password); } catch (e) {
      if (e instanceof DirectoryInvalidCredentialsError) return { kind: 'bad-password', person };
      throw e;
    }
    return { kind: 'ok', person };
  } catch (e) {
    if (e instanceof DirectoryUnavailableError) return { kind: 'unavailable', reason: e.message };
    throw e;
  } finally {
    await conn?.close();
  }
}

/** The person a name finds, with the account state the directory reports, without trying any password (the Administrator's connection test). */
export async function lookupPerson(cfg: ConnectionSettings, login: string): Promise<
  | { kind: 'unavailable'; reason: string } | { kind: 'not-found' } | { kind: 'found'; person: DirectoryPerson; refusal: 'disabled' | 'locked' | 'expired' | null }
> {
  let conn: DirectoryConnection | undefined;
  try {
    conn = await serviceConnection(cfg);
    const entries = await conn.search(cfg.baseDn, personFilter(login), [...PERSON_ATTRIBUTES, cfg.groupAttribute], 'sub');
    const person = entries.length === 1 ? personOf(entries[0], cfg.groupAttribute) : null;
    return person ? { kind: 'found', person, refusal: accountRefusal(entries[0]) } : { kind: 'not-found' };
  } catch (e) {
    if (e instanceof DirectoryUnavailableError) return { kind: 'unavailable', reason: e.message };
    throw e;
  } finally {
    await conn?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Accounts and role mapping
// ---------------------------------------------------------------------------------------------------------------------------

export type DirectoryAccountRow = typeof directoryAccounts.$inferSelect;

export async function directoryAccountOf(ex: Executor, userId: string): Promise<DirectoryAccountRow | undefined> {
  return (await ex.select().from(directoryAccounts).where(eq(directoryAccounts.userId, userId)).limit(1))[0];
}

/** The role the groups give: the least privileged role among the Approved mappings that match and are active roles; null = none. */
export async function mappedRole(ex: Executor, groups: string[]): Promise<{ role: string | null; matched: string[] }> {
  const wanted = new Set(groups.map(normalizeDn));
  const rows = await ex.select({ groupDn: directoryGroupRoles.groupDn, norm: directoryGroupRoles.groupDnNorm, role: directoryGroupRoles.role })
    .from(directoryGroupRoles).innerJoin(roles, and(eq(roles.name, directoryGroupRoles.role), eq(roles.active, true)))
    .where(eq(directoryGroupRoles.status, 'Approved'));
  const hits = rows.filter(r => wanted.has(r.norm));
  return { role: hits.length ? leastPrivileged(hits.map(h => h.role)) : null, matched: hits.map(h => h.groupDn) };
}

const GENERIC_REFUSAL = { kind: 'refused', status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } as const;
const UNAVAILABLE_REFUSAL = {
  kind: 'refused', status: 503, code: 'DIRECTORY_UNAVAILABLE',
  message: 'Directory sign-on is not available right now. Try again later or contact an Administrator.',
} as const;

/**
 * Creates the local row of a person the directory vouched for, or brings an existing one in line with the directory: name, e-mail
 * and, above all, the ROLE from the current mapping. A changed role ends the person's other sessions. Everything in one transaction
 * with its audit entry (the person is the actor: nobody else acted).
 */
async function syncAccount(db: Db, person: DirectoryPerson, role: string, matched: string[]): Promise<{ user: UserRow } | { conflict: string }> {
  return db.transaction(async tx => {
    // One sign-in at a time per person (keyed on the immutable identifier), held to the end of this transaction. Without it, two first
    // sign-ins both find no account, the loser's e-mail check then sees the winner's committed row and answers "e-mail taken" (401),
    // and "SELECT ... FOR UPDATE" on a row that does not exist yet locks nothing. After the lock the loser finds the account and syncs it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'directory-account:' + person.externalId}, 0))`);
    const [existing] = await tx.select({ account: directoryAccounts }).from(directoryAccounts).where(eq(directoryAccounts.externalId, person.externalId)).for('update');
    if (!existing) {
      const email = person.email;
      if (!email) return { conflict: 'the directory entry has no mail or userPrincipalName' };
      const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      if (taken) return { conflict: 'a different account already uses this e-mail address' };
      const id = `usr-${randomBytes(6).toString('hex')}`;
      const [user] = await tx.insert(users).values({ id, uid: id, name: person.name, email, role, passwordHash: null, hasCompletedSoftwareTraining: false }).returning();
      await tx.insert(directoryAccounts).values({ userId: id, kind: 'ldap', externalId: person.externalId, dn: person.dn, groups: person.groups, syncedAt: new Date(), createdBy: id });
      await writeAudit(tx, id, 'Create', 'User', id, 'account', '', JSON.stringify({ name: person.name, email, role, source: 'directory', groups: matched }), 'Account created at the first directory sign-in from the approved group mapping');
      return { user };
    }
    const row = await lockRow(tx, users, existing.account.userId);
    const changes: Record<string, [unknown, unknown]> = {};
    const set: Partial<typeof users.$inferInsert> = {};
    if (row.role !== role) { changes.role = [row.role, role]; set.role = role; }
    if (row.name !== person.name) { changes.name = [row.name, person.name]; set.name = person.name; }
    if (person.email && (row.email ?? '').toLowerCase() !== person.email) {
      const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${person.email} and ${users.id} <> ${row.id}`).limit(1);
      if (!taken) { changes.email = [row.email, person.email]; set.email = person.email; }
    }
    let user = row;
    if (Object.keys(changes).length) {
      user = await updateVersioned(tx, users, row.id, row.version, set);
      if (changes.role) await revokeUserSessions(tx, row.id, 'role changed by the directory group mapping');
      await writeAudit(tx, row.id, 'DirectorySync', 'User', row.id, Object.keys(changes).join(','),
        JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[0]]))), JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[1]]))),
        'Re-evaluated from the directory at sign-in');
    }
    await tx.update(directoryAccounts).set({ dn: person.dn, groups: person.groups, syncedAt: new Date() }).where(eq(directoryAccounts.userId, row.id));
    return { user };
  });
}

/** A person the directory no longer vouches for (disabled, or in no mapped group): their sessions end now. */
async function endSessionsOf(db: Db, externalId: string, reason: string): Promise<void> {
  const [acct] = await db.select({ userId: directoryAccounts.userId }).from(directoryAccounts).where(eq(directoryAccounts.externalId, externalId)).limit(1);
  if (acct) await db.transaction(tx => revokeUserSessions(tx, acct.userId, reason));
}

// ---------------------------------------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------------------------------------

const event = (db: Db, type: string, outcome: 'success' | 'failure' | 'denied' | 'info', label: string, context: Partial<EventContext>, detail: unknown, actor?: UserRow) =>
  recordSecurityEvent(db, { type, outcome, actorId: actor?.id ?? null, actorRole: actor?.role ?? null, actorLabel: actor ? null : label, ...context, detail });

/** A local Administrator flagged break-glass: allowed with its local password and MFA only while the directory cannot be used. */
async function breakGlass(db: Db, cfg: DirectoryConfig, user: UserRow, password: string, context: Partial<EventContext>): Promise<PrincipalResult> {
  const probe = await probeDirectory(cfg);
  if (probe.ok) {
    await event(db, 'BREAK_GLASS_REFUSED', 'denied', user.email ?? user.id, context, { reason: 'the directory is reachable: use the directory account' }, user);
    return GENERIC_REFUSAL;
  }
  if (!user.active || user.role !== 'Admin' || !user.totpEnabled) {
    await event(db, 'BREAK_GLASS_REFUSED', 'denied', user.email ?? user.id, context, { reason: 'the break-glass account must be an active Administrator with multi-factor authentication' }, user);
    return GENERIC_REFUSAL;
  }
  const ok = verifyPassword(password, user.passwordHash);
  await event(db, 'BREAK_GLASS_USED', ok ? 'success' : 'failure', user.email ?? user.id, context, { directory: probe.reason, passwordAccepted: ok }, user);
  return ok ? { kind: 'ok', user } : { kind: 'bad-password', user };
}

export const ldapDirectory: PrincipalResolver = {
  id: 'ldap',
  async authenticate(db, login, password, context = {}) {
    const cfg = await loadDirectoryConfig(db);
    if (!cfg?.enabled) return { kind: 'unknown' }; // switched off: nothing else happens, the local resolver answers
    login = login.trim();

    // A local account that is not break-glass is a local account: its password is never sent to the directory, and a directory
    // person cannot take it over by having the same address.
    const [local] = await db.select().from(users).where(sql`lower(${users.email}) = ${login.toLowerCase()}`).limit(1);
    const acct = local ? await directoryAccountOf(db, local.id) : undefined;
    if (local && acct?.kind === 'break-glass') return breakGlass(db, cfg, local, password, context);
    if (local && !acct) {
      if (cfg.localAccountsAllowed) return { kind: 'unknown' };
      await event(db, 'DIRECTORY_ACCOUNT_REFUSED', 'denied', login, context, { reason: 'local sign-in is closed while directory sign-on is on' }, local);
      return GENERIC_REFUSAL;
    }

    const notLocked = async (p: DirectoryPerson) => {
      const [mine] = await db.select({ lockedUntil: users.loginLockedUntil }).from(directoryAccounts).innerJoin(users, eq(users.id, directoryAccounts.userId)).where(eq(directoryAccounts.externalId, p.externalId)).limit(1);
      return !(mine && loginLockedUntil({ loginLockedUntil: mine.lockedUntil }));
    };
    const outcome = await directoryAuthenticate(cfg, { login }, password, notLocked);
    switch (outcome.kind) {
      case 'unavailable':
        await event(db, 'DIRECTORY_UNAVAILABLE', 'failure', login, context, { reason: outcome.reason });
        return UNAVAILABLE_REFUSAL;
      case 'not-found':
        return { kind: 'unknown' }; // the route records the failed sign-in with the typed name
      case 'refused':
        await event(db, 'DIRECTORY_ACCOUNT_REFUSED', 'denied', login, context, { reason: outcome.reason, externalId: outcome.person.externalId });
        await endSessionsOf(db, outcome.person.externalId, `directory account ${outcome.reason}`);
        return GENERIC_REFUSAL;
      case 'bad-password': {
        const [mine] = await db.select({ user: users }).from(directoryAccounts).innerJoin(users, eq(users.id, directoryAccounts.userId)).where(eq(directoryAccounts.externalId, outcome.person.externalId)).limit(1);
        return mine ? { kind: 'bad-password', user: mine.user } : { kind: 'unknown' }; // an existing account counts toward the sign-in lock
      }
      case 'ok': {
        const { role, matched } = await mappedRole(db, outcome.person.groups);
        if (!role) {
          await event(db, 'DIRECTORY_ACCOUNT_REFUSED', 'denied', login, context, { reason: 'no approved group mapping for any group of the person', externalId: outcome.person.externalId });
          await endSessionsOf(db, outcome.person.externalId, 'directory account in no mapped group');
          return GENERIC_REFUSAL;
        }
        // Two first sign-ins of the same person at the same moment are serialized by the advisory lock in syncAccount (the second finds the
        // account). The retry covers only a unique violation that is not that race (e.g. a different person taking the address first): it then
        // answers through the normal e-mail conflict check instead of a 500.
        const synced = await syncAccount(db, outcome.person, role, matched).catch(e => {
          if ((e?.cause?.code ?? e?.code) !== '23505') throw e;
          return syncAccount(db, outcome.person, role, matched);
        });
        if ('conflict' in synced) {
          await event(db, 'DIRECTORY_ACCOUNT_REFUSED', 'denied', login, context, { reason: synced.conflict, externalId: outcome.person.externalId });
          return GENERIC_REFUSAL;
        }
        await event(db, 'DIRECTORY_AUTH', 'success', login, context, { role, groups: matched }, synced.user);
        return { kind: 'ok', user: synced.user };
      }
    }
  },
};

/**
 * Checks the password of a user the directory vouches for, for re-authentication and the electronic signature (21 CFR 11.200).
 * Returns null for an account that is not a directory account (the caller checks the local hash). The account is looked up in the
 * directory again, so a person disabled since the sign-in cannot sign: 'refused'. 'unavailable' is not a wrong password.
 */
export async function verifyDirectoryPassword(db: Db, user: Pick<UserRow, 'id'>, password: string): Promise<null | 'ok' | 'bad-password' | 'refused' | 'unavailable'> {
  const acct = await directoryAccountOf(db, user.id);
  if (acct?.kind !== 'ldap') return null;
  const cfg = await loadDirectoryConfig(db);
  if (!cfg?.enabled || !acct.dn || !acct.externalId) return 'unavailable';
  const outcome = await directoryAuthenticate(cfg, { dn: acct.dn, externalId: acct.externalId }, password);
  switch (outcome.kind) {
    case 'ok': return 'ok';
    case 'bad-password': return 'bad-password';
    case 'unavailable': return 'unavailable';
    case 'refused': await endSessionsOf(db, acct.externalId, `directory account ${outcome.reason}`); return 'refused';
    case 'not-found': return 'refused';
  }
}

/** True for an account whose password is kept by the directory: it has no local password to change or reset. */
export async function isDirectoryAccount(ex: Executor, userId: string): Promise<boolean> {
  return (await directoryAccountOf(ex, userId))?.kind === 'ldap';
}
