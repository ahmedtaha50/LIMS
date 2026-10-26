/**
 * The interim token check that lived here (r1-core) is replaced by the purpose-typed, session-backed one of r1-identity,
 * which is where authentication now lives. This file keeps the import path that src/server/app.ts and src/server/api.ts use.
 */
export { createRequireAuth } from '../auth/requireAuth';
