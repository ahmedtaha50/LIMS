import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit, verifyChain, auditOf } from '../../server/audit/index.js';
import { canonical } from '../../server/audit/canonical.js';
import { withTx } from '../../server/core/db.js';
import { migrate } from '../../server/migrate/runner.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeAll(async () => { db = await freshDatabase('audit'); await migrate(db.pool, MIGRATIONS); await db.pool.query('CREATE TABLE things (id text PRIMARY KEY, name text NOT NULL)'); });
afterAll(async () => { await db.drop(); });
const actor = { actorId: 'u1', actorName: 'operator1' };

describe('audit trail (E03)', () => {
  it('E03#1: the change and its entry commit together, and a failure after the change leaves neither', async () => {
    await withTx(db.pool, async (c) => {
      await c.query("INSERT INTO things VALUES ('a', 'first')");
      await writeAudit(c, { ...actor, action: 'thing.created', entity: 'thing', entityId: 'a', newValue: { name: 'first' } });
    });
    await expect(withTx(db.pool, async (c) => {
      await c.query("INSERT INTO things VALUES ('b', 'second')");
      await writeAudit(c, { ...actor, action: 'thing.created', entity: 'thing', entityId: 'b', newValue: { name: 'second' } });
      throw new Error('injected failure after the change');
    })).rejects.toThrow('injected failure');
    expect((await db.pool.query("SELECT id FROM things ORDER BY id")).rows).toEqual([{ id: 'a' }]);
    expect(await auditOf(db.pool, 'thing', 'b')).toEqual([]);
    expect((await auditOf(db.pool, 'thing', 'a')).length).toBe(1);
  });

  it('E03#2: an entry carries user, server time in UTC, old and new value and reason', async () => {
    const before = Date.now();
    await withTx(db.pool, (c) => writeAudit(c, { ...actor, action: 'thing.renamed', entity: 'thing', entityId: 'a', oldValue: { name: 'first' }, newValue: { name: 'better' }, reason: 'typing error', requestId: 'req-1' }));
    const e = (await auditOf(db.pool, 'thing', 'a')).at(-1)!;
    expect(e).toMatchObject({ actorId: 'u1', actorName: 'operator1', oldValue: { name: 'first' }, newValue: { name: 'better' }, reason: 'typing error', requestId: 'req-1' });
    expect(e.at.endsWith('Z')).toBe(true);
    expect(Date.parse(e.at)).toBeGreaterThanOrEqual(before - 5000);
  });

  it('E03#2: the application role cannot update, delete or truncate entries', async () => {
    await expect(db.pool.query("UPDATE audit_log SET actor_name = 'someone else'")).rejects.toThrow(/append-only: UPDATE/);
    await expect(db.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only: DELETE/);
    await expect(db.pool.query('TRUNCATE audit_log')).rejects.toThrow(/append-only: TRUNCATE/);
  });

  it('E03#3: the chain verifies, and altering one stored entry is reported at that entry', async () => {
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true, entries: 2 });
    const target = (await db.pool.query<{ id: string }>('SELECT id FROM audit_log ORDER BY id LIMIT 1')).rows[0]!.id;
    // tampering needs the triggers off: what someone with database access, not the application, could do
    await db.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await db.pool.query("UPDATE audit_log SET new_value = '{\"name\":\"forged\"}' WHERE id = $1", [target]);
    await db.pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    expect(await verifyChain(db.pool)).toMatchObject({ ok: false, brokenAt: target, why: expect.stringMatching(/content of this entry was changed/) });
  });

  it('E03#3: a removed entry breaks the link of the next one', async () => {
    const d = await freshDatabase('audit2');
    try {
      await migrate(d.pool, MIGRATIONS);
      for (const id of ['1', '2', '3']) await withTx(d.pool, (c) => writeAudit(c, { ...actor, action: 'x', entity: 'thing', entityId: id }));
      await d.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      const ids = (await d.pool.query<{ id: string }>('SELECT id FROM audit_log ORDER BY id')).rows.map(r => r.id);
      await d.pool.query('DELETE FROM audit_log WHERE id = $1', [ids[1]]);
      expect(await verifyChain(d.pool)).toMatchObject({ ok: false, brokenAt: ids[2], why: expect.stringMatching(/removed or inserted/) });
    } finally { await d.drop(); }
  });

  it('concurrent writers keep one unbroken chain', async () => {
    const d = await freshDatabase('audit3');
    try {
      await migrate(d.pool, MIGRATIONS);
      await Promise.all(Array.from({ length: 20 }, (_, i) => withTx(d.pool, (c) => writeAudit(c, { ...actor, action: 'x', entity: 'thing', entityId: String(i) }))));
      expect(await verifyChain(d.pool)).toEqual({ ok: true, entries: 20 });
    } finally { await d.drop(); }
  });

  it('canonical form does not depend on key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonical({ a: Number.NaN })).toThrow(/not finite/);
  });
});
