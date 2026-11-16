// First administrator of a new installation:  EBR_ADMIN_PASSWORD='...' npm run create-admin -- <username> "<display name>"
// The password comes from the environment, never from the command line (it would stay in the shell history).
import { writeAudit } from '../audit/index.js';
import { loadConfig } from '../core/config.js';
import { createPool, withTx } from '../core/db.js';
import { hashPassword, passwordProblem } from './password.js';

const [username, displayName = username] = process.argv.slice(2);
const password = process.env.EBR_ADMIN_PASSWORD ?? '';
if (!username) { console.error('usage: EBR_ADMIN_PASSWORD=... npm run create-admin -- <username> "<display name>"'); process.exit(2); }
const problem = passwordProblem(password, username);
if (problem) { console.error(problem); process.exit(2); }
const pool = createPool(loadConfig().DATABASE_URL, 2);
try {
  const h = await hashPassword(password);
  const id = await withTx(pool, async (c) => {
    const r = await c.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1, $2, $3, '{admin}') RETURNING id", [username, displayName, h]);
    await writeAudit(c, { actorId: null, actorName: 'installation', action: 'user.created', entity: 'user', entityId: r.rows[0]!.id, newValue: { username, displayName, roles: ['admin'] }, reason: 'first administrator' });
    return r.rows[0]!.id;
  });
  console.log(`administrator ${username} created (${id}); the password must be changed at the first sign-in, and the authenticator set up.`);
} finally { await pool.end(); }
