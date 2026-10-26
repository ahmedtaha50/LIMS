/**
 * The application's least-privilege database role (roadmap M35, SEC-10). r2-audit-tamper owns this file.
 *
 * The application used to connect as the owner of every table, and an owner may DROP or DISABLE the triggers that make the audit
 * trail append-only. lims_app owns nothing:
 *
 *   append-only tables     audit_trail, signatures, security_events and every table whose row guard is gxp_block_mutation (the
 *                          checkpoints, the reviews, the anchor register, the QMS links ...): SELECT and INSERT only.
 *   every other table      SELECT, INSERT, UPDATE, DELETE. Never TRUNCATE, REFERENCES or TRIGGER; no CREATE on the schema.
 *   sequences              USAGE and SELECT.
 *
 * Because lims_app owns no table it can neither drop, disable nor replace a trigger or its function (42501), and it cannot switch
 * session_replication_role (superuser only). The guard triggers are also set ENABLE ALWAYS, so even an owner session in replica mode
 * (the usual way to load data "without triggers") still fires them. Re-applying the protections re-creates the triggers in the
 * default (ORIGIN) mode, so this runs after them, at every start.
 *
 * Everything here is idempotent and runs as the owner. CREATE ROLE needs CREATEROLE (or a superuser); see
 * src/server/boot/steps/roles.ts for what happens without it.
 */
export const APP_ROLE = 'lims_app';

/** Tables the role may only read and append to, whatever their guard function is. */
export const INSERT_ONLY_TABLES = ['audit_trail', 'signatures', 'security_events'] as const;

interface Conn { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }

export interface AppRoleReport {
  role: string;
  /** The role was created by this run. */
  created: boolean;
  /** A password was set and the role may log in. */
  login: boolean;
  insertOnly: string[];
  readWrite: number;
  /** Guard triggers set to ENABLE ALWAYS by this run (0 when they already were). */
  triggersAlways: number;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The append-only tables of this database: the three named ones plus every table guarded by gxp_block_mutation. */
export async function appendOnlyTables(conn: Conn): Promise<string[]> {
  const { rows } = await conn.query(`
    SELECT DISTINCT c.relname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname LIKE 'gxp\\_%\\_row\\_guard' AND p.proname = 'gxp_block_mutation'`);
  const found = new Set<string>(rows.map(r => r.name));
  for (const table of INSERT_ONLY_TABLES) {
    const exists = await conn.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
    if (exists.rows[0].ok) found.add(table);
  }
  return [...found].sort();
}

export async function applyAppRole(conn: Conn, opts: { role?: string; password?: string | null } = {}): Promise<AppRoleReport> {
  const role = opts.role ?? APP_ROLE;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Invalid role name: ${role}`);
  const r = ident(role);

  let created = false;
  const exists = (await conn.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
  if (!exists) {
    try {
      await conn.query(`CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      created = true;
    } catch (err: any) {
      if (err?.code !== '42710') throw err; // created meanwhile by a start against another database of the cluster
    }
  }
  // The attributes are re-asserted every time: a role someone widened by hand is narrowed again.
  await conn.query(`ALTER ROLE ${r} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  if (opts.password) await conn.query(`ALTER ROLE ${r} LOGIN PASSWORD ${literal(opts.password)}`);
  const login = (await conn.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role])).rows[0]?.rolcanlogin === true;

  const db = (await conn.query('SELECT current_database() AS name')).rows[0].name as string;
  await conn.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${r}`);
  await conn.query(`REVOKE CREATE ON SCHEMA public FROM ${r}`);
  await conn.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await conn.query(`GRANT USAGE ON SCHEMA public TO ${r}`);

  const insertOnly = await appendOnlyTables(conn);
  const tables = (await conn.query(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(x => x.name as string);
  await conn.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`);
  let readWrite = 0;
  for (const table of tables) {
    if (insertOnly.includes(table)) {
      await conn.query(`GRANT SELECT, INSERT ON ${ident(table)} TO ${r}`);
    } else {
      await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(table)} TO ${r}`);
      readWrite++;
    }
  }
  await conn.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`);

  const triggers = (await conn.query(`
    SELECT c.relname AS tbl, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname LIKE 'gxp\\_%' AND t.tgenabled <> 'A' ORDER BY 1, 2`)).rows;
  for (const t of triggers) await conn.query(`ALTER TABLE ${ident(t.tbl)} ENABLE ALWAYS TRIGGER ${ident(t.name)}`);

  return { role, created, login, insertOnly, readWrite, triggersAlways: triggers.length };
}
