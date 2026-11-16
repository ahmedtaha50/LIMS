/**
 * The only way the client talks to the server. Always online: a request that does not reach the server is an error the
 * user sees ("Not saved"), never something queued or kept in the browser to send later.
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'offline', 'The server cannot be reached. Nothing was saved. Check the network and try again.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `The server answered ${res.status}.`, data?.requestId);
  return data as T;
}
