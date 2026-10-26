import type { RequestHandler } from 'express';
import type { db as appDb } from '../../db/index';

export type Db = typeof appDb;

/** The part of the Socket.IO server that route code may use. */
export interface IoLike {
  emit(event: string, payload?: unknown): unknown;
}

/** What every route module receives: `export const xRoutes = ({ db, requireAuth }: RouteContext) => { ... return router; }` */
export interface RouteContext {
  db: Db;
  requireAuth: RequestHandler;
}
