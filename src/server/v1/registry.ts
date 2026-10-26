/**
 * The route registry of /api/v1 (roadmap M22): the ONE place an operation of the machine API is declared.
 *
 *   defineRoute({ method, path, operationId, summary, scope, params?, query?, body?, idempotent?, responses, handler })
 *
 * declares the scope the operation needs (or `public: true` for the contract itself), the strict Zod schemas of its path parameters,
 * query and body, and the Zod schemas of its answers. The same declaration
 *   - is what the dispatcher (./index.ts) runs: no scope, no call; input that does not match, 400 before the handler;
 *   - is what the OpenAPI document (./openapi.ts) is generated from, so the published contract cannot drift from the code.
 * This registry is the deny-by-default table of /api/v1, as src/server/authz/routeTable.ts is for the session API: an operation
 * exists only through defineRoute, and defineRoute refuses an operation without a scope, a duplicate, or a path parameter without a schema.
 *
 * Paths are written as in OpenAPI: `{name}` is a parameter, everything else is literal, so Google-style custom methods such as
 * `/results:batch` need no escaping.
 */
import type { Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import type { ApiClientRow } from '../auth/principals/apiToken';
import type { UserRow } from '../auth/sessions';
import type { Db, IoLike } from '../core/context';
import { isApiScope, type ApiScope } from './scopes';

export interface V1Context<P = any, Q = any, B = any> {
  db: Db;
  io?: IoLike;
  req: Request;
  res: Response;
  client: ApiClientRow;
  user: UserRow;
  params: P;
  query: Q;
  body: B;
  /** The Idempotency-Key header of an idempotent operation (required there). */
  idempotencyKey: string;
}

export interface V1Answer { status: number; body?: unknown; text?: string; headers?: Record<string, string> }

export interface V1Response { description: string; schema: ZodType }

interface Common {
  method: 'GET' | 'POST';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  params?: z.ZodObject<any>;
  query?: z.ZodObject<any>;
  body?: ZodType;
  /** A write that needs an Idempotency-Key header and replays its stored answer for a repeated key. */
  idempotent?: boolean;
  /** Success answers by status. Error answers are problem+json and documented from `errors`. */
  responses: Record<number, V1Response>;
  /** The problem statuses this operation can answer beyond 401/403/429/500 (always documented for protected operations). */
  errors?: number[];
}

export type V1Route =
  | (Common & { public: true; scope?: undefined; handler: (ctx: Omit<V1Context, 'client' | 'user'>) => Promise<V1Answer> })
  | (Common & { public?: false; scope: ApiScope; handler: (ctx: V1Context) => Promise<V1Answer> });

export interface CompiledRoute { route: V1Route; regex: RegExp; paramNames: string[] }

const routes: CompiledRoute[] = [];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  if (!path.startsWith('/')) throw new Error(`defineRoute: path "${path}" must start with "/".`);
  const paramNames: string[] = [];
  let source = '';
  for (const part of path.split(/(\{[A-Za-z][A-Za-z0-9]*\})/)) {
    const m = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(part);
    if (m) { paramNames.push(m[1]); source += '([^/]+)'; } else {
      if (/[{}]/.test(part)) throw new Error(`defineRoute: path "${path}" has a malformed parameter.`);
      source += escapeRegex(part);
    }
  }
  return { regex: new RegExp(`^${source}$`), paramNames };
}

export function defineRoute(route: V1Route): V1Route {
  const where = `${route.method} ${route.path}`;
  if (!route.public && !isApiScope(route.scope)) throw new Error(`defineRoute: ${where} must name a scope of src/server/v1/scopes.ts.`);
  if (routes.some(r => r.route.method === route.method && r.route.path === route.path)) throw new Error(`defineRoute: ${where} is defined twice.`);
  if (routes.some(r => r.route.operationId === route.operationId)) throw new Error(`defineRoute: operationId ${route.operationId} is used twice.`);
  if (!/^[a-z][A-Za-z0-9]+$/.test(route.operationId)) throw new Error(`defineRoute: operationId "${route.operationId}" must be camelCase.`);
  const { regex, paramNames } = compilePath(route.path);
  const declared = Object.keys(route.params?.shape ?? {});
  if (declared.sort().join() !== [...paramNames].sort().join()) throw new Error(`defineRoute: ${where} declares path parameters [${declared}] but the path has [${paramNames}].`);
  if (route.method === 'POST' && !route.body) throw new Error(`defineRoute: ${where} is a write and needs a body schema.`);
  if (route.method === 'POST' && !route.public && !route.idempotent) throw new Error(`defineRoute: ${where} is a write and must be idempotent (Idempotency-Key).`);
  if (Object.keys(route.responses).length === 0) throw new Error(`defineRoute: ${where} documents no answer.`);
  routes.push({ route, regex, paramNames });
  return route;
}

export const v1Routes = (): readonly CompiledRoute[] => routes;
