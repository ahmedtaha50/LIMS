/**
 * Breaking-change detection between two OpenAPI documents of /api/v1 (roadmap M22: "CI fails on a breaking spec diff").
 *
 * A change is breaking when a client that worked against `before` can fail against `after`:
 *   - an operation is removed, or the scope it needs changes;
 *   - a request accepted before is refused now: a new required parameter or field, a parameter or field removed (the schemas are strict,
 *     so an unknown key is refused), a narrower type, enum, length, range or item count, a changed pattern;
 *   - an answer the client reads changes: a success status removed, a field removed or no longer always present, a type changed, a
 *     new enum value it does not know.
 * Additive changes (a new operation, a new optional request field, a new response field) are not breaking. When two schemas cannot be
 * compared exactly (anyOf, oneOf), any difference counts as breaking: the check errs on the side of a reviewed decision.
 */
type Json = Record<string, any>;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

function deref(doc: Json, schema: any): any {
  let s = schema;
  for (let i = 0; s && typeof s.$ref === 'string' && i < 20; i++) {
    s = s.$ref.slice(2).split('/').reduce((n: any, k: string) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return s ?? {};
}

const typeOf = (s: any) => JSON.stringify(s.type === undefined ? null : [s.type].flat().sort());
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

interface Ctx { a: Json; b: Json; out: string[] }

/** `before` accepted a value; must `after` still accept it? */
function request(ctx: Ctx, sa: any, sb: any, at: string) {
  const a = deref(ctx.a, sa), b = deref(ctx.b, sb);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if ((a[k] || b[k]) && stable(a[k]) !== stable(b[k])) { ctx.out.push(`${at}: ${k} changed`); return; }
  if (typeOf(a) !== typeOf(b) && b.type !== undefined) { ctx.out.push(`${at}: type changed from ${typeOf(a)} to ${typeOf(b)}`); return; }
  if (b.enum) {
    const lost = (a.enum ?? [null]).filter((v: unknown) => !b.enum.some((w: unknown) => stable(w) === stable(v)));
    if (!a.enum || lost.length) ctx.out.push(`${at}: allowed values narrowed${lost.length && a.enum ? ` (${lost.join(', ')} no longer accepted)` : ''}`);
  }
  if (b.const !== undefined && stable(a.const) !== stable(b.const)) ctx.out.push(`${at}: const changed`);
  for (const k of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) if (b[k] !== undefined && (a[k] === undefined || b[k] < a[k])) ctx.out.push(`${at}: ${k} lowered to ${b[k]}`);
  for (const k of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) if (b[k] !== undefined && (a[k] === undefined || b[k] > a[k])) ctx.out.push(`${at}: ${k} raised to ${b[k]}`);
  if (b.pattern !== undefined && b.pattern !== a.pattern) ctx.out.push(`${at}: pattern changed`);
  if (b.format !== undefined && b.format !== a.format) ctx.out.push(`${at}: format changed`);
  const ra = new Set<string>(a.required ?? []);
  for (const k of b.required ?? []) if (!ra.has(k)) ctx.out.push(`${at}: "${k}" is now required`);
  for (const [k, v] of Object.entries(a.properties ?? {})) {
    if (b.properties && k in b.properties) request(ctx, v, b.properties[k], `${at}.${k}`);
    else if (b.additionalProperties === false) ctx.out.push(`${at}: "${k}" is no longer accepted`);
  }
  if (a.items || b.items) request(ctx, a.items ?? {}, b.items ?? {}, `${at}[]`);
}

/** A client read `before`'s answer; does `after`'s still give it what it read? */
function response(ctx: Ctx, sa: any, sb: any, at: string) {
  const a = deref(ctx.a, sa), b = deref(ctx.b, sb);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if ((a[k] || b[k]) && stable(a[k]) !== stable(b[k])) { ctx.out.push(`${at}: ${k} changed`); return; }
  if (typeOf(a) !== typeOf(b) && a.type !== undefined) { ctx.out.push(`${at}: type changed from ${typeOf(a)} to ${typeOf(b)}`); return; }
  if (a.enum) {
    const added = (b.enum ?? [null]).filter((v: unknown) => !a.enum.some((w: unknown) => stable(w) === stable(v)));
    if (!b.enum || added.length) ctx.out.push(`${at}: new values can be answered${added.length && b.enum ? ` (${added.join(', ')})` : ''}`);
  }
  const rb = new Set<string>(b.required ?? []);
  for (const k of a.required ?? []) if (!rb.has(k)) ctx.out.push(`${at}: "${k}" is no longer always present`);
  for (const [k, v] of Object.entries(a.properties ?? {})) {
    if (!b.properties || !(k in b.properties)) ctx.out.push(`${at}: "${k}" was removed`);
    else response(ctx, v, b.properties[k], `${at}.${k}`);
  }
  if (a.items) response(ctx, a.items, b.items ?? {}, `${at}[]`);
}

const paramKey = (p: any) => `${p.in}:${String(p.name).toLowerCase()}`;
const scopesOf = (op: any) => stable(op.security ?? null);

/** Every breaking difference from `before` to `after`, as readable lines; empty when `after` is compatible. */
export function findBreakingChanges(before: Json, after: Json): string[] {
  const ctx: Ctx = { a: before, b: after, out: [] };
  for (const [path, item] of Object.entries(before.paths ?? {}) as Array<[string, Json]>) {
    for (const method of METHODS) {
      const oa = item[method];
      if (!oa) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const ob = after.paths?.[path]?.[method];
      if (!ob) { ctx.out.push(`${where}: operation removed`); continue; }
      if (scopesOf(oa) !== scopesOf(ob)) ctx.out.push(`${where}: security requirement changed from ${scopesOf(oa)} to ${scopesOf(ob)}`);

      const pa = new Map<string, any>((oa.parameters ?? []).map((p: any) => [paramKey(p), p]));
      const pb = new Map<string, any>((ob.parameters ?? []).map((p: any) => [paramKey(p), p]));
      for (const [k, p] of pb) if (p.required && !pa.get(k)?.required) ctx.out.push(`${where}: parameter ${p.name} (${p.in}) is now required`);
      for (const [k, p] of pa) {
        const q = pb.get(k);
        if (!q) { if (p.in !== 'header') ctx.out.push(`${where}: parameter ${p.name} (${p.in}) was removed`); continue; }
        request(ctx, p.schema ?? {}, q.schema ?? {}, `${where} parameter ${p.name}`);
      }

      const ba = oa.requestBody?.content?.['application/json']?.schema;
      const bb = ob.requestBody?.content?.['application/json']?.schema;
      if (ba && !bb) ctx.out.push(`${where}: request body no longer accepted`);
      else if (!ba && bb && ob.requestBody?.required) ctx.out.push(`${where}: a request body is now required`);
      else if (ba && bb) request(ctx, ba, bb, `${where} body`);

      for (const [status, ra] of Object.entries(oa.responses ?? {}) as Array<[string, any]>) {
        if (!/^2/.test(status)) continue;
        const rb = ob.responses?.[status];
        if (!rb) { ctx.out.push(`${where}: response ${status} removed`); continue; }
        const sa = ra.content?.['application/json']?.schema;
        const sb = rb.content?.['application/json']?.schema;
        if (sa && !sb) ctx.out.push(`${where} ${status}: JSON answer removed`);
        else if (sa && sb) response(ctx, sa, sb, `${where} ${status}`);
      }
    }
  }
  return ctx.out;
}
