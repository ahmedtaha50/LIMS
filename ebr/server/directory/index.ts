import { Client, InvalidCredentialsError } from 'ldapts';
import { writeAudit } from '../audit/index.js';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { HttpError } from '../core/errors.js';
import { ROLE_NAMES } from '../identity/roles.js';

/**
 * Sign-on with the company directory (LDAP / Active Directory, E17). The password is checked by the directory (a bind as
 * the user); the roles come from the user's groups at every sign-in, so removing someone from a group takes effect at
 * their next sign-in. Configuration (all from the environment; no directory configured = local accounts only):
 *   EBR_LDAP_URL            ldaps://dc1.plant.local:636
 *   EBR_LDAP_BIND_DN        the service account that searches, and EBR_LDAP_BIND_PASSWORD
 *   EBR_LDAP_BASE_DN        where users are searched
 *   EBR_LDAP_USER_FILTER    default (sAMAccountName={username}); {username} is escaped
 *   EBR_LDAP_GROUP_ROLES    JSON: {"cn=ebr-qa,ou=groups,dc=plant,dc=local": "qa", ...}
 */
export type DirectoryConfig = { url: string; bindDn: string; bindPassword: string; baseDn: string; userFilter: string; groupRoles: Record<string, string> };
export class DirectoryUnavailable extends Error {}

export function directoryConfig(env: NodeJS.ProcessEnv = process.env): DirectoryConfig | null {
  if (!env.EBR_LDAP_URL) return null;
  const groupRoles = JSON.parse(env.EBR_LDAP_GROUP_ROLES ?? '{}') as Record<string, string>;
  for (const [g, r] of Object.entries(groupRoles)) if (!(ROLE_NAMES as string[]).includes(r)) throw new Error(`EBR_LDAP_GROUP_ROLES: ${g} maps to an unknown role ${r}`);
  return {
    url: env.EBR_LDAP_URL, bindDn: env.EBR_LDAP_BIND_DN ?? '', bindPassword: env.EBR_LDAP_BIND_PASSWORD ?? '', baseDn: env.EBR_LDAP_BASE_DN ?? '',
    userFilter: env.EBR_LDAP_USER_FILTER ?? '(sAMAccountName={username})',
    groupRoles: Object.fromEntries(Object.entries(groupRoles).map(([g, r]) => [normalizeDn(g), r])),
  };
}

/** RFC 4515: a user name is data, never filter syntax. */
/** Distinguished names compared as the directory means them: case and spaces around , and = do not matter. */
export const normalizeDn = (dn: string) => dn.toLowerCase().replace(/\s*([,=])\s*/g, '$1').trim();
const escapeFilter = (s: string) => s.replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const client = (cfg: DirectoryConfig) => new Client({ url: cfg.url, timeout: 5000, connectTimeout: 5000 });
const unavailable = (e: unknown) => e instanceof Error && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timeout|socket|closed/i.test(`${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`);

export type DirectoryUser = { dn: string; username: string; displayName: string; roles: string[] };
/** Checks the password with the directory. null: wrong user name or password. Throws DirectoryUnavailable when it cannot ask. */
export async function authenticate(cfg: DirectoryConfig, username: string, password: string): Promise<DirectoryUser | null> {
  if (!password) return null;                                      // an empty password would be an anonymous bind: never
  const c = client(cfg);
  try {
    await c.bind(cfg.bindDn, cfg.bindPassword);
    const { searchEntries } = await c.search(cfg.baseDn, { scope: 'sub', filter: cfg.userFilter.replace('{username}', escapeFilter(username)), attributes: ['dn', 'displayname', 'cn', 'memberof'] });   // names are case-insensitive in LDAP
    if (searchEntries.length !== 1) return null;
    const raw = searchEntries[0]!;
    // attribute names are case-insensitive in LDAP: servers return memberOf, memberof or MEMBEROF
    const e = Object.fromEntries(Object.entries(raw).filter(([, v]) => !(Array.isArray(v) && v.length === 0)).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, unknown> & { dn: string };
    e.dn = raw.dn;
    const groups = ([] as unknown[]).concat(e.memberof ?? []).map(g => normalizeDn(String(g)));
    const roles = [...new Set(groups.map(g => cfg.groupRoles[g]).filter((r): r is string => !!r))];
    const u = client(cfg);
    try { await u.bind(e.dn, password); } catch (err) { if (err instanceof InvalidCredentialsError) return null; throw err; } finally { await u.unbind().catch(() => undefined); }
    return { dn: e.dn, username, displayName: String(e.displayname ?? e.cn ?? username), roles };
  } catch (err) {
    if (err instanceof InvalidCredentialsError) throw new DirectoryUnavailable('the directory refused the service account: check EBR_LDAP_BIND_DN');
    if (unavailable(err)) throw new DirectoryUnavailable(err instanceof Error ? err.message : String(err));
    throw err;
  } finally { await c.unbind().catch(() => undefined); }
}

/**
 * Signs a directory user in: the account here is created or updated from the directory (name, roles), audited when its
 * roles change. Returns the user id, or null for a wrong user name or password. A user in no mapped group is refused.
 */
export async function directorySignIn(pool: Pool, cfg: DirectoryConfig, username: string, password: string, requestId: string): Promise<string | null> {
  let d: DirectoryUser | null;
  try { d = await authenticate(cfg, username, password); }
  catch (e) {
    if (e instanceof DirectoryUnavailable) throw new HttpError(503, 'directory_unavailable', 'The company directory cannot be reached, so directory accounts cannot sign in now. If this is urgent, use a break-glass account and tell IT.');
    throw e;
  }
  if (!d) return null;
  if (!d.roles.length) throw new HttpError(403, 'no_role', 'Your directory account is in no group that gives a role in this system. Ask IT to add you to the right group.');
  return withTx(pool, async (c) => {
    const old = (await c.query<{ id: string; roles: string[]; auth_source: string }>('SELECT id, roles, auth_source FROM users WHERE lower(username) = lower($1) FOR UPDATE', [username])).rows[0];
    if (old && old.auth_source !== 'directory') throw new HttpError(409, 'local_account', 'A local account has this user name: it signs in with its local password.');
    if (!old) {
      const r = await c.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles, must_change_password, auth_source, directory_dn) VALUES ($1, $2, '!directory', $3, false, 'directory', $4) RETURNING id", [username, d.displayName, d.roles, d.dn]);
      await writeAudit(c, { actorId: null, actorName: 'directory', action: 'user.created', entity: 'user', entityId: r.rows[0]!.id, newValue: { username, displayName: d.displayName, roles: d.roles, source: 'directory' }, requestId });
      return r.rows[0]!.id;
    }
    const changed = [...old.roles].sort().join(',') !== [...d.roles].sort().join(',');
    await c.query('UPDATE users SET display_name = $2, roles = $3, directory_dn = $4, version = version + CASE WHEN $5 THEN 1 ELSE 0 END, updated_at = now() WHERE id = $1', [old.id, d.displayName, d.roles, d.dn, changed]);
    if (changed) await writeAudit(c, { actorId: null, actorName: 'directory', action: 'user.roles_from_directory', entity: 'user', entityId: old.id, oldValue: { roles: old.roles }, newValue: { roles: d.roles }, requestId });
    return old.id;
  });
}

/** The password check of e-signatures for a directory account: the directory decides (E04#1). */
export async function directoryPasswordOk(cfg: DirectoryConfig, username: string, password: string): Promise<boolean> {
  try { return (await authenticate(cfg, username, password)) !== null; } catch { return false; }
}
