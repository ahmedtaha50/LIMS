import { HttpError } from '../core/errors.js';

/**
 * The LIMS link (E18, on the LIMS machine API since E30). The LIMS of this repository publishes its machine API at /api/v1
 * with an OpenAPI document (docs/api/openapi.json); the EBR uses two operations of it:
 *   POST /api/v1/samples:batch     scope samples:write, header Idempotency-Key, body { items: [{ material, batch }] }
 *                                  -> 201 { count, samples: [{ id, state, ... }] }; a repeated key replays the stored answer
 *                                     (header Idempotent-Replayed: true) and registers nothing
 *   GET  /api/v1/samples/{id}      scope samples:read -> 200 { sample: { id, state, ... }, results: [{ parameter, value, unit, isOos, ... }] }
 * The token is issued by the LIMS administrator (API clients: scopes samples:write and samples:read, an expiry date, a signed
 * reason) and given to the EBR as EBR_LIMS_TOKEN; EBR_LIMS_URL is the address of the LIMS (without /api/v1).
 * The Idempotency-Key is the EBR reference EBR:<batch>:<phase>.<step>: the same at every attempt, so a retry after a failure
 * or a lost answer gets the sample registered the first time, never a second one (E18#2, E30#2).
 */
export type LimsSample = { id: string; status: string; result?: unknown; created?: boolean };
export type LimsConfig = { url: string; token: string; timeoutMs: number };
export const limsConfig = (env: NodeJS.ProcessEnv = process.env): LimsConfig | null =>
  env.EBR_LIMS_URL ? { url: env.EBR_LIMS_URL.replace(/\/+$/, '').replace(/\/api\/v1$/, ''), token: env.EBR_LIMS_TOKEN ?? '', timeoutMs: Number(env.EBR_LIMS_TIMEOUT_MS ?? 8000) } : null;

/** The LIMS state in which a result counts (E18#1: kept on the batch only once approved there). */
export const APPROVED = 'Approved';

const down = (why: string) => new HttpError(503, 'lims_unavailable', `The LIMS cannot be reached (${why}). The step is not recorded and no duplicate request will be made: try again when the LIMS is back.`);
async function call(cfg: LimsConfig, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ json: any; replayed: boolean }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', 'content-type': 'application/json', ...headers },
      signal: AbortSignal.timeout(cfg.timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (e) { throw down(e instanceof Error ? e.name === 'TimeoutError' ? 'no answer in time' : e.message : String(e)); }
  if (res.status >= 500) throw down(`it answered ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'lims_refused', 'The LIMS refused the EBR token (missing, expired, revoked, or without the scopes samples:write and samples:read): tell the LIMS administrator.');
  if (!res.ok) {
    // the LIMS answers problems as application/problem+json: { title, detail, errors: [{ detail }] }
    const text = await res.text();
    let detail = text.slice(0, 300);
    try { const p = JSON.parse(text) as { detail?: string; title?: string; errors?: { detail?: string }[] }; detail = [p.detail ?? p.title, ...(p.errors ?? []).map(e => e.detail)].filter(Boolean).join(' ') || detail; } catch { /* plain text */ }
    throw new HttpError(502, 'lims_error', `The LIMS refused the request (${res.status}): ${detail}`);
  }
  return { json: await res.json(), replayed: res.headers.get('idempotent-replayed') === 'true' };
}

/** Registers the sample, or gets the one the same reference registered before: called again after any failure, it never makes a second one. */
export async function requestSample(cfg: LimsConfig, ref: string, sample: { product: string; batch: string; test: string; quantity: number; unit: string }): Promise<LimsSample & { created: boolean }> {
  const { json, replayed } = await call(cfg, 'POST', '/samples:batch', { items: [{ material: sample.product, batch: sample.batch }] }, { 'idempotency-key': ref });
  const s = json?.samples?.[0] as { id?: string; state?: string } | undefined;
  if (!s?.id || !s.state) throw new HttpError(502, 'lims_error', 'The LIMS answered without the registered sample.');
  return { id: s.id, status: s.state, created: !replayed };
}

/** The sample as the LIMS has it now; the results come with it (the caller keeps them only when the state is Approved). */
export async function getSample(cfg: LimsConfig, id: string): Promise<LimsSample> {
  const { json } = await call(cfg, 'GET', `/samples/${encodeURIComponent(id)}`);
  const results = (json?.results ?? []) as { parameter: string; value: string | null; unit: string | null; isOos: boolean }[];
  return { id: json.sample.id, status: json.sample.state, result: results.map(r => ({ parameter: r.parameter, value: r.value, unit: r.unit, outOfSpecification: r.isOos })) };
}
