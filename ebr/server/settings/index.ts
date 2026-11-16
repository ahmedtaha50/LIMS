import { z } from 'zod';
import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { sign, type PasswordCheck } from '../esign/index.js';
import { ROLE_NAMES } from '../identity/roles.js';

/**
 * Site settings (E27): the numbers and names a plant decides, changed in the application by an administrator, within
 * bounds, with a reason and an electronic signature, and audited with the old and new value. Only changed values are
 * stored (table site_settings); every other setting has its default here. A default may come from the server environment
 * (the variable named in `env`), so an installation configured before R5 keeps its values until someone changes them here.
 * Readers ask for the value on each use: a change holds at once on every instance, with no restart.
 */
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const dn = z.string().max(500).regex(/^$|^[^\n\r]*=[^\n\r]*$/, 'a distinguished name, such as ou=people,dc=plant,dc=local');

type Def = { key: string; group: string; label: string; schema: z.ZodType; default: unknown; env?: string; unit?: string };
const D = (key: string, group: string, label: string, schema: z.ZodType, def: unknown, extra: Partial<Def> = {}): Def => ({ key, group, label, schema, default: def, ...extra });

export const SETTINGS: readonly Def[] = [
  D('session.idleMinutes', 'Sessions', 'Sign-off after this many minutes without activity', int(5, 60), 15, { env: 'EBR_SESSION_IDLE_MINUTES', unit: 'min' }),
  D('session.maxHours', 'Sessions', 'Longest a session lasts, active or not', int(1, 24), 12, { env: 'EBR_SESSION_MAX_HOURS', unit: 'h' }),
  D('signin.maxFailures', 'Sign-in', 'Failed sign-ins that lock the account', int(3, 10), 5),
  D('signin.windowMinutes', 'Sign-in', 'Failed sign-ins are counted over this many minutes', int(5, 60), 15, { unit: 'min' }),
  D('signin.lockMinutes', 'Sign-in', 'A locked account stays locked this many minutes (or until an administrator unlocks it)', int(5, 1440), 30, { unit: 'min' }),
  D('yield.minPct', 'Yield', 'Lowest acceptable yield when the recipe sets none', z.number().min(50).max(100), 95, { env: 'EBR_YIELD_MIN_PCT', unit: '%' }),
  D('yield.maxPct', 'Yield', 'Highest acceptable yield when the recipe sets none', z.number().min(100).max(150), 102, { env: 'EBR_YIELD_MAX_PCT', unit: '%' }),
  D('directory.url', 'Directory', 'Directory address (ldaps:// or ldap://); empty: local accounts only', z.string().max(300).regex(/^$|^ldaps?:\/\/[^\s/]+(:\d+)?\/?$/, 'ldaps://host:636 or ldap://host:389, or empty'), '', { env: 'EBR_LDAP_URL' }),
  D('directory.baseDn', 'Directory', 'Where users are searched', dn, '', { env: 'EBR_LDAP_BASE_DN' }),
  D('directory.userFilter', 'Directory', 'Search filter; {username} is replaced (escaped)', z.string().max(300).regex(/\{username\}/, 'the filter must contain {username}'), '(sAMAccountName={username})', { env: 'EBR_LDAP_USER_FILTER' }),
  D('directory.bindDn', 'Directory', 'Service account that searches (its password stays in the server environment, EBR_LDAP_BIND_PASSWORD)', dn, '', { env: 'EBR_LDAP_BIND_DN' }),
  D('directory.groupRoles', 'Directory', 'Directory group (DN) to role', z.record(z.string().min(3).max(500), z.enum(ROLE_NAMES as [string, ...string[]])), {}, { env: 'EBR_LDAP_GROUP_ROLES' }),
];
const byKey = new Map(SETTINGS.map(d => [d.key, d]));

/** The default of a setting: its environment variable when set and valid, else the built-in value. */
function defaultOf(d: Def, env: NodeJS.ProcessEnv = process.env): unknown {
  const raw = d.env ? env[d.env] : undefined;
  if (raw === undefined || raw === '') return d.default;
  let v: unknown = raw;
  if (typeof d.default === 'number') v = Number(raw);
  else if (typeof d.default === 'object') { try { v = JSON.parse(raw); } catch { return d.default; } }
  return d.schema.safeParse(v).success ? v : d.default;
}

/** The default of a setting by key (used as the fallback inside SQL that reads site_settings directly). */
export const defaultValue = (key: string) => { const d = byKey.get(key); if (!d) throw new Error(`unknown setting ${key}`); return defaultOf(d); };

type Row = { key: string; value: unknown; version: number; updated_by: string; updated_at: Date };

/** Current values of the given settings (one query). */
export async function settingsOf<K extends string>(c: Client | Pool, keys: readonly K[]): Promise<Record<K, any>> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows = (await c.query<Row>('SELECT key, value FROM site_settings WHERE key = ANY($1)', [keys as readonly string[]])).rows;
  const stored = new Map(rows.map(r => [r.key, r.value]));
  const out = {} as Record<K, unknown>;
  for (const k of keys) { const d = byKey.get(k); if (!d) throw new Error(`unknown setting ${k}`); out[k] = stored.has(k) ? stored.get(k) : defaultOf(d); }
  return out as Record<K, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
}
export const setting = async (c: Client | Pool, key: string) => (await settingsOf(c, [key]))[key];

/** Every setting with its value, default, whether it was changed, and who changed it last. */
export async function list(pool: Client | Pool) {
  const rows = new Map((await pool.query<Row>('SELECT * FROM site_settings')).rows.map(r => [r.key, r]));
  return SETTINGS.map(d => {
    const r = rows.get(d.key);
    return { key: d.key, group: d.group, label: d.label, unit: d.unit ?? null, value: r ? r.value : defaultOf(d), default: defaultOf(d), changed: !!r,
      rowVersion: r?.version ?? 0, updatedBy: r?.updated_by ?? null, updatedAt: r ? new Date(r.updated_at).toISOString() : null };
  });
}

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };

/**
 * Changes one setting (E27#2): the value is checked against the setting's bounds, the caller states the version it read
 * (0 when the setting still has its default), signs with the meaning "approved" and gives the reason.
 */
export async function change(x: Ctx, key: string, input: { value: unknown; rowVersion: number; reason: string; password: string }) {
  const d = byKey.get(key);
  if (!d) throw notFound(`There is no setting ${key}.`);
  const parsed = d.schema.safeParse(input.value);
  if (!parsed.success) throw new HttpError(400, 'out_of_bounds', `${d.label}: ${parsed.error.issues.map(i => i.message).join('; ')}.`);
  await x.c.query('SELECT pg_advisory_xact_lock(4100300, hashtext($1))', [key]);
  const cur = (await x.c.query<Row>('SELECT * FROM site_settings WHERE key = $1', [key])).rows[0];
  if ((cur?.version ?? 0) !== input.rowVersion) throw conflict();
  const old = cur ? cur.value : defaultOf(d);
  if (JSON.stringify(old) === JSON.stringify(parsed.data)) throw new HttpError(409, 'unchanged', `${d.label} already has this value.`);
  const version = (cur?.version ?? 0) + 1;
  await sign(x.c, x.pool, x.check, { signer: { userId: x.actor.userId, username: x.actor.username, displayName: x.actor.displayName ?? x.actor.username },
    password: input.password, meaning: 'approved', entity: 'site_setting', entityId: key, recordVersion: version, record: { key, value: parsed.data }, comment: input.reason, requestId: x.requestId });
  await x.c.query(`INSERT INTO site_settings (key, value, version, updated_by) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(parsed.data), version, x.actor.username]);
  await writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action: 'setting.changed', entity: 'site_setting', entityId: key, requestId: x.requestId,
    oldValue: old, newValue: parsed.data, reason: input.reason });
  return (await list(x.c)).find(s => s.key === key) ?? null;   // inside the transaction: the pool would still see the old value
}
