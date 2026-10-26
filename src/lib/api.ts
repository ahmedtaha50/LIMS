/**
 * Client session layer (roadmap M06). Every request the application makes goes through here, so that a session that idles, expires
 * or is ended elsewhere is handled in one place instead of white-screening whichever view happened to be loading.
 *
 *   apiFetch(path, options)   JSON in, JSON out, a typed ApiError for everything else (status, code, message, request id, details).
 *   sessionStore              the one source of truth for who is signed in and whether the screen is locked (React: useSessionState).
 *   sessionEvents             'session:locked' | 'session:renewed' | 'session:expired' | 'session:password-change-required'.
 *   reauth(credentials)       unlocks a locked screen: POST /auth/reauth with the same session id; the token is swapped under the
 *                             mounted page, so nothing the user typed is lost.
 *   installSessionFetch()     gives the existing raw fetch() calls of the views (67 of them, owned by other tracks) the same protection.
 *
 * What the server answers (src/server/auth/requireAuth.ts) and what is done about it:
 *   401 SESSION_IDLE        not a logout. The screen locks, the request waits, the user re-enters the password (and the authenticator
 *                           code if there is one), and the request is then repeated with the new token.
 *   401 SESSION_EXPIRED | SESSION_REVOKED | INVALID_TOKEN | USER_INACTIVE | UNAUTHORIZED
 *                           the session is over: 'session:expired', and the views are replaced by an inline "Session expired" state.
 *   403 PASSWORD_CHANGE_REQUIRED   'session:password-change-required': the forced change-password screen.
 *
 * Rules this file enforces (21 CFR 11.10(d), 11.300; the roadmap's gxpRisk for M06):
 *   * Re-authentication never re-signs anything. A request that carries a password or authenticator code (an e-signature, a
 *     certification, an administrator action) is NOT repeated after an unlock: it is answered with RESUBMIT_REQUIRED and the user
 *     submits it again on purpose. Everything else that was refused only because the session was idle is repeated once.
 *   * A locked screen sends nothing. A request made while locked waits, so a page that is left locked cannot keep the server's idle clock
 *     alive (the server counts requests, not mouse movements).
 *   * The token lives in sessionStorage (this window only, gone when it closes), never in localStorage; the user is whatever
 *     GET /auth/me says, never something decoded from the token.
 */
import { useSyncExternalStore } from 'react';

export const TOKEN_KEY = 'gxp_token';

// ---- types -------------------------------------------------------------------------------------------------------------------

export interface SessionInfo { id: string; idleTimeoutMinutes: number; idleExpiresAt: string; expiresAt: string }

export interface SelfUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
  active: boolean;
  hasCompletedSoftwareTraining: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  passwordExpiresAt: string;
}

/** The body of every successful sign-in (login, TOTP, enrolment) and of re-authentication. */
export interface SignIn {
  token: string;
  user: SelfUser;
  mustChangePassword: boolean;
  session: SessionInfo;
  /** Only after TOTP enrolment: shown once. */
  recoveryCodes?: string[];
}

export type LoginStep =
  | { kind: 'session'; signIn: SignIn }
  | { kind: 'totp'; tempToken: string }
  | { kind: 'totp-setup'; tempToken: string; qrCode: string; secret: string; otpauthUri?: string };

// ---- ApiError ----------------------------------------------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, extra: { details?: unknown; requestId?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.requestId = extra.requestId;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/** The text to show for anything thrown by a call: the server's message for an ApiError, a plain sentence otherwise. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// ---- state -------------------------------------------------------------------------------------------------------------------

export type SessionStatus = 'booting' | 'signed-out' | 'active' | 'locked' | 'expired';

export interface SessionState {
  status: SessionStatus;
  /** The current access token (replaced at every re-authentication). */
  token: string | null;
  /**
   * The token the session started this page with. It is what the views receive as their `token` prop and it does not change when the
   * current token is swapped, so a view whose effect depends on `token` does not reload (and lose its form) at an unlock. A request
   * that still carries it is sent with the current token (see installSessionFetch).
   */
  viewToken: string | null;
  user: SelfUser | null;
  session: SessionInfo | null;
  mustChangePassword: boolean;
  lockReason: 'idle' | 'server' | null;
  /** Why the session ended (server code), when it did. */
  endedCode: string | null;
  /** A sentence for the sign-in screen after the session ended. */
  notice: string | null;
}

const SIGNED_OUT: SessionState = { status: 'signed-out', token: null, viewToken: null, user: null, session: null, mustChangePassword: false, lockReason: null, endedCode: null, notice: null };

let state: SessionState = SIGNED_OUT;
const listeners = new Set<() => void>();
/** Every token this page has held for the current session: the views may still hold an older one. */
let knownTokens = new Set<string>();
let lastContact = 0;

function setState(patch: Partial<SessionState>) {
  // An update that changes nothing is not published: every subscriber would render again for no reason.
  if ((Object.keys(patch) as Array<keyof SessionState>).every(k => Object.is(state[k], patch[k]))) return;
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

/** Keeps the old object when the new one says the same, so a view that depends on `user` does not run its effect again at every refresh. */
const keepIfSame = <T,>(old: T, next: T): T => JSON.stringify(old) === JSON.stringify(next) ? old : next;

export const sessionStore = {
  getState: (): SessionState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** React binding. The third argument is for server rendering (the screens are also rendered to strings in tests). */
export function useSessionState(): SessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getState, sessionStore.getState);
}

/** Listen with sessionEvents.addEventListener('session:expired', e => ...). The window in a browser, a plain EventTarget elsewhere. */
export const sessionEvents: EventTarget = typeof window !== 'undefined' ? window : new EventTarget();

type SessionEventName = 'session:locked' | 'session:renewed' | 'session:expired' | 'session:password-change-required';
function emit(name: SessionEventName, detail: Record<string, unknown> = {}) {
  sessionEvents.dispatchEvent(new CustomEvent(name, { detail }));
}

/** When the server last answered a request that counts as activity (it restarts the idle clock). */
export const lastServerContact = () => lastContact;

// ---- storage (every access guarded: it throws in a private window or with site data blocked) --------------------------------------

function storageRead(): string | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(TOKEN_KEY) : null; } catch { return null; }
}
function storageWrite(token: string) {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(TOKEN_KEY, token); } catch { /* the page still works from memory; a reload will ask for a sign-in */ }
}
function storageClear() {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing to clear */ }
}
/** Older builds kept the token in localStorage, where it outlived the window. */
function purgeLegacyToken() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY); } catch { /* nothing to clear */ }
}

const isJwt = (token: unknown): token is string => typeof token === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

// ---- sign-in bodies ----------------------------------------------------------------------------------------------------------------

/** Checks that a sign-in answer really contains a session before anything stores it (the old screen stored the string "undefined"). */
export function toSignIn(body: any): SignIn {
  const u = body?.user;
  if (!isJwt(body?.token) || !u || typeof u.id !== 'string' || typeof u.name !== 'string' || typeof u.role !== 'string') {
    throw new ApiError(0, 'BAD_RESPONSE', 'The server answered the sign-in without a session token. Try again, and tell an administrator if it keeps happening.');
  }
  const session = body.session && typeof body.session.id === 'string' ? body.session as SessionInfo : null;
  if (!session) throw new ApiError(0, 'BAD_RESPONSE', 'The server answered the sign-in without session details. Try again, and tell an administrator if it keeps happening.');
  return {
    token: body.token,
    user: u as SelfUser,
    mustChangePassword: body.mustChangePassword === true || u.mustChangePassword === true,
    session,
    ...(Array.isArray(body.recoveryCodes) ? { recoveryCodes: body.recoveryCodes.filter((c: unknown): c is string => typeof c === 'string') } : {}),
  };
}

/** Makes `signIn` the current session of this page. */
export function startSession(signIn: SignIn): void {
  if (!isJwt(signIn?.token) || !signIn.user) throw new ApiError(0, 'BAD_RESPONSE', 'The sign-in did not contain a session token.');
  purgeLegacyToken();
  releaseWaiters(false);
  knownTokens = new Set([signIn.token]);
  storageWrite(signIn.token);
  lastContact = Date.now();
  setState({
    status: 'active', token: signIn.token, viewToken: signIn.token, user: signIn.user, session: signIn.session,
    mustChangePassword: signIn.mustChangePassword, lockReason: null, endedCode: null, notice: null,
  });
}

/** Leaves the session on this page (after the server has been told, or when it is already over). */
export function endSession(notice: string | null = null): void {
  storageClear();
  knownTokens = new Set();
  releaseWaiters(false);
  setState({ ...SIGNED_OUT, notice });
}

/** The server's text for these two is "Unauthorized: Invalid token." which tells a user nothing. */
const ENDED_NOTICE: Record<string, string> = {
  INVALID_TOKEN: 'Your session is no longer valid. Sign in again.',
  UNAUTHORIZED: 'Your session is no longer valid. Sign in again.',
};

/** The session is over on the server. */
function expire(code: string, message: string) {
  if (state.status === 'expired' || state.status === 'signed-out') return;
  storageClear();
  const hadUser = state.user !== null;
  const notice = ENDED_NOTICE[code] ?? (message || 'Your session has ended. Sign in again.');
  // Before the first /auth/me has answered there is no application to keep on screen: go straight to the sign-in screen.
  setState(hadUser
    ? { status: 'expired', token: null, lockReason: null, endedCode: code, notice }
    : { ...SIGNED_OUT, endedCode: code, notice });
  releaseWaiters(false);
  emit('session:expired', { code, message: notice });
}

/** The screen is locked (idle timer or the server said SESSION_IDLE). Requests wait until it is unlocked. */
export function lockSession(reason: 'idle' | 'server' = 'idle'): void {
  if (state.status !== 'active' && state.status !== 'booting') return;
  setState({ status: 'locked', lockReason: reason });
  emit('session:locked', { reason });
}

// ---- waiting for an unlock ---------------------------------------------------------------------------------------------------------

let waiters: Array<(unlocked: boolean) => void> = [];
/** Counts unlocks. A request that was on its way when the screen was unlocked may still come back "idle": that answer is stale. */
let unlocks = 0;
function releaseWaiters(unlocked: boolean) {
  const w = waiters;
  waiters = [];
  for (const f of w) f(unlocked);
}
function waitForUnlock(): Promise<boolean> {
  if (state.status === 'locked') return new Promise(resolve => { waiters.push(resolve); });
  return Promise.resolve(state.status === 'active' || state.status === 'booting');
}

function renew(signIn: SignIn) {
  unlocks++;
  knownTokens.add(signIn.token);
  storageWrite(signIn.token);
  lastContact = Date.now();
  setState({
    status: 'active', token: signIn.token, user: signIn.user, session: signIn.session,
    mustChangePassword: signIn.mustChangePassword, lockReason: null, endedCode: null, notice: null,
    viewToken: state.viewToken ?? signIn.token,
  });
  emit('session:renewed', { sessionId: signIn.session.id });
  releaseWaiters(true);
}

// ---- transport --------------------------------------------------------------------------------------------------------------------

/** Set while installSessionFetch is active: the browser's own fetch, so that this layer never calls itself. */
let nativeFetch: typeof fetch | null = null;
const send = (input: string, init: RequestInit) => (nativeFetch ?? globalThis.fetch).call(globalThis, input, init);

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

async function transport(input: string, init: RequestInit): Promise<Response> {
  try {
    return await send(input, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'The server cannot be reached. Check that the application is running, then try again.');
  }
}

async function readError(res: Response): Promise<ApiError> {
  let body: any = null;
  try { body = JSON.parse(await res.text()); } catch { /* not JSON: a proxy or crash page */ }
  const headerRetry = Number(res.headers.get('retry-after'));
  const retry = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined;
  const message = typeof body?.error === 'string' && body.error ? body.error : `The server could not complete the request (HTTP ${res.status}).`;
  return new ApiError(res.status, typeof body?.code === 'string' ? body.code : `HTTP_${res.status}`, message, {
    details: body?.details,
    requestId: typeof body?.requestId === 'string' ? body.requestId : res.headers.get('x-request-id') ?? undefined,
    retryAfterSeconds: retry,
  });
}

/** A body the server's JSON error shape describes, for an answer this layer has to make up itself. */
const synthetic = (status: number, code: string, error: string) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });

const endedAnswer = () => synthetic(401, state.endedCode ?? 'SESSION_ENDED', state.notice ?? 'Your session has ended. Sign in again.');

const SESSION_ENDED_CODES = new Set(['SESSION_EXPIRED', 'SESSION_REVOKED', 'INVALID_TOKEN', 'USER_INACTIVE', 'UNAUTHORIZED']);

/** Keys whose presence means "this request is a credential check or a signature": it is never sent twice on the user's behalf. */
const CREDENTIAL_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'totpCode', 'recoveryCode', 'meaningCode', 'signature']);
function carriesCredentials(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => carriesCredentials(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => CREDENTIAL_KEYS.has(k) || carriesCredentials(v, depth + 1));
}
function isRepeatable(method: string, body: unknown): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') {
    try { return !carriesCredentials(JSON.parse(body)); } catch { return false; }
  }
  if (typeof body === 'object' && !isRawBody(body)) return !carriesCredentials(body);
  return false; // FormData, Blob and streams are not inspected, so they are not repeated
}
function isRawBody(body: unknown): boolean {
  return typeof body === 'string'
    || (typeof FormData !== 'undefined' && body instanceof FormData)
    || (typeof Blob !== 'undefined' && body instanceof Blob)
    || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
    || body instanceof ArrayBuffer;
}

/** The session-aware request: waits while locked, attaches the current token, and acts on a 401 or 403 that concerns the session. */
async function guardedFetch(input: string, init: RequestInit, repeatable: boolean): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (state.status === 'locked' && !(await waitForUnlock())) return endedAnswer();
    if (state.status !== 'active' && state.status !== 'booting') return endedAnswer();

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${state.token}`);
    const unlocksAtSend = unlocks;
    const res = await transport(input, { ...init, headers });

    if (res.status !== 401 && res.status !== 403) { lastContact = Date.now(); return res; }
    let body: any = null;
    try { body = await res.clone().json(); } catch { /* an answer without a JSON body says nothing about the session */ }
    const code: string | undefined = typeof body?.code === 'string' ? body.code : undefined;

    if (res.status === 401 && code === 'SESSION_IDLE') {
      // Locking again for an answer that predates the last unlock would lock a session the user has just re-authenticated.
      if (unlocks === unlocksAtSend) {
        lockSession('server');
        if (!(await waitForUnlock())) return endedAnswer();
      }
      if (!repeatable) {
        return synthetic(401, 'RESUBMIT_REQUIRED', 'Your session was locked and is unlocked again. The action was not carried out: check the form and submit it again.');
      }
      if (attempt >= 1) return res;
      continue;
    }
    if (res.status === 401 && code && SESSION_ENDED_CODES.has(code)) {
      expire(code, typeof body?.error === 'string' ? body.error : '');
      return res;
    }
    if (res.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
      if (!state.mustChangePassword) setState({ mustChangePassword: true });
      emit('session:password-change-required', { message: typeof body?.error === 'string' ? body.error : '' });
      return res;
    }
    lastContact = Date.now();
    return res;
  }
}

// ---- apiFetch ------------------------------------------------------------------------------------------------------------------------

export interface ApiOptions {
  method?: string;
  /** JSON-encoded, unless it is a string, FormData, Blob, URLSearchParams or ArrayBuffer (then it is sent as it is). */
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** How to read a successful answer: 'json' (default), 'text' or 'blob'. */
  parse?: 'json' | 'text' | 'blob';
  /** 'never': if the call is refused because the session was idle, do not repeat it after the unlock; reject with RESUBMIT_REQUIRED. */
  replay?: 'auto' | 'never';
  /** false: no token and no session handling (the sign-in calls). */
  auth?: boolean;
  /** false: the token is sent, but the call does not wait for an unlock and a 401 does not end the session (logout, re-authentication). */
  guard?: boolean;
}

const apiUrl = (path: string) => path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;

export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const url = apiUrl(path);
  const hasBody = options.body !== undefined;
  const method = (options.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;
  if (hasBody) {
    if (isRawBody(options.body)) body = options.body as BodyInit;
    else { body = JSON.stringify(options.body); if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json'); }
  }
  const init: RequestInit = { method, headers, body, signal: options.signal };

  let res: Response;
  if (options.auth === false) {
    res = await transport(url, init);
  } else if (options.guard === false) {
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    res = await transport(url, init);
  } else {
    res = await guardedFetch(url, init, options.replay !== 'never' && isRepeatable(method, options.body));
  }

  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  const parse = options.parse ?? 'json';
  if (parse === 'blob') return await res.blob() as T;
  const text = await res.text();
  if (parse === 'text') return text as T;
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'The server sent an answer the application cannot read.', { requestId: res.headers.get('x-request-id') ?? undefined });
  }
}

// ---- unlock, boot, refresh ----------------------------------------------------------------------------------------------------------

/**
 * Unlocks a locked screen. The same session continues (same id, absolute limit not extended) and the token in the store changes.
 * Throws the server's ApiError for a wrong password (INVALID_CREDENTIALS), a missing code (MFA_CODE_REQUIRED), a wrong or reused code
 * (INVALID_CODE) and a locked account (ACCOUNT_LOCKED); the screen stays locked. If the session turns out to be over, it ends.
 */
export async function reauth(credentials: { password: string; code?: string; recoveryCode?: string }): Promise<void> {
  try {
    const body = await apiFetch('/auth/reauth', { method: 'POST', body: credentials, guard: false });
    renew(toSignIn(body));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && SESSION_ENDED_CODES.has(e.code)) expire(e.code, e.message);
    throw e;
  }
}

/** Reads who is signed in from the server. Also restarts the server's idle clock, so it is called for activity, not on a timer. */
export async function refreshMe(): Promise<SelfUser> {
  const me = await apiFetch<{ user: SelfUser; mustChangePassword: boolean; session: SessionInfo }>('/auth/me');
  setState({ user: keepIfSame(state.user, me.user), session: keepIfSame(state.session, me.session), mustChangePassword: me.mustChangePassword === true });
  return state.user ?? me.user;
}

let booting: Promise<void> | null = null;

/**
 * Page load: take the token this window kept, and ask the server who it belongs to. The answer decides: signed in, locked (the server's
 * idle limit passed while the page was closed), or back to the sign-in screen with a notice. Safe to call twice (React strict mode).
 */
export function bootSession(): Promise<void> {
  booting ??= (async () => {
    purgeLegacyToken();
    const stored = storageRead();
    if (!stored) return;
    if (!isJwt(stored)) { storageClear(); return; }
    knownTokens = new Set([stored]);
    setState({ status: 'booting', token: stored, viewToken: stored });
    const me = apiFetch<{ user: SelfUser; mustChangePassword: boolean; session: SessionInfo }>('/auth/me').then(r => {
      lastContact = Date.now();
      setState({ status: 'active', user: r.user, session: r.session, mustChangePassword: r.mustChangePassword === true });
    });
    const locked = new Promise<void>(resolve => {
      const stop = sessionStore.subscribe(() => { if (state.status === 'locked') { stop(); resolve(); } });
      void me.then(stop, stop);
    });
    await Promise.race([me.catch(() => undefined), locked]);
    if (state.status === 'booting') {
      // An error that was not about the session (the server is down, a 5xx): do not pretend to be signed in.
      endSession('The server could not be reached to check your session. Sign in again when it is available.');
    }
  })().finally(() => { booting = null; });
  return booting;
}

// ---- the calls the sign-in screens and the shell make ------------------------------------------------------------------------------

export const authApi = {
  /** Password step. The three answers the server can give are three different kinds. */
  async login(email: string, password: string): Promise<LoginStep> {
    const body = await apiFetch<any>('/auth/login-local', { method: 'POST', body: { email, password }, auth: false });
    if (body?.requiresTotp === true) {
      if (typeof body.tempToken !== 'string') throw new ApiError(0, 'BAD_RESPONSE', 'The server asked for an authenticator code but did not start the second step.');
      return { kind: 'totp', tempToken: body.tempToken };
    }
    if (body?.requireTotpSetup === true) {
      if (typeof body.tempToken !== 'string' || typeof body.qrCode !== 'string' || typeof body.secret !== 'string') {
        throw new ApiError(0, 'BAD_RESPONSE', 'The server asked for authenticator enrolment but did not send the enrolment data.');
      }
      return { kind: 'totp-setup', tempToken: body.tempToken, qrCode: body.qrCode, secret: body.secret, otpauthUri: typeof body.otpauthUri === 'string' ? body.otpauthUri : undefined };
    }
    return { kind: 'session', signIn: toSignIn(body) };
  },

  async verifyTotp(input: { tempToken: string; code?: string; recoveryCode?: string }): Promise<SignIn> {
    return toSignIn(await apiFetch('/auth/totp-verify', { method: 'POST', body: input, auth: false }));
  },

  /** Finishes a forced enrolment with the first code; the answer carries the recovery codes (shown once). */
  async setupTotp(input: { tempToken: string; code: string }): Promise<SignIn> {
    return toSignIn(await apiFetch('/auth/totp-setup', { method: 'POST', body: input, auth: false }));
  },

  /** Ends the session on the server. A session that is already over counts as ended. */
  async logout(): Promise<void> {
    try {
      await apiFetch('/auth/logout', { method: 'POST', guard: false });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      throw e;
    }
  },

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    await apiFetch('/auth/change-password', { method: 'POST', body: input });
  },
};

/**
 * Ends the session on the server, then on this page. Returns the error when the server could not be told (the page is signed out either
 * way: staying signed in on a screen someone chose to leave is worse), so the caller can say so.
 */
export async function signOut(): Promise<ApiError | null> {
  let failure: ApiError | null = null;
  try { await authApi.logout(); } catch (e) { failure = e instanceof ApiError ? e : new ApiError(0, 'NETWORK_ERROR', errorMessage(e)); }
  endSession();
  return failure;
}

// ---- the bridge for fetch() calls that have not moved to apiFetch yet --------------------------------------------------------------------

/** Public sign-in routes and the two that must work while the session is locked or ending: a 401 from these is not about the session. */
const UNGUARDED = new Set(['/api/auth/login-local', '/api/auth/totp-verify', '/api/auth/totp-setup', '/api/auth/reauth', '/api/auth/logout']);

function bearerOf(headers: Headers): string | null {
  const v = headers.get('authorization');
  return v && v.startsWith('Bearer ') ? v.slice(7) : null;
}

let uninstallBridge: (() => void) | null = null;

/**
 * Replaces window.fetch so that an existing `fetch('/api/...', { headers: { Authorization: 'Bearer ' + token } })` behaves like apiFetch where
 * it matters: it waits while the screen is locked, a SESSION_IDLE is turned into an unlock and a repeat, a token the server no longer
 * accepts ends the session instead of crashing the view, and the current token is sent however old the one in the view's props is.
 * What the caller receives is still a Response (the original 401 for a dead session), so the view's own error handling keeps working.
 * Only same-origin /api requests that carry this session's own token are touched. Returns the function that undoes it.
 */
export function installSessionFetch(): () => void {
  if (uninstallBridge || typeof globalThis.fetch !== 'function') return () => {};
  const original = globalThis.fetch;
  nativeFetch = original;

  const patched = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Only a URL given as a string or URL is handled; a Request object carries a body stream that cannot be inspected or repeated.
    if (typeof input !== 'string' && !(input instanceof URL)) return original.call(globalThis, input, init);
    let target: URL;
    try {
      target = new URL(String(input), typeof location !== 'undefined' ? location.href : 'http://localhost');
    } catch {
      return original.call(globalThis, input, init);
    }
    if (typeof location !== 'undefined' && target.origin !== location.origin) return original.call(globalThis, input, init);
    if (!target.pathname.startsWith('/api/') || UNGUARDED.has(target.pathname)) return original.call(globalThis, input, init);

    const headers = new Headers(init?.headers);
    const bearer = bearerOf(headers);
    if (!bearer || !knownTokens.has(bearer)) return original.call(globalThis, input, init); // not this session's call: not ours to handle

    const method = (init?.method ?? 'GET').toUpperCase();
    return guardedFetch(target.pathname + target.search, { ...init, method, headers }, isRepeatable(method, init?.body));
  };

  globalThis.fetch = patched as typeof fetch;
  uninstallBridge = () => {
    if (globalThis.fetch === patched) globalThis.fetch = original;
    nativeFetch = null;
    uninstallBridge = null;
  };
  return uninstallBridge;
}
