/**
 * Structural fingerprint of the `public` schema: tables, columns (order, type, nullability, default), constraints and indexes.
 *
 * It is what lets the migration runner decide whether an installation that has no journal is a genuine v0.1.0 install
 * (accepted, journal started at 0000) or something else (refused). It reads catalog columns instead of deparsed SQL
 * wherever it can, so the result does not depend on search_path, locale or the PostgreSQL minor version, and it ignores data,
 * triggers and the migration journal itself.
 */
import { createHash } from 'crypto';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TableStructure {
  columns: Array<{ name: string; type: string; notNull: boolean; default: string | null; identity: string; generated: string }>;
  constraints: Array<{ name: string; kind: string; columns: string[]; references: string | null; actions: string | null; expression: string | null }>;
  indexes: Array<{ name: string; unique: boolean; method: string; columns: string[]; options: string; predicate: string | null }>;
}
export type DbStructure = Record<string, TableStructure>;

/** Tables that are bookkeeping of the runner itself, not part of the product schema. */
export const JOURNAL_TABLE = 'schema_migrations';

const COLUMNS = `
  select c.relname as tbl, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
         pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity::text as identity, a.attgenerated::text as generated
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> $1 and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`;

const CONSTRAINTS = `
  select c.relname as tbl, k.conname as name, k.contype::text as kind,
         (select coalesce(array_agg(att.attname::text order by u.ord), '{}') from unnest(k.conkey) with ordinality u(attnum, ord)
            join pg_attribute att on att.attrelid = k.conrelid and att.attnum = u.attnum) as cols,
         fr.relname as ftbl,
         (select coalesce(array_agg(att.attname::text order by u.ord), '{}') from unnest(k.confkey) with ordinality u(attnum, ord)
            join pg_attribute att on att.attrelid = k.confrelid and att.attnum = u.attnum) as fcols,
         k.confupdtype::text as upd, k.confdeltype::text as del, k.confmatchtype::text as match,
         k.condeferrable as deferrable, k.condeferred as deferred,
         case when k.contype = 'c' then pg_get_expr(k.conbin, k.conrelid) end as expr
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_class fr on fr.oid = k.confrelid
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> $1 and k.contype in ('p', 'u', 'f', 'c')
  order by c.relname, k.conname`;

// Indexes that back a constraint are described by the constraint; this lists the rest.
const INDEXES = `
  select c.relname as tbl, i.relname as name, ix.indisunique as uniq, am.amname as method,
         (select array_agg(pg_get_indexdef(ix.indexrelid, k, true) order by k) from generate_series(1, ix.indnkeyatts) k) as cols,
         ix.indoption::text as options, pg_get_expr(ix.indpred, ix.indrelid) as pred
  from pg_index ix
  join pg_class c on c.oid = ix.indrelid
  join pg_class i on i.oid = ix.indexrelid
  join pg_am am on am.oid = i.relam
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> $1
    and not exists (select 1 from pg_constraint k where k.conindid = ix.indexrelid)
  order by c.relname, i.relname`;

export async function readStructure(db: Queryable): Promise<DbStructure> {
  const cols = await db.query(COLUMNS, [JOURNAL_TABLE]);
  const cons = await db.query(CONSTRAINTS, [JOURNAL_TABLE]);
  const idx = await db.query(INDEXES, [JOURNAL_TABLE]);
  const out: DbStructure = {};
  const table = (name: string) => (out[name] ??= { columns: [], constraints: [], indexes: [] });
  for (const r of cols.rows) {
    table(r.tbl).columns.push({ name: r.name, type: r.type, notNull: r.not_null, default: r.def ?? null, identity: r.identity, generated: r.generated });
  }
  for (const r of cons.rows) {
    table(r.tbl).constraints.push({
      name: r.name, kind: r.kind, columns: r.cols,
      references: r.ftbl ? `${r.ftbl}(${r.fcols.join(',')})` : null,
      actions: r.kind === 'f' ? `update:${r.upd} delete:${r.del} match:${r.match} deferrable:${r.deferrable} deferred:${r.deferred}` : null,
      expression: r.expr ?? null,
    });
  }
  for (const r of idx.rows) {
    table(r.tbl).indexes.push({ name: r.name, unique: r.uniq, method: r.method, columns: r.cols, options: r.options, predicate: r.pred ?? null });
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function fingerprint(structure: DbStructure): string {
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex');
}

/** One line per table, for error messages: enough to recognise what kind of database this is. */
export function summarize(structure: DbStructure): string {
  const names = Object.keys(structure);
  if (names.length === 0) return 'no tables';
  return names.map(n => `${n}(${structure[n].columns.length})`).join(', ');
}
