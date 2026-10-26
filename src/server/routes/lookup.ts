// Domain: lookups, list pages and exports for the screens. Owned by r2-ui-foundation (roadmap M24).
//
//   GET  /lookup/<kind>             the options of an EntityPicker: ?q (text), ?id (resolve one stored id), ?limit (1-50, default 20)
//                                   and per kind ?sampleId, ?oos (results), ?role (users), ?status (specifications).
//                                   Answer { items: [{ id, label, detail }], truncated }. A picker is guidance only: every handler
//                                   that receives an id still validates it.
//   GET  /lists/samples             the list contract behind DataGrid (below).
//   POST /lists/samples/export      every matching row, as CSV or XLSX, audited (user, filter, sort, row count, sha256) in the
//                                   transaction that read the rows. Never capped: if the list counts 50 000 rows, the file has 50 000.
//
// THE LIST CONTRACT (for other list routes; the helpers below are exported for them):
//   query   ?q  free text, matched on the server     ?sort / ?dir  one of the declared sortable columns, ties broken by id
//           ?limit  1-200, default 50                ?after=<cursor> the page after, ?before=<cursor> the page before (keyset)
//           plus the list's own filters (here ?state). The schema is strict: an unknown key is a 400.
//   answer  { rows, total, offset, nextCursor, prevCursor, sort: { key, dir } }
//           total  the rows matching the filter; offset  how many come before the first row of this page; a cursor is null when
//           there is no page in that direction. A cursor carries the sort it was made for and is refused under another sort.
import { createHash, randomUUID } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../../db/utils';
import { SAMPLE_STATES } from '../../lib/validations/samples';
import { csvCell } from '../audit/query';
import { SERVICE_ACCOUNT_ROLE } from '../auth/principals/apiToken';
import { securityEventContext, writeSecurityEvent } from '../audit/securityEvents';
import type { Db, RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { withTransaction, type Executor } from '../core/tx';
import { ValidationError } from '../http/errors';
import { validate } from '../http/validate';

const rowsOf = (r: unknown) => (r as { rows: any[] }).rows;

// ---- the list contract --------------------------------------------------------------------------------------------------------

export const LIST_MAX_LIMIT = 200;
export const LIST_DEFAULT_LIMIT = 50;

/** A sortable column: the SQL expression, and how its value is written into (and read back from) a cursor. */
export interface SortColumn { expr: SQL; cursorText: SQL; fromCursor: (text: string) => SQL }
const textColumn = (expr: SQL): SortColumn => ({ expr, cursorText: expr, fromCursor: v => sql`${v}` });
/** Full microsecond precision in the cursor: a JavaScript Date keeps milliseconds only, and paging would skip rows. */
const timeColumn = (expr: SQL): SortColumn => ({
  expr,
  cursorText: sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  fromCursor: v => sql`${v}::timestamptz`,
});

const cursorSchema = z.tuple([z.string(), z.enum(['asc', 'desc']), z.string(), z.string()]);
export const encodeListCursor = (sort: string, dir: string, key: string, id: string) => Buffer.from(JSON.stringify([sort, dir, key, id])).toString('base64url');
export function decodeListCursor(cursor: string, sort: string, dir: string): { key: string; id: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { parsed = null; }
  const c = cursorSchema.safeParse(parsed);
  const bad = (message: string) => new ValidationError(message, [{ path: 'cursor', message }]);
  if (!c.success) throw bad('The page cursor is not valid: use nextCursor or prevCursor of the previous answer.');
  if (c.data[0] !== sort || c.data[1] !== dir) throw bad('The page cursor belongs to another sort order: start again from the first page.');
  return { key: c.data[2], id: c.data[3] };
}

/** The common query keys of a list. `sortKeys` is the list's sortable columns; add the list's own filters with .extend(). */
export function listQueryShape<K extends string>(sortKeys: readonly [K, ...K[]], defaultSort: K, defaultDir: 'asc' | 'desc') {
  return {
    q: z.string().trim().max(200, 'q is too long (at most 200 characters).').optional(),
    sort: z.enum(sortKeys, { error: `sort must be one of ${sortKeys.join(', ')}.` }).default(defaultSort),
    dir: z.enum(['asc', 'desc'], { error: 'dir must be asc or desc.' }).default(defaultDir),
    limit: z.coerce.number().int('limit must be a whole number.').min(1, `limit must be between 1 and ${LIST_MAX_LIMIT}.`).max(LIST_MAX_LIMIT, `limit must be between 1 and ${LIST_MAX_LIMIT}.`).default(LIST_DEFAULT_LIMIT),
    after: z.string().max(1000).optional(),
    before: z.string().max(1000).optional(),
  };
}
const oneDirection = (v: { after?: string; before?: string }) => !(v.after && v.before);
const oneDirectionMessage = { message: 'Send after or before, not both.' };

/** ILIKE pattern for a free-text search: % _ and \ are literal characters. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

export interface ListSpec {
  /** FROM ... (with joins), aliased so `where` and the columns can use it. */
  from: SQL;
  select: SQL;
  /** The tie-breaker, unique and NOT NULL. */
  id: SQL;
  sortable: Record<string, SortColumn>;
}

export interface ListPage<T> { rows: T[]; total: number; offset: number; nextCursor: string | null; prevCursor: string | null; sort: { key: string; dir: 'asc' | 'desc' } }

/** One page of a list by keyset, both ways, with the honest total and position. `where` is the list's filter (may be empty). */
export async function runListPage<T>(ex: Executor, spec: ListSpec, where: SQL[], q: { sort: string; dir: 'asc' | 'desc'; limit: number; after?: string; before?: string }, mapRow: (r: any) => T): Promise<ListPage<T>> {
  const col = spec.sortable[q.sort];
  const asc = q.dir === 'asc';
  const backwards = !!q.before;
  const cursor = q.after ? decodeListCursor(q.after, q.sort, q.dir) : q.before ? decodeListCursor(q.before, q.sort, q.dir) : null;
  const filter = where.length ? sql.join(where, sql` AND `) : sql`TRUE`;
  // Going forwards in an ascending list (or backwards in a descending one) means "greater than the cursor".
  const greater = asc !== backwards;
  const keyset = cursor ? sql`(${col.expr}, ${spec.id}) ${greater ? sql`>` : sql`<`} (${col.fromCursor(cursor.key)}, ${cursor.id})` : sql`TRUE`;
  const order = (asc !== backwards) ? sql`ASC` : sql`DESC`;

  const fetched = rowsOf(await ex.execute(sql`
    SELECT ${spec.select}, ${col.cursorText} AS "__key", ${spec.id} AS "__id"
    FROM ${spec.from} WHERE ${filter} AND ${keyset}
    ORDER BY ${col.expr} ${order}, ${spec.id} ${order} LIMIT ${q.limit + 1}`));
  const more = fetched.length > q.limit;
  const page = fetched.slice(0, q.limit);
  if (backwards) page.reverse();

  const total = Number(rowsOf(await ex.execute(sql`SELECT count(*)::int AS n FROM ${spec.from} WHERE ${filter}`))[0].n);
  let offset = 0;
  if (page.length) {
    const first = page[0];
    const before = sql`(${col.expr}, ${spec.id}) ${asc ? sql`<` : sql`>`} (${col.fromCursor(first.__key)}, ${first.__id})`;
    offset = Number(rowsOf(await ex.execute(sql`SELECT count(*)::int AS n FROM ${spec.from} WHERE ${filter} AND ${before}`))[0].n);
  } else if (cursor && !backwards) {
    offset = total;
  }
  const cursorOf = (r: any) => encodeListCursor(q.sort, q.dir, r.__key, r.__id);
  // A page exists in a direction when rows lie beyond this one there (counted, not guessed from a short page).
  const hasNext = page.length > 0 && (backwards ? offset + page.length < total : more);
  const hasPrev = page.length > 0 && offset > 0;
  return {
    rows: page.map(mapRow),
    total,
    offset,
    nextCursor: hasNext ? cursorOf(page[page.length - 1]) : null,
    prevCursor: hasPrev ? cursorOf(page[0]) : null,
    sort: { key: q.sort, dir: q.dir },
  };
}

// ---- exports: formula-safe CSV and XLSX ---------------------------------------------------------------------------------------

export interface ExportColumn<T> { header: string; value: (row: T) => string | number | null | undefined }

/** UTF-8 with a byte-order mark (spreadsheets otherwise mis-read non-Latin names), CRLF lines, every text cell through csvCell. */
export function toCsv<T>(columns: readonly ExportColumn<T>[], rows: readonly T[]): Buffer {
  const lines = [columns.map(c => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map(c => csvCell(c.value(r))).join(','));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

// XML 1.0 forbids most control characters; a value that holds one would make the workbook unreadable.
// eslint-disable-next-line no-control-regex
const xmlText = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/**
 * A one-sheet workbook. Text is written as inline strings and numbers as numbers; nothing is ever written as a formula (<f>), so a
 * value such as =HYPERLINK(...) stays the text it is. No dependency: the package is a stored (uncompressed) ZIP.
 */
export function toXlsx<T>(columns: readonly ExportColumn<T>[], rows: readonly T[], sheetName = 'Export', now = new Date()): Buffer {
  const cell = (ref: string, v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(v))}</t></is></c>`;
  };
  const rowXml = (n: number, values: Array<string | number | null | undefined>) => `<row r="${n}">${values.map((v, i) => cell(`${colName(i)}${n}`, v)).join('')}</row>`;
  const sheetRows = [rowXml(1, columns.map(c => c.header)), ...rows.map((r, i) => rowXml(i + 2, columns.map(c => c.value(r))))];
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`],
  ];
  return storedZip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]), now);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A ZIP archive with every entry stored (method 0). Small, valid, and readable by every spreadsheet application. */
function storedZip(entries: Array<[string, Buffer]>, now: Date): Buffer {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- samples ------------------------------------------------------------------------------------------------------------------

const SAMPLE_SORT_KEYS = ['createdAt', 'id', 'material', 'batch', 'state'] as const;
const sampleFilterShape = {
  state: z.enum(SAMPLE_STATES, { error: `state must be one of ${SAMPLE_STATES.join(', ')}.` }).optional(),
};
export const sampleListQuerySchema = z.object({ ...listQueryShape(SAMPLE_SORT_KEYS, 'createdAt', 'desc'), ...sampleFilterShape }).strict().refine(oneDirection, oneDirectionMessage);

const { limit: _limit, after: _after, before: _before, ...exportListShape } = listQueryShape(SAMPLE_SORT_KEYS, 'createdAt', 'desc');
/** The export takes the list's filter and sort, the format and the purpose (the audit reason). Never a limit, never an actor. */
export const sampleExportSchema = z.object({
  ...exportListShape,
  ...sampleFilterShape,
  format: z.enum(['csv', 'xlsx'], { error: 'format must be csv or xlsx.' }),
  reason: z.string('A reason for the export is required.').trim().min(3, 'Give the reason for the export (at least 3 characters).').max(500, 'The reason is too long (at most 500 characters).'),
}).strict();

const SAMPLE_LIST: ListSpec = {
  from: sql`samples s LEFT JOIN users u ON u.id = s.created_by`,
  select: sql`s.id, s.material, s.batch, s.state, s.created_at, s.created_by, u.name AS created_by_name, s.version, s.spec_id, s.spec_revision`,
  id: sql`s.id`,
  sortable: {
    createdAt: timeColumn(sql`s.created_at`),
    id: textColumn(sql`s.id`),
    material: textColumn(sql`s.material`),
    batch: textColumn(sql`s.batch`),
    state: textColumn(sql`s.state`),
  },
};

export interface SampleListRow {
  id: string; material: string; batch: string; state: string; createdAt: string; createdBy: string; createdByName: string | null;
  version: number; specId: string | null; specRevision: number | null;
}
const sampleRow = (r: any): SampleListRow => ({
  id: r.id, material: r.material, batch: r.batch, state: r.state, createdAt: new Date(r.created_at).toISOString(), createdBy: r.created_by,
  createdByName: r.created_by_name ?? null, version: Number(r.version), specId: r.spec_id ?? null, specRevision: r.spec_revision === null || r.spec_revision === undefined ? null : Number(r.spec_revision),
});

function sampleWhere(f: { q?: string; state?: string }): SQL[] {
  const where: SQL[] = [];
  if (f.state) where.push(sql`s.state = ${f.state}`);
  if (f.q) {
    // r3-search-perf (M43): the same normalised text as the trigram index of 0340_global_search, so a search of 100,000 samples uses the index.
    where.push(sql`search_norm(s.id || ' ' || s.material || ' ' || s.batch) LIKE '%' || replace(replace(replace(search_norm(${f.q}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`);
  }
  return where;
}

const SAMPLE_EXPORT_COLUMNS: readonly ExportColumn<SampleListRow>[] = [
  { header: 'Sample ID', value: r => r.id },
  { header: 'Material', value: r => r.material },
  { header: 'Batch', value: r => r.batch },
  { header: 'State', value: r => r.state },
  { header: 'Registered (UTC)', value: r => r.createdAt },
  { header: 'Registered by', value: r => r.createdByName ?? r.createdBy },
  { header: 'Specification', value: r => r.specId },
  { header: 'Specification revision', value: r => r.specRevision },
  { header: 'Record version', value: r => r.version },
];

async function allSampleRows(ex: Executor, f: { q?: string; state?: string; sort: string; dir: 'asc' | 'desc' }): Promise<SampleListRow[]> {
  const col = SAMPLE_LIST.sortable[f.sort];
  const where = sampleWhere(f);
  const order = f.dir === 'asc' ? sql`ASC` : sql`DESC`;
  return rowsOf(await ex.execute(sql`
    SELECT ${SAMPLE_LIST.select} FROM ${SAMPLE_LIST.from} WHERE ${where.length ? sql.join(where, sql` AND `) : sql`TRUE`}
    ORDER BY ${col.expr} ${order}, s.id ${order}`)).map(sampleRow);
}

// ---- lookups ------------------------------------------------------------------------------------------------------------------

export interface LookupItem { id: string; label: string; detail: string }
const lookupBase = {
  q: z.string().trim().max(200).optional(),
  id: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1, 'limit must be between 1 and 50.').max(50, 'limit must be between 1 and 50.').default(20),
};

interface LookupKind { schema: z.ZodType; run: (ex: Executor, q: any, take: number) => Promise<LookupItem[]> }

export const LOOKUP_KINDS: Record<string, LookupKind> = {
  samples: {
    schema: z.object({ ...lookupBase, state: sampleFilterShape.state }).strict(),
    run: async (ex, q, take) => rowsOf(await ex.execute(sql`
      SELECT id, material, batch, state FROM samples
      WHERE ${q.id ? sql`id = ${q.id}` : sql`TRUE`} AND ${q.state ? sql`state = ${q.state}` : sql`TRUE`}
        AND ${q.q ? sql`(id ILIKE ${likePattern(q.q)} OR material ILIKE ${likePattern(q.q)} OR batch ILIKE ${likePattern(q.q)})` : sql`TRUE`}
      ORDER BY created_at DESC, id DESC LIMIT ${take}`)).map(r => ({ id: r.id, label: r.id, detail: `${r.material} · ${r.batch} · ${r.state}` })),
  },
  results: {
    schema: z.object({ ...lookupBase, sampleId: z.string().trim().min(1).max(200).optional(), oos: z.enum(['true', 'false']).optional() }).strict(),
    run: async (ex, q, take) => rowsOf(await ex.execute(sql`
      SELECT id, sample_id, parameter, value, is_oos FROM results
      WHERE ${q.id ? sql`id = ${q.id}` : sql`TRUE`} AND ${q.sampleId ? sql`sample_id = ${q.sampleId}` : sql`TRUE`}
        AND ${q.oos ? sql`is_oos = ${q.oos === 'true'}` : sql`TRUE`}
        AND ${q.q ? sql`(sample_id ILIKE ${likePattern(q.q)} OR parameter ILIKE ${likePattern(q.q)} OR id ILIKE ${likePattern(q.q)})` : sql`TRUE`}
      ORDER BY sample_id DESC, parameter ASC, id ASC LIMIT ${take}`))
      .map(r => ({ id: r.id, label: `${r.sample_id} · ${r.parameter}`, detail: `Result ${r.value ?? 'not entered'}${r.is_oos ? ' · OOS' : ''}` })),
  },
  // Active accounts, name and role only: what a colleague can already read in the training matrix. Never the e-mail or anything secret.
  // Never an API client's service account (r2-api-v1): nobody assigns work to an instrument, also not when ?role names its role.
  users: {
    schema: z.object({ ...lookupBase, role: z.string().trim().min(1).max(50).optional() }).strict(),
    run: async (ex, q, take) => rowsOf(await ex.execute(sql`
      SELECT id, name, role FROM users
      WHERE active AND role <> ${SERVICE_ACCOUNT_ROLE} AND ${q.id ? sql`id = ${q.id}` : sql`TRUE`} AND ${q.role ? sql`role = ${q.role}` : sql`TRUE`}
        AND ${q.q ? sql`name ILIKE ${likePattern(q.q)}` : sql`TRUE`}
      ORDER BY name ASC, id ASC LIMIT ${take}`)).map(r => ({ id: r.id, label: r.name, detail: r.role })),
  },
  specifications: {
    schema: z.object({ ...lookupBase, status: z.string().trim().min(1).max(50).optional() }).strict(),
    run: async (ex, q, take) => rowsOf(await ex.execute(sql`
      SELECT id, material, revision_label, status FROM specifications
      WHERE ${q.id ? sql`id = ${q.id}` : sql`TRUE`} AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
        AND ${q.q ? sql`(material ILIKE ${likePattern(q.q)} OR id ILIKE ${likePattern(q.q)})` : sql`TRUE`}
      ORDER BY material ASC, revision_label DESC, id ASC LIMIT ${take}`)).map(r => ({ id: r.id, label: `${r.material} Rev ${r.revision_label}`, detail: r.status })),
  },
  instruments: {
    schema: z.object({ ...lookupBase }).strict(),
    run: async (ex, q, take) => rowsOf(await ex.execute(sql`
      SELECT id, name, type, status FROM instruments
      WHERE ${q.id ? sql`id = ${q.id}` : sql`TRUE`}
        AND ${q.q ? sql`(name ILIKE ${likePattern(q.q)} OR id ILIKE ${likePattern(q.q)} OR type ILIKE ${likePattern(q.q)})` : sql`TRUE`}
      ORDER BY name ASC, id ASC LIMIT ${take}`)).map(r => ({ id: r.id, label: r.name, detail: `${r.type} · ${r.status}` })),
  },
};

async function lookup(db: Db, kind: LookupKind, q: any) {
  const found = await kind.run(db, q, q.limit + 1);
  return { items: found.slice(0, q.limit), truncated: found.length > q.limit };
}

// ---- routes -------------------------------------------------------------------------------------------------------------------

export const lookupRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // One route per kind, so the route table binds each to its own permission (src/server/authz/routeTable.ts).
  for (const [name, kind] of Object.entries(LOOKUP_KINDS)) {
    router.get(`/lookup/${name}`, requireAuth, validate(kind.schema, 'query'), async (req, res) => {
      res.json(await lookup(db, kind, req.query));
    });
  }

  router.get('/lists/samples', requireAuth, validate(sampleListQuerySchema, 'query'), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof sampleListQuerySchema>;
    res.json(await runListPage(db, SAMPLE_LIST, sampleWhere(q), q, sampleRow));
  });

  router.post('/lists/samples/export', requireAuth, validate(sampleExportSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as z.infer<typeof sampleExportSchema>;
    const filter = Object.fromEntries(Object.entries({ q: body.q, state: body.state }).filter(([, v]) => v !== undefined && v !== ''));
    const stamp = new Date();
    const fileName = `samples-${stamp.toISOString().replace(/[:.]/g, '-')}.${body.format}`;
    // The rows, the file, its hash and the audit entry come from one transaction: the entry describes exactly the bytes delivered.
    const out = await withTransaction(db, async (tx) => {
      const rows = await allSampleRows(tx, { ...filter, sort: body.sort, dir: body.dir });
      const content = body.format === 'csv' ? toCsv(SAMPLE_EXPORT_COLUMNS, rows) : toXlsx(SAMPLE_EXPORT_COLUMNS, rows, 'Samples', stamp);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const record = { format: body.format, fileName, filter, sort: { key: body.sort, dir: body.dir }, rowCount: rows.length, sha256, columns: SAMPLE_EXPORT_COLUMNS.map(c => c.header) };
      const entry = await writeAudit(tx, user.id, 'Export', 'SampleList', `export-${(req as any).id ?? randomUUID()}`, 'export', '', JSON.stringify(record), body.reason);
      await writeSecurityEvent(tx, {
        type: 'EXPORT', outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req),
        detail: { entity: 'SampleList', auditSequence: entry.sequence, format: body.format, filter, rowCount: rows.length, sha256 },
      });
      return { content, sha256, rowCount: rows.length, auditSequence: Number(entry.sequence) };
    });
    res.set('Cache-Control', 'no-store').json({
      fileName,
      contentType: body.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rowCount: out.rowCount,
      sha256: out.sha256,
      auditSequence: out.auditSequence,
      content: out.content.toString('base64'),
    });
  });

  return router;
};
