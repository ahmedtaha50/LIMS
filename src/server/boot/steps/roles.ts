/**
 * Boot step: the least-privilege role lims_app (roadmap M35; src/db/roles.ts says what it may do). r2-audit-tamper owns this file.
 * Runs as the database owner after the protections, at every start (src/server/boot/index.ts), because re-applying the protections
 * re-creates the guard triggers in their default mode and a migration may have added tables.
 *
 *   LIMS_APP_ROLE          auto (default): install the role; when the owner may not create roles (42501), say so in the log and go on.
 *                          required: the same, but a missing privilege stops the start.  off: skip, and say so.
 *   LIMS_APP_DB_PASSWORD   when set, the role may log in with it (the application's pool then connects as lims_app, see
 *                          docs/changes/r2-audit-tamper.md). Unset: the role keeps whatever login it has.
 */
import { APP_ROLE, applyAppRole, type AppRoleReport } from '../../../db/roles';

interface Conn { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }

export interface AppRoleStepOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export async function appRoleStep(conn: Conn, o: AppRoleStepOptions = {}): Promise<AppRoleReport | null> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((m: string) => console.log(m));
  const mode = (env.LIMS_APP_ROLE || 'auto').toLowerCase();
  if (!['auto', 'required', 'off'].includes(mode)) throw new Error(`LIMS_APP_ROLE must be auto, required or off (it is "${env.LIMS_APP_ROLE}").`);
  if (mode === 'off') {
    log(`Database role ${APP_ROLE}: skipped (LIMS_APP_ROLE=off). The application keeps the owner's rights over the audit trail.`);
    return null;
  }
  try {
    const report = await applyAppRole(conn, { password: env.LIMS_APP_DB_PASSWORD || null });
    log(`Database role ${APP_ROLE}: ${report.created ? 'created' : 'checked'}; ${report.insertOnly.length} append-only tables are insert and read only` +
      `${report.triggersAlways ? `, ${report.triggersAlways} guard triggers set to fire always` : ''}${report.login ? '' : '; it has no login yet (LIMS_APP_DB_PASSWORD)'}.`);
    return report;
  } catch (err: any) {
    if (err?.code === '42501' && mode === 'auto') {
      log(`WARNING Database role ${APP_ROLE}: not installed, the database user may not create roles or grant on these tables (${err.message}). ` +
        'The application keeps the owner\'s rights over the audit trail. Set LIMS_APP_ROLE=required to make this stop the start.');
      return null;
    }
    throw err;
  }
}
