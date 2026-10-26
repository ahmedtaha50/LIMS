/**
 * Request context for the audit writer: which session an action was done in. writeAudit(tx, userId, ...) has no request,
 * and its ~35 callers should not each have to pass one, so the session id travels in AsyncLocalStorage.
 *
 * Wiring (the owners of the files below do it; nothing breaks while it is missing, the session id is simply null):
 *   src/server/app.ts          app.use('/api', auditContext) AFTER express.json(): a context opened before the body is read is
 *                              lost when the body parser's stream callbacks run.
 *   the authentication step    setAuditSessionId(session.id) once the bearer token has been resolved to a session.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

interface Store { sessionId: string | null }
const storage = new AsyncLocalStorage<Store>();

/** Express middleware: everything the request does afterwards runs inside its own context. */
export const auditContext: RequestHandler = (_req, _res, next) => { storage.run({ sessionId: null }, next); };

/** For jobs and tests: run `fn` in a fresh context. */
export function runWithAuditContext<T>(fn: () => T): T { return storage.run({ sessionId: null }, fn); }

/** Records the session of the current request; a no-op outside a context. */
export function setAuditSessionId(sessionId: string | null | undefined): void {
  const store = storage.getStore();
  if (store) store.sessionId = sessionId ?? null;
}

export function currentSessionId(): string | null { return storage.getStore()?.sessionId ?? null; }
