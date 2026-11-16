import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { Pool } from './db.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The context a handler receives. `actor` is set by the authorizer from the session, never from the request body. */
export type Ctx<I> = { input: I; params: Record<string, string>; query: Record<string, unknown>; pool: Pool; actor: Actor | null; req: Request; res: Response };
export type Actor = { userId: string; username: string; permissions: ReadonlySet<string> };

/**
 * One route. `permission` is required: the name of the permission the caller needs, or 'public'. A route file under
 * server/routes/ exports `routes: RouteDef[]`; the registry finds it without any shared list being edited.
 */
export type RouteDef<S extends z.ZodType = z.ZodType> = {
  method: Method;
  path: string;
  permission: string;
  summary: string;
  input?: S;
  status?: number;
  handler: (ctx: Ctx<z.infer<S>>) => Promise<unknown> | unknown;
};

/** Typed helper: the handler's `input` is the parsed type of the schema. */
export const route = <S extends z.ZodType>(def: RouteDef<S>): RouteDef<S> => def;

/**
 * Decides whether a request may run a route. Until an authorizer is installed (r1-identity), every route that is not
 * public is refused with 401: the system fails closed.
 */
export type Authorizer = (req: Request, permission: string) => Promise<Actor | null>;
