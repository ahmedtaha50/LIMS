/**
 * Compatibility shim. The 3,000-line router that used to live here is now one module per domain in
 * src/server/routes/ (registered in routes/index.ts) and is assembled by createApp() in app.ts.
 * Only requireAuth remains, because src/server/reports.ts (r1-backup-jobs) still imports it from this path;
 * delete this file when that import moves to core/auth.
 */
import { db } from '../db/index';
import { createRequireAuth } from './core/auth';

export const requireAuth = createRequireAuth(db);
