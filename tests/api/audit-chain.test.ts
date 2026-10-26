/**
 * Audit trail v2, hash chain (roadmap M08). One shared verifier for every kind of row:
 *   v1  rows written before this release: link hash only.
 *   v2  rows written now: the same link hash (so every older verifier still accepts them) plus a `seal` that covers the
 *       actor snapshot (name, role, session, app version) and is chained to the previous seal.
 * The v1 formula below is restated here on purpose: it is the one the code at tag pre-r1 used, and an implementation that
 * drifts from it would silently stop verifying the rows already on installed PCs.
 */
import { createHash, createHmac } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

interface Row {
  id: string; sequence: number; userId: string; action: string; entity: string; entityId: string; field: string;
  oldValue: string; newValue: string; reason: string; hash: string; prevHash: string; timestampStr: string;
  actorName: string | null; actorRole: string | null; sessionId: string | null; appVersion: string | null;
  hashVersion: number; hashAlg: string; seal: string | null;
}

const linkOf = (r: Pick<Row, 'sequence' | 'timestampStr' | 'userId' | 'action' | 'entity' | 'entityId' | 'field' | 'oldValue' | 'newValue' | 'reason'>, prev: string) =>
  sha(JSON.stringify({ sequence: r.sequence, timestamp: r.timestampStr, userId: r.userId, action: r.action, entity: r.entity, entityId: r.entityId, field: r.field, oldValue: r.oldValue, newValue: r.newValue, reason: r.reason }) + prev);

const sealOf = (r: Row, prevSeal: string) =>
  sha(JSON.stringify({ v: 2, sequence: r.sequence, timestamp: r.timestampStr, userId: r.userId, actorName: r.actorName, actorRole: r.actorRole, sessionId: r.sessionId, appVersion: r.appVersion, action: r.action, entity: r.entity, entityId: r.entityId, field: r.field, oldValue: r.oldValue, newValue: r.newValue, reason: r.reason, hash: r.hash }) + prevSeal);

interface Tail { sequence: number; hash: string; seal: string | null }

/** n consecutive rows continuing `tail`; `versions` picks v1 or v2 per row index. */
function chain(n: number, tail: Tail, versionOf: (i: number) => 1 | 2 = () => 2, tag = 'T'): Row[] {
  const out: Row[] = [];
  let prev: Tail = tail;
  for (let i = 0; i < n; i++) {
    const sequence = prev.sequence + 1;
    const base = {
      sequence, userId: 'usr-qa', action: i % 3 ? 'Update' : 'Create', entity: 'Sample', entityId: `${tag}-${i % 7}`, field: 'state',
      oldValue: `old ${i}`, newValue: `new ${i}`, reason: `reason ${i}`, timestampStr: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    };
    const hash = linkOf(base, prev.hash);
    const v = versionOf(i);
    const row: Row = {
      id: `adt-${tag}-${sequence}`, ...base, hash, prevHash: prev.hash,
      actorName: v === 2 ? 'Test QA Officer' : null, actorRole: v === 2 ? 'QA' : null, sessionId: null, appVersion: v === 2 ? '0.1.0' : null,
      hashVersion: v, hashAlg: 'sha256', seal: null,
    };
    if (v === 2) row.seal = sealOf(row, prev.seal ?? prev.hash);
    out.push(row);
    prev = { sequence, hash, seal: row.seal };
  }
  return out;
}

const COLS = ['id', 'sequence', 'user_id', 'action', 'entity', 'entity_id', 'field', 'old_value', 'new_value', 'reason', 'hash', 'prev_hash', 'timestamp_str', 'actor_name', 'actor_role', 'session_id', 'app_version', 'hash_version', 'hash_alg', 'seal'];
const TYPES = ['text', 'int', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'int', 'text', 'text'];

async function insertRows(pool: TestDb['pool'], rows: Row[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    const part = rows.slice(i, i + 2000);
    const cols = (r: Row) => [r.id, r.sequence, r.userId, r.action, r.entity, r.entityId, r.field, r.oldValue, r.newValue, r.reason, r.hash, r.prevHash, r.timestampStr, r.actorName, r.actorRole, r.sessionId, r.appVersion, r.hashVersion, r.hashAlg, r.seal];
    const arrays = COLS.map((_, c) => part.map(r => cols(r)[c]));
    await pool.query(
      `INSERT INTO audit_trail (${COLS.join(', ')}, timestamp)
       SELECT t.*, t.timestamp_str::timestamptz FROM unnest(${TYPES.map((t, k) => `$${k + 1}::${t}[]`).join(', ')}) AS t(${COLS.join(', ')})`,
      arrays);
  }
}

async function tail(pool: TestDb['pool']): Promise<Tail> {
  const r = await pool.query('SELECT sequence, hash, seal FROM audit_trail ORDER BY sequence DESC LIMIT 1');
  return r.rows[0] ?? { sequence: 0, hash: GENESIS, seal: null };
}

/** The test database is throwaway and its owner is a superuser: lift the guard triggers for one statement to arrange a tamper. */
async function asOwner(pool: TestDb['pool'], sqlText: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    try { await c.query(sqlText, params); } finally { await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER'); }
  } finally { c.release(); }
}

async function emptyAuditTrail(pool: TestDb['pool']) {
  const c = await pool.connect();
  try {
    await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    await c.query('ALTER TABLE audit_checkpoints DISABLE TRIGGER USER');
    try {
      await c.query('DELETE FROM audit_trail');
      await c.query('DELETE FROM audit_checkpoints');
    } finally {
      await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
      await c.query('ALTER TABLE audit_checkpoints ENABLE TRIGGER USER');
    }
  } finally { c.release(); }
}

const toSnake = (r: Row) => ({
  id: r.id, sequence: r.sequence, user_id: r.userId, action: r.action, entity: r.entity, entity_id: r.entityId, field: r.field,
  old_value: r.oldValue, new_value: r.newValue, reason: r.reason, hash: r.hash, prev_hash: r.prevHash, timestamp_str: r.timestampStr,
  actor_name: r.actorName, actor_role: r.actorRole, session_id: r.sessionId, app_version: r.appVersion, hash_version: r.hashVersion, hash_alg: r.hashAlg, seal: r.seal,
});

let t: TestDb;
let db: any;
let mod: typeof import('../../src/server/audit/chain');

beforeAll(async () => {
  t = await useTestDb();
  ({ db } = await import('../../src/db/index'));
  mod = await import('../../src/server/audit/chain');
});

describe('verifyAuditRows (pure, used for backups and any in-memory list)', () => {
  const v1 = chain(6, { sequence: 0, hash: GENESIS, seal: null }, () => 1);
  const mixed = chain(10, { sequence: 0, hash: GENESIS, seal: null }, i => (i < 4 ? 1 : 2));

  it('accepts a pre-upgrade v1 chain exactly as the old code wrote it', () => {
    expect(mod.verifyAuditRows(v1)).toMatchObject({ isValid: true, compromisedSequence: null });
  });

  it('accepts a chain that starts as v1 and continues as v2, in any order of the input', () => {
    expect(mod.verifyAuditRows(mixed).isValid).toBe(true);
    expect(mod.verifyAuditRows([...mixed].reverse()).isValid).toBe(true);
  });

  it('accepts database-style (snake_case) rows as well as camelCase rows', () => {
    expect(mod.verifyAuditRows(mixed.map(toSnake)).isValid).toBe(true);
  });

  it('a v2 row keeps the v1 link hash, so every older verifier still accepts it', () => {
    for (const r of mixed) expect(r.hash).toBe(linkOf(r, r.prevHash));
  });

  it('names the first row whose content was altered (link)', () => {
    const rows = mixed.map(r => ({ ...r }));
    rows[2].newValue = 'tampered';
    expect(mod.verifyAuditRows(rows)).toMatchObject({ isValid: false, compromisedSequence: rows[2].sequence, reason: 'LINK_BROKEN' });
  });

  it('detects a changed actor name or role on a v2 row, which the link alone does not cover (seal)', () => {
    const rows = mixed.map(r => ({ ...r }));
    rows[6].actorName = 'Somebody Else';
    expect(mod.verifyAuditRows(rows)).toMatchObject({ isValid: false, compromisedSequence: rows[6].sequence, reason: 'SEAL_BROKEN' });
    const rows2 = mixed.map(r => ({ ...r }));
    rows2[7].actorRole = 'Admin';
    expect(mod.verifyAuditRows(rows2)).toMatchObject({ isValid: false, compromisedSequence: rows2[7].sequence, reason: 'SEAL_BROKEN' });
    const rows3 = mixed.map(r => ({ ...r }));
    rows3[8].appVersion = '9.9.9';
    expect(mod.verifyAuditRows(rows3)).toMatchObject({ isValid: false, compromisedSequence: rows3[8].sequence, reason: 'SEAL_BROKEN' });
  });

  it('detects a v2 row that lost its seal, and a removed row', () => {
    const noSeal = mixed.map(r => ({ ...r }));
    noSeal[5].seal = null;
    expect(mod.verifyAuditRows(noSeal)).toMatchObject({ isValid: false, compromisedSequence: noSeal[5].sequence });
    const removed = mixed.filter((_, i) => i !== 3);
    expect(mod.verifyAuditRows(removed)).toMatchObject({ isValid: false, compromisedSequence: mixed[4].sequence, reason: 'LINK_BROKEN' });
  });

  it('refuses a row it cannot verify instead of calling it valid: unknown algorithm or version', () => {
    const alg = mixed.map(r => ({ ...r }));
    alg[1].hashAlg = 'md5';
    expect(mod.verifyAuditRows(alg)).toMatchObject({ isValid: false, compromisedSequence: alg[1].sequence, reason: 'UNSUPPORTED_ALG' });
    const ver = mixed.map(r => ({ ...r }));
    ver[1].hashVersion = 3;
    expect(mod.verifyAuditRows(ver)).toMatchObject({ isValid: false, compromisedSequence: ver[1].sequence, reason: 'UNSUPPORTED_VERSION' });
  });

  it('requires the first row to follow the genesis hash', () => {
    const rows = chain(3, { sequence: 0, hash: 'f'.repeat(64), seal: null }, () => 1);
    expect(mod.verifyAuditRows(rows)).toMatchObject({ isValid: false, compromisedSequence: 1 });
  });
});

describe('verifyAuditChain (database, keyset batches)', () => {
  it('verifies the installer row, a v1 stretch and a v2 stretch in small batches and counts both versions', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(40, await tail(t.pool), i => (i < 15 ? 1 : 2)));
    const r = await mod.verifyAuditChain(db, { batchSize: 7, writeCheckpoints: false });
    expect(r).toMatchObject({ isValid: true, compromisedSequence: null, totalRecords: 40, headSequence: 40, reason: null });
    expect(r.versions).toEqual({ 1: 15, 2: 25 });
  });

  it('reports the first compromised sequence even when it lies in a later batch', async () => {
    await asOwner(t.pool, `UPDATE audit_trail SET new_value = 'edited in SQL' WHERE sequence = 23`);
    const r = await mod.verifyAuditChain(db, { batchSize: 7, writeCheckpoints: false });
    expect(r).toMatchObject({ isValid: false, compromisedSequence: 23, reason: 'LINK_BROKEN' });
  });

  it('reports a rewritten actor snapshot as SEAL_BROKEN', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(30, await tail(t.pool), () => 2));
    await asOwner(t.pool, `UPDATE audit_trail SET actor_name = 'Mallory' WHERE sequence = 12`);
    const r = await mod.verifyAuditChain(db, { batchSize: 8, writeCheckpoints: false });
    expect(r).toMatchObject({ isValid: false, compromisedSequence: 12, reason: 'SEAL_BROKEN' });
  });

  it('an empty audit trail is valid', async () => {
    await emptyAuditTrail(t.pool);
    expect(await mod.verifyAuditChain(db, { writeCheckpoints: false })).toMatchObject({ isValid: true, totalRecords: 0, headSequence: 0 });
  });
});

describe('checkpoints and bounded verification', () => {
  it('a full verification records a checkpoint at every interval it has verified, and a second run adds none', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(34, await tail(t.pool), () => 2));
    const first = await mod.verifyAuditChain(db, { batchSize: 9, checkpointEvery: 10 });
    expect(first).toMatchObject({ isValid: true, checkpointsAdded: 3 });
    const cps = (await t.pool.query('SELECT sequence, hash, seal FROM audit_checkpoints ORDER BY sequence')).rows;
    expect(cps.map(c => c.sequence)).toEqual([10, 20, 30]);
    for (const c of cps) {
      const row = (await t.pool.query('SELECT hash, seal FROM audit_trail WHERE sequence = $1', [c.sequence])).rows[0];
      expect(c).toMatchObject({ hash: row.hash, seal: row.seal });
    }
    expect(await mod.verifyAuditChain(db, { checkpointEvery: 10 })).toMatchObject({ isValid: true, checkpointsAdded: 0 });
  });

  it('only the verified prefix gets checkpoints when the chain breaks', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(34, await tail(t.pool), () => 2));
    await asOwner(t.pool, `UPDATE audit_trail SET reason = 'x' WHERE sequence = 25`);
    const r = await mod.verifyAuditChain(db, { checkpointEvery: 10 });
    expect(r).toMatchObject({ isValid: false, compromisedSequence: 25, checkpointsAdded: 2 });
    expect((await t.pool.query('SELECT sequence FROM audit_checkpoints ORDER BY sequence')).rows.map(c => c.sequence)).toEqual([10, 20]);
  });

  it('a stored checkpoint that disagrees with the chain fails the full verification', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(25, await tail(t.pool), () => 2));
    await t.pool.query(`INSERT INTO audit_checkpoints (sequence, hash, seal) VALUES (10, $1, NULL)`, ['a'.repeat(64)]);
    const r = await mod.verifyAuditChain(db, { checkpointEvery: 10 });
    expect(r).toMatchObject({ isValid: false, compromisedSequence: 10, reason: 'CHECKPOINT_MISMATCH' });
  });

  it('bounded verification starts at the nearest checkpoint below the target and reads only the rows after it', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(60, await tail(t.pool), () => 2));
    await mod.verifyAuditChain(db, { checkpointEvery: 10 });
    const r = await mod.verifyAuditChainTo(db, { sequence: 47 });
    expect(r).toMatchObject({ isValid: true, startedFrom: 'checkpoint', checkpointSequence: 40, rowsChecked: 7, verifiedThrough: 47 });
    const onCheckpoint = await mod.verifyAuditChainTo(db, { sequence: 40 });
    expect(onCheckpoint).toMatchObject({ isValid: true, startedFrom: 'checkpoint', checkpointSequence: 40, rowsChecked: 0 });
  });

  it('bounded verification finds a change after the checkpoint, accepts one before it (that is the full verification\'s job), and takes an entry id', async () => {
    await asOwner(t.pool, `UPDATE audit_trail SET reason = 'edited' WHERE sequence = 44`);
    expect(await mod.verifyAuditChainTo(db, { sequence: 47 })).toMatchObject({ isValid: false, compromisedSequence: 44, reason: 'LINK_BROKEN' });
    expect(await mod.verifyAuditChainTo(db, { sequence: 43 })).toMatchObject({ isValid: true });
    await asOwner(t.pool, `UPDATE audit_trail SET reason = 'edited early' WHERE sequence = 5`);
    expect(await mod.verifyAuditChainTo(db, { sequence: 43 })).toMatchObject({ isValid: true, checkpointSequence: 40 });
    expect(await mod.verifyAuditChain(db, { checkpointEvery: 10, writeCheckpoints: false })).toMatchObject({ isValid: false, compromisedSequence: 5 });
    expect(await mod.verifyAuditChainTo(db, { id: 'adt-T-30' })).toMatchObject({ isValid: true, verifiedThrough: 30 });
  });

  it('without any checkpoint below the target it verifies from the beginning; an unknown target is not valid', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(12, await tail(t.pool), () => 2));
    expect(await mod.verifyAuditChainTo(db, { sequence: 9 })).toMatchObject({ isValid: true, startedFrom: 'genesis', checkpointSequence: null, rowsChecked: 9 });
    expect(await mod.verifyAuditChainTo(db, { sequence: 999 })).toMatchObject({ isValid: false, reason: 'ENTRY_NOT_FOUND' });
    expect(await mod.verifyAuditChainTo(db, { id: 'no-such-entry' })).toMatchObject({ isValid: false, reason: 'ENTRY_NOT_FOUND' });
  });

  it('a checkpoint whose row was altered fails bounded verification', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(30, await tail(t.pool), () => 2));
    await mod.verifyAuditChain(db, { checkpointEvery: 10 });
    await asOwner(t.pool, `UPDATE audit_trail SET hash = $1 WHERE sequence = 20`, ['b'.repeat(64)]);
    expect(await mod.verifyAuditChainTo(db, { sequence: 25 })).toMatchObject({ isValid: false, compromisedSequence: 20, reason: 'CHECKPOINT_MISMATCH' });
  });
});

describe('protections and older schemas', () => {
  it('the registry can be applied to a schema that lacks the newer tables, as when a backup of an older version is restored', async () => {
    const { applyProtections } = await import('../../src/db/protections');
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DROP TABLE audit_checkpoints');
      await c.query('DROP TABLE security_events');
      await expect(applyProtections(c)).resolves.toBeUndefined();
      await c.query('ROLLBACK');
    } finally { c.release(); }
    // ...and the triggers are in place again afterwards.
    const names = (await t.pool.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'gxp\\_%' AND tgrelid::regclass::text IN ('audit_checkpoints', 'security_events') ORDER BY tgname`)).rows.map(r => r.tgname);
    expect(names).toEqual(['gxp_audit_checkpoints_row_guard', 'gxp_audit_checkpoints_truncate_guard', 'gxp_security_events_row_guard', 'gxp_security_events_truncate_guard']);
  });
});

describe('audit_checkpoints is append-only', () => {
  it('refuses UPDATE, DELETE and TRUNCATE', async () => {
    await t.pool.query(`INSERT INTO audit_checkpoints (sequence, hash, seal) VALUES (987654, $1, NULL)`, ['c'.repeat(64)]);
    await expect(t.pool.query(`UPDATE audit_checkpoints SET hash = 'x' WHERE sequence = 987654`)).rejects.toThrow(/not permitted/);
    await expect(t.pool.query(`DELETE FROM audit_checkpoints WHERE sequence = 987654`)).rejects.toThrow(/not permitted/);
    await expect(t.pool.query('TRUNCATE audit_checkpoints')).rejects.toThrow(/not permitted/);
  });
});

describe('writeAudit writes v2 rows', () => {
  let writeAudit: typeof import('../../src/db/utils').writeAudit;
  let ctx: typeof import('../../src/server/audit/context');
  const write = (user = 'usr-qa', action = 'Update', entityId = 'S-1', reason = 'because') =>
    db.transaction((tx: any) => writeAudit(tx, user, action, 'Sample', entityId, 'state', 'a', 'b', reason));

  beforeAll(async () => {
    ({ writeAudit } = await import('../../src/db/utils'));
    ctx = await import('../../src/server/audit/context');
  });

  it('records the actor snapshot, the application version and the hash version, and the row verifies', async () => {
    await emptyAuditTrail(t.pool);
    const entry = await write('usr-qa');
    const row = (await t.pool.query('SELECT * FROM audit_trail WHERE id = $1', [entry.id])).rows[0];
    expect(row).toMatchObject({ user_id: 'usr-qa', actor_name: 'Test QA Officer', actor_role: 'QA', session_id: null, hash_version: 2, hash_alg: 'hmac-sha256-v1' });
    expect(row.app_version).toEqual(expect.any(String));
    expect(row.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(row.timestamp.toISOString()).toBe(row.timestamp_str); // one moment, written once
    expect(mod.verifyAuditRows([row])).toMatchObject({ isValid: true });
    // The link covers the fields the code before this release hashed; since the keyed chain (r2-audit-tamper, M35) it is an HMAC
    // with the keystore's audit key instead of a plain SHA-256, so the published formula alone no longer reproduces it.
    const linked = { sequence: 1, timestampStr: row.timestamp_str, userId: 'usr-qa', action: 'Update', entity: 'Sample', entityId: 'S-1', field: 'state', oldValue: 'a', newValue: 'b', reason: 'because' };
    const { getKeystore } = await import('../../src/server/crypto/keystore');
    const content = JSON.stringify({ sequence: 1, timestamp: row.timestamp_str, userId: 'usr-qa', action: 'Update', entity: 'Sample', entityId: 'S-1', field: 'state', oldValue: 'a', newValue: 'b', reason: 'because' });
    expect(row.hash).toBe(createHmac('sha256', getKeystore().deriveKey('audit-hmac', 'chain', 1)).update(content + GENESIS).digest('hex'));
    expect(row.hash).not.toBe(linkOf(linked, GENESIS));
  });

  it('a later rename of the user does not touch the snapshot, and an actor without a user row is stored with null name and role', async () => {
    await t.pool.query(`UPDATE users SET name = 'Renamed QA' WHERE id = 'usr-qa'`);
    const a = await write('usr-qa');
    const b = await write('migration:someone');
    await t.pool.query(`UPDATE users SET name = 'Test QA Officer' WHERE id = 'usr-qa'`);
    const rows = (await t.pool.query('SELECT id, actor_name, actor_role, user_id FROM audit_trail WHERE id = ANY($1) ORDER BY sequence', [[a.id, b.id]])).rows;
    expect(rows[0]).toMatchObject({ actor_name: 'Renamed QA', actor_role: 'QA' });
    expect(rows[1]).toMatchObject({ user_id: 'migration:someone', actor_name: null, actor_role: null });
    expect((await mod.verifyAuditChain(db, { writeCheckpoints: false })).isValid).toBe(true);
  });

  it('takes the session id from the request context when there is one', async () => {
    await ctx.runWithAuditContext(async () => {
      ctx.setAuditSessionId('sess-42');
      const e = await write();
      const row = (await t.pool.query('SELECT session_id FROM audit_trail WHERE id = $1', [e.id])).rows[0];
      expect(row.session_id).toBe('sess-42');
    });
    const outside = await write();
    expect((await t.pool.query('SELECT session_id FROM audit_trail WHERE id = $1', [outside.id])).rows[0].session_id).toBeNull();
    expect((await mod.verifyAuditChain(db, { writeCheckpoints: false })).isValid).toBe(true);
  });

  it('the auditContext middleware, mounted after the body parser, carries the session id through awaits to the audit row', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use(ctx.auditContext);
    app.post('/act', async (req, res, next) => {
      try {
        await new Promise(r => setTimeout(r, 5)); // authentication awaits the database before it knows the session
        ctx.setAuditSessionId(req.body.sid);
        await new Promise(r => setTimeout(r, 5));
        const e = await write('usr-qa', 'Update', 'S-ctx');
        res.json({ id: e.id });
      } catch (err) { next(err); }
    });
    const [a, b] = await Promise.all([supertest(app).post('/act').send({ sid: 'sess-A' }), supertest(app).post('/act').send({ sid: 'sess-B' })]);
    const rows = (await t.pool.query('SELECT id, session_id FROM audit_trail WHERE id = ANY($1)', [[a.body.id, b.body.id]])).rows;
    expect(Object.fromEntries(rows.map(r => [r.id, r.session_id]))).toEqual({ [a.body.id]: 'sess-A', [b.body.id]: 'sess-B' });
  });

  it('still requires a reason for everything but Create', async () => {
    await expect(write('usr-qa', 'Update', 'S-1', '')).rejects.toThrow(/Reason is required/);
    await expect(db.transaction((tx: any) => writeAudit(tx, 'usr-qa', 'Create', 'Sample', 'S-9', 'all', '', '{}', ''))).resolves.toBeTruthy();
  });

  it('a rolled-back transaction leaves no row and uses no sequence number', async () => {
    const before = (await tail(t.pool)).sequence;
    await expect(db.transaction(async (tx: any) => { await writeAudit(tx, 'usr-qa', 'Update', 'Sample', 'S-2', 'f', 'a', 'b', 'r'); throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await tail(t.pool)).sequence).toBe(before);
    const next = await write();
    expect(next.sequence).toBe(before + 1);
  });

  it('concurrent writers get consecutive sequence numbers and one unbroken chain', async () => {
    const before = (await tail(t.pool)).sequence;
    await Promise.all(Array.from({ length: 16 }, (_, i) => write('usr-qa', 'Update', `S-${i}`)));
    const seqs = (await t.pool.query('SELECT sequence FROM audit_trail WHERE sequence > $1 ORDER BY sequence', [before])).rows.map(r => r.sequence);
    expect(seqs).toEqual(Array.from({ length: 16 }, (_, i) => before + 1 + i));
    expect((await mod.verifyAuditChain(db, { writeCheckpoints: false })).isValid).toBe(true);
  });

  it('writes a checkpoint when the sequence reaches a multiple of 5000, and not for the next entry', async () => {
    await emptyAuditTrail(t.pool);
    await insertRows(t.pool, chain(4999, await tail(t.pool), () => 2));
    expect((await t.pool.query('SELECT count(*)::int AS n FROM audit_checkpoints')).rows[0].n).toBe(0);
    const e5000 = await write();
    expect(e5000.sequence).toBe(5000);
    const cps = (await t.pool.query('SELECT sequence, hash, seal FROM audit_checkpoints')).rows;
    expect(cps).toEqual([{ sequence: 5000, hash: e5000.hash, seal: e5000.seal }]);
    await write();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM audit_checkpoints')).rows[0].n).toBe(1);
    // Bounded verification now starts at that checkpoint.
    expect(await mod.verifyAuditChainTo(db, { sequence: 5001 })).toMatchObject({ isValid: true, startedFrom: 'checkpoint', checkpointSequence: 5000, rowsChecked: 1 });
    expect((await mod.verifyAuditChain(db, { writeCheckpoints: false })).isValid).toBe(true);
  }, 120_000);
});
