import type { Pool } from '../core/db.js';
import type { PasswordCheck } from '../esign/index.js';
import { verifyPassword } from './password.js';

export { authorizer, sessionOf } from './sessions.js';
export { ROLES, permissionMatrix } from './roles.js';

/** The password check that e-signatures use (E04#1): the signer's own, current password, for an active account. */
export const passwordCheck = (pool: Pool): PasswordCheck => async (userId, password) => {
  const r = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1 AND status = 'active'", [userId]);
  return r.rows[0] ? verifyPassword(password, r.rows[0].password_hash) : false;
};
