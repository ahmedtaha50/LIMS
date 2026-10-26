/**
 * Wave gate W2 (identity + audit): the audit entry written by a request names the session that made it.
 * r1-identity's requireAuth calls setAuditSessionId() and r1-audit's writeAudit() reads currentSessionId(), but the two only meet
 * when the real application opens an audit context for every API request (auditContext in src/server/audit/context.ts, mounted in
 * src/server/app.ts after express.json()). Each track's own tests build their own app or call the pieces directly, so only a test
 * through createApp() can tell whether the wiring exists. Real Express app, real PostgreSQL.
 */
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  await t.token('analyst1@gxp.com');
  await t.token('analyst2@gxp.com');
});

/** A material with an Active specification, which a sample needs. */
async function material() { const m = uniq('Wiring-Material'); await insertActiveSpec(t, m); return m; }
const sessionOf = (token: string) => (jwt.decode(token) as { sid: string }).sid;

describe('the audit entry of a request carries the session id of that request', () => {
  it('a sample created by a signed-in analyst is audited with that analyst\'s session', async () => {
    const token = await t.token('analyst1@gxp.com');
    const headers = { Authorization: `Bearer ${token}` };
    const res = await t.request.post('/api/samples').set(headers).send({ material: await material(), batch: uniq('B') });
    expect(res.status).toBe(200);

    const { rows } = await t.db.pool.query(
      `SELECT session_id, actor_name, actor_role, user_id FROM audit_trail WHERE entity = 'Sample' AND entity_id = $1 ORDER BY sequence`, [res.body.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.user_id).toBe('usr-analyst1');
      expect(r.actor_role).toBe('Analyst');
      expect(r.session_id).toBe(sessionOf(token));
    }
  });

  it('two users working at the same time never get each other\'s session on their entries', async () => {
    const a = await t.token('analyst1@gxp.com');
    const b = await t.token('analyst2@gxp.com');
    expect(sessionOf(a)).not.toBe(sessionOf(b));
    const [ra, rb] = await Promise.all([
      t.request.post('/api/samples').set({ Authorization: `Bearer ${a}` }).send({ material: await material(), batch: uniq('B') }),
      t.request.post('/api/samples').set({ Authorization: `Bearer ${b}` }).send({ material: await material(), batch: uniq('B') }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const session = async (id: string) => (await t.db.pool.query(`SELECT DISTINCT session_id FROM audit_trail WHERE entity = 'Sample' AND entity_id = $1`, [id])).rows.map(r => r.session_id);
    expect(await session(ra.body.id)).toEqual([sessionOf(a)]);
    expect(await session(rb.body.id)).toEqual([sessionOf(b)]);
  });

  it('the chain, seal included, still verifies over entries that carry a session id', async () => {
    const admin = await t.auth('admin@gxp.com');
    const res = await t.request.post('/api/audit/verify').set(admin).send({});
    expect(res.status).toBe(200);
    expect(res.body.isValid).toBe(true);
  });
});
