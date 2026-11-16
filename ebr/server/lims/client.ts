import { HttpError } from '../core/errors.js';

/**
 * The LIMS integration contract (E18). The EBR calls two endpoints of the LIMS, with a bearer token issued by the LIMS
 * for this integration (EBR_LIMS_URL, EBR_LIMS_TOKEN):
 *   GET  /api/integration/samples?externalRef=<ref>  -> [{ id, status, result? }]   (the request with this reference, if any)
 *   POST /api/integration/samples  { externalRef, product, batch, test, quantity, unit }  -> { id, status }
 * Every request carries the EBR's reference. Before creating, the EBR asks whether the reference already exists: a request
 * whose answer was lost (timeout, network) is found, not created again (E18#2).
 */
export type LimsSample = { id: string; status: string; result?: unknown };
export type LimsConfig = { url: string; token: string; timeoutMs: number };
export const limsConfig = (env: NodeJS.ProcessEnv = process.env): LimsConfig | null =>
  env.EBR_LIMS_URL ? { url: env.EBR_LIMS_URL.replace(/\/$/, ''), token: env.EBR_LIMS_TOKEN ?? '', timeoutMs: Number(env.EBR_LIMS_TIMEOUT_MS ?? 8000) } : null;

const down = (why: string) => new HttpError(503, 'lims_unavailable', `The LIMS cannot be reached (${why}). The step is not recorded and no duplicate request will be made: try again when the LIMS is back.`);
async function call<T>(cfg: LimsConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(cfg.url + path, { method, headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(cfg.timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (e) { throw down(e instanceof Error ? e.name === 'TimeoutError' ? 'no answer in time' : e.message : String(e)); }
  if (res.status >= 500) throw down(`it answered ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'lims_refused', 'The LIMS refused the EBR (integration token): tell the administrator.');
  if (!res.ok) throw new HttpError(502, 'lims_error', `The LIMS refused the request: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const findByRef = async (cfg: LimsConfig, ref: string) => (await call<LimsSample[]>(cfg, 'GET', `/api/integration/samples?externalRef=${encodeURIComponent(ref)}`))[0] ?? null;

/** Finds the request with this reference, or creates it: called again after any failure, it never makes a second one. */
export async function requestSample(cfg: LimsConfig, ref: string, sample: { product: string; batch: string; test: string; quantity: number; unit: string }): Promise<LimsSample & { created: boolean }> {
  const existing = await findByRef(cfg, ref);
  if (existing) return { ...existing, created: false };
  return { ...(await call<LimsSample>(cfg, 'POST', '/api/integration/samples', { externalRef: ref, ...sample })), created: true };
}
