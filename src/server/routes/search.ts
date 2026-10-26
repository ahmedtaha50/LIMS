// Domain: global search, the Ctrl+K command palette (roadmap M43, r3-search-perf). Registered in src/server/routes/index.ts and given its
// rule ('GET /search': self, because the permission is per entity, not per route) in src/server/authz/routeTable.ts by the wave gate.
//
//   GET /search?q=<text>[&limit=1-20][&types=samples,batches,...]
//     Answer { q, indexed, groups: [{ type, label, hits: [{ id, label, detail, view, segments }], more }] }
//
// WHAT THE CALLER MAY SEE. Each group is searched only when the caller's role holds the permission that opens the same records through
// their own endpoints (samples: sample.view, as GET /samples; batches and products: master.view; specifications: spec.view; methods:
// method.view; documents and SOPs: doc.view; users: admin.users.view). A group the role may not read is absent from the answer, as if
// it did not exist: a search never confirms that a record is there. Audit-trail, security-log and admin data are not searched at all.
//
// HOW IT MATCHES. Both sides go through search_norm() (migration 0340): lower case, Arabic diacritics and tatweel removed, alef, yeh,
// heh and kaf variants folded, Arabic-Indic digits turned into 0-9. The text is matched as a substring (LIKE '%q%'), so 'ibu' finds
// 'Ibuprofen Tablets' and an Arabic word is found with or without its harakat. The indexed expressions below are the SAME text as the
// GIN trigram indexes of the migration, which is what lets PostgreSQL use them; without pg_trgm the query still runs, on a scan.
// A search is a read: it writes nothing and is not audited.
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { permissionsOfRole } from '../authz/grants';
import { validate } from '../http/validate';
import { likePattern } from './lookup';

const rowsOf = (r: unknown) => (r as { rows: any[] }).rows;

export const SEARCH_MIN_CHARS = 3; // a trigram index needs three characters; with two the answer would be a scan of the whole table
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;

interface Entity {
  type: string;
  label: string;
  /** The permission that lets a role read these records through their own endpoints. */
  permission: string;
  /** The screen (src/components/shell, src/App.tsx) that shows the record, and the segments of its address. */
  view: string;
  /** Runs the search: `pat` is the LIKE pattern of the normalised query, `prefix` the pattern for "starts with", `n` the rows to fetch. */
  run: (db: any, pat: string, prefix: string, n: number) => Promise<Array<{ id: string; label: string; detail: string }>>;
}

const q = (db: any, query: SQL) => db.execute(query).then(rowsOf);

/** Entities, in the order the groups are shown. Each `norm` is character for character the expression of the index in 0340_global_search.sql. */
const ENTITIES: readonly Entity[] = [
  {
    type: 'samples', label: 'Samples', permission: 'sample.view', view: 'samples',
    run: (db, pat, prefix, n) => q(db, sql`
      WITH m AS MATERIALIZED (
        SELECT id, material, batch, state, created_at, search_norm(id || ' ' || material) LIKE ${prefix} AS starts FROM samples
        WHERE search_norm(id || ' ' || material || ' ' || batch) LIKE ${pat})
      SELECT id, id AS label, material || ' · ' || batch || ' · ' || state AS detail FROM m
      ORDER BY starts DESC, created_at DESC, id COLLATE "C" DESC LIMIT ${n}`),
  },
  {
    type: 'batches', label: 'Batches', permission: 'master.view', view: 'master-data',
    run: (db, pat, prefix, n) => q(db, sql`
      WITH m AS MATERIALIZED (
        SELECT id, product_id, batch_no, status, created_at, search_norm(batch_no) LIKE ${prefix} AS starts FROM product_batches
        WHERE search_norm(id || ' ' || batch_no) LIKE ${pat})
      SELECT m.id, m.batch_no AS label, coalesce(p.name, '') || ' · ' || m.status AS detail FROM m LEFT JOIN products p ON p.id = m.product_id
      ORDER BY m.starts DESC, m.created_at DESC, m.id COLLATE "C" DESC LIMIT ${n}`),
  },
  {
    type: 'products', label: 'Products', permission: 'master.view', view: 'master-data',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, name AS label, code || ' · ' || status AS detail FROM products
      WHERE search_norm(code || ' ' || name || ' ' || coalesce(description, '')) LIKE ${pat}
      ORDER BY (search_norm(code || ' ' || name) LIKE ${prefix}) DESC, name COLLATE "C", id COLLATE "C" LIMIT ${n}`),
  },
  {
    type: 'specifications', label: 'Specifications', permission: 'spec.view', view: 'specs',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, material AS label, 'revision ' || version || ' · ' || status AS detail FROM specifications
      WHERE search_norm(id || ' ' || material) LIKE ${pat}
      ORDER BY (search_norm(material) LIKE ${prefix}) DESC, material COLLATE "C", version DESC, id COLLATE "C" LIMIT ${n}`),
  },
  {
    type: 'methods', label: 'Methods', permission: 'method.view', view: 'methods',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, code || ' ' || title AS label, 'revision ' || revision || ' · ' || status AS detail FROM methods
      WHERE search_norm(code || ' ' || title || ' ' || coalesce(description, '')) LIKE ${pat}
      ORDER BY (search_norm(code || ' ' || title) LIKE ${prefix}) DESC, code COLLATE "C", revision DESC, id COLLATE "C" LIMIT ${n}`),
  },
  {
    type: 'sops', label: 'SOPs', permission: 'doc.view', view: 'documents',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, code || ' ' || title AS label, doc_type AS detail FROM documents
      WHERE doc_type = 'SOP' AND search_norm(code || ' ' || title) LIKE ${pat}
      ORDER BY (search_norm(code || ' ' || title) LIKE ${prefix}) DESC, code COLLATE "C", id COLLATE "C" LIMIT ${n}`),
  },
  {
    type: 'documents', label: 'Documents', permission: 'doc.view', view: 'documents',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, code || ' ' || title AS label, doc_type AS detail FROM documents
      WHERE doc_type <> 'SOP' AND search_norm(code || ' ' || title) LIKE ${pat}
      ORDER BY (search_norm(code || ' ' || title) LIKE ${prefix}) DESC, code COLLATE "C", id COLLATE "C" LIMIT ${n}`),
  },
  {
    type: 'users', label: 'Users', permission: 'admin.users.view', view: 'admin',
    run: (db, pat, prefix, n) => q(db, sql`
      SELECT id, name AS label, role || ' · ' || coalesce(email, uid) || CASE WHEN active THEN '' ELSE ' · inactive' END AS detail FROM users
      WHERE search_norm(name || ' ' || uid || ' ' || coalesce(email, '')) LIKE ${pat}
      ORDER BY (search_norm(name) LIKE ${prefix}) DESC, name COLLATE "C", id COLLATE "C" LIMIT ${n}`),
  },
];

export const SEARCH_TYPES = ENTITIES.map(e => e.type) as [string, ...string[]];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(SEARCH_MIN_CHARS, `Type at least ${SEARCH_MIN_CHARS} characters to search.`).max(SEARCH_MAX_CHARS, `q is too long (at most ${SEARCH_MAX_CHARS} characters).`),
  limit: z.coerce.number().int('limit must be a whole number.').min(1, `limit must be between 1 and ${SEARCH_MAX_LIMIT}.`).max(SEARCH_MAX_LIMIT, `limit must be between 1 and ${SEARCH_MAX_LIMIT}.`).default(SEARCH_DEFAULT_LIMIT),
  types: z.string().max(200).transform(s => s.split(',').map(t => t.trim()).filter(Boolean))
    .refine(list => list.every(t => (SEARCH_TYPES as string[]).includes(t)), { message: `types must be a comma-separated list of ${SEARCH_TYPES.join(', ')}.` }).optional(),
}).strict();

export const searchRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // Whether the trigram indexes exist (pg_trgm may be missing in a minimal PostgreSQL). Only a positive answer is kept: a database
  // that gets the extension later is noticed on the next look.
  let trigram = false;
  let trigramCheckedAt = 0;
  const hasTrigram = async () => {
    if (trigram || Date.now() - trigramCheckedAt < 60_000) return trigram;
    trigramCheckedAt = Date.now();
    const r = rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'samples_search_trgm_idx' LIMIT 1`));
    trigram = r.length > 0;
    return trigram;
  };

  router.get('/search', requireAuth, validate(searchQuerySchema, 'query'), async (req, res) => {
    const user = (req as any).user as { role: string };
    const { q: text, limit, types } = req.query as unknown as z.infer<typeof searchQuerySchema>;

    const granted = new Set(await permissionsOfRole(db, user.role));
    const entities = ENTITIES.filter(e => granted.has(e.permission) && (!types || types.includes(e.type)));

    const normalised = String(rowsOf(await db.execute(sql`SELECT search_norm(${text}) AS n`))[0].n).trim();
    const body = likePattern(normalised);
    const [pat, prefix] = [`%${body}%`, `${body}%`];

    const groups = await Promise.all(entities.map(async e => {
      const rows = await e.run(db, pat, prefix, limit + 1);
      return {
        type: e.type, label: e.label, more: rows.length > limit,
        hits: rows.slice(0, limit).map(r => ({ id: r.id, label: r.label, detail: r.detail, view: e.view, segments: e.view === 'samples' || e.view === 'documents' ? [r.id] : [] })),
      };
    }));
    res.json({ q: text, indexed: await hasTrigram(), groups: groups.filter(g => g.hits.length > 0) });
  });

  return router;
};
