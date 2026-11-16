import { writeAudit } from '../audit/index.js';
import { directoryConfig, directoryPasswordOk } from '../directory/index.js';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import type { PasswordCheck } from '../esign/index.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

/**
 * The first administrator of a new installation (r3-deploy), created only while there is no account at all, under an
 * advisory lock so that two instances starting together create one. Returns whether it was created.
 */
export async function bootstrapAdmin(pool: Pool, username: string, password: string): Promise<boolean> {
  const problem = passwordProblem(password, username);
  if (problem) throw new Error(`EBR_BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
  const hash = await hashPassword(password);
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4100099)');
    if ((await c.query('SELECT 1 FROM users LIMIT 1')).rowCount) return false;
    const r = await c.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1, $1, $2, '{admin}') RETURNING id", [username, hash]);
    await writeAudit(c, { actorId: null, actorName: 'installation', action: 'user.created', entity: 'user', entityId: r.rows[0]!.id, newValue: { username, roles: ['admin'] }, reason: 'first administrator of a new installation' });
    return true;
  });
}

export { authorizer, sessionOf } from './sessions.js';
export { ROLES, permissionMatrix } from './roles.js';

/** The password check that e-signatures use (E04#1): the signer's own, current password, for an active account. */
export const passwordCheck = (pool: Pool): PasswordCheck => async (userId, password) => {
  const r = await pool.query<{ password_hash: string; username: string; auth_source: string }>("SELECT password_hash, username, auth_source FROM users WHERE id = $1 AND status = 'active'", [userId]);
  const u = r.rows[0];
  if (!u) return false;
  if (u.auth_source === 'directory') { const cfg = directoryConfig(); return cfg ? directoryPasswordOk(cfg, u.username, password) : false; }   // r3-directory
  return verifyPassword(password, u.password_hash);
};
