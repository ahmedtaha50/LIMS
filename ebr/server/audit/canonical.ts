/**
 * One text for one value, whatever the order of its keys: what is hashed for the audit chain and for signatures.
 * Dates become ISO strings; undefined members are left out (as JSON does).
 */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x === undefined ? null : x)).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonical: a number that is not finite cannot be recorded');
  return JSON.stringify(v);
}
