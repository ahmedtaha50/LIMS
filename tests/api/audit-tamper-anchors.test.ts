/**
 * Roadmap M35 (r2-audit-tamper), acceptance 2: someone with the database owner's rights can switch the triggers off, rewrite a row
 * and re-hash every row after it. The chain then verifies again, because the verifier can only check the chain against itself. The
 * daily anchor is the outside witness: a file on a second path (the backup mirror) that holds the head of the chain (sequence, hash,
 * seal) and of the security-event chain, signed with an HMAC key from the keystore that is not in the database. Verifying the anchors
 * compares every anchored row with what the database holds now.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let db: any;
let anchors: typeof import('../../src/server/audit/anchors');
let writeAudit: typeof import('../../src/db/utils').writeAudit;
let verifyAuditChain: typeof import('../../src/server/audit/chain').verifyAuditChain;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchors-'));

beforeAll(async () => {
  t = await useTestDb();
  db = (await import('../../src/db/index')).db;
  anchors = await import('../../src/server/audit/anchors');
  writeAudit = (await import('../../src/db/utils')).writeAudit;
  verifyAuditChain = (await import('../../src/server/audit/chain')).verifyAuditChain;
});

const q = async (text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows;
async function addRows(n: number, tag: string) {
  await db.transaction(async (tx: any) => {
    for (let i = 0; i < n; i++) await writeAudit(tx, 'usr-qa', 'Update', 'Sample', `${tag}-${i}`, 'state', 'a', 'b', `reason ${tag} ${i}`);
  });
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * What an owner without the HMAC key can do: rewrite one row, then re-hash the WHOLE chain from the first row with the published
 * v1 formula (sha256, no seal). Starting at the first row leaves no keyed row in front of a rewritten one, so even the keyed chain's
 * downgrade rule has nothing to compare with: the chain verifies, and only the anchors can tell.
 */
async function rewriteAndRehash(target: number, newReason: string) {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
    await c.query('UPDATE audit_trail SET reason = $2 WHERE sequence = $1', [target, newReason]);
    const rows = (await c.query('SELECT * FROM audit_trail ORDER BY sequence')).rows;
    let prev = '0'.repeat(64);
    for (const r of rows) {
      const hash = sha(JSON.stringify({ sequence: r.sequence, timestamp: r.timestamp_str, userId: r.user_id, action: r.action, entity: r.entity, entityId: r.entity_id, field: r.field, oldValue: r.old_value, newValue: r.new_value, reason: r.reason }) + prev);
      await c.query(`UPDATE audit_trail SET hash = $2, prev_hash = $3, seal = NULL, hash_version = 1, hash_alg = 'sha256' WHERE sequence = $1`, [r.sequence, hash, prev]);
      prev = hash;
    }
    // The owner also "fixes" the checkpoints and the anchor register in the database; only the files on the second path are out of reach.
    await c.query('ALTER TABLE audit_checkpoints DISABLE TRIGGER USER');
    await c.query('DELETE FROM audit_checkpoints');
    await c.query('ALTER TABLE audit_checkpoints ENABLE TRIGGER USER');
    await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
}

describe('where the anchors go', () => {
  it('AUDIT_ANCHOR_DIR first, else a folder in the backup mirror (the second path), else the backup folder (not a second path), else nothing', () => {
    expect(anchors.anchorDirectory({ AUDIT_ANCHOR_DIR: '/x/anchors', BACKUP_MIRROR_DIR: '/m' })).toEqual({ dir: '/x/anchors', secondPath: true });
    expect(anchors.anchorDirectory({ BACKUP_MIRROR_DIR: '/m', BACKUP_DIR: '/b' })).toEqual({ dir: path.join('/m', 'audit-anchors'), secondPath: true });
    expect(anchors.anchorDirectory({ BACKUP_DIR: '/b' })).toEqual({ dir: path.join('/b', 'audit-anchors'), secondPath: false });
    expect(anchors.anchorDirectory({})).toEqual({ dir: null, secondPath: false });
  });

  it('writing an anchor with nowhere to put it fails loudly', async () => {
    await expect(anchors.writeAnchor(db, { dir: null, actorId: 'usr-admin' })).rejects.toThrow(/AUDIT_ANCHOR_DIR/);
  });
});

describe('an anchor', () => {
  it('is a signed file with the head of both chains, registered in the database with a security event', async () => {
    await addRows(5, 'A');
    const head = (await q('SELECT sequence, hash, seal FROM audit_trail ORDER BY sequence DESC LIMIT 1'))[0];
    const { file, anchor } = await anchors.writeAnchor(db, { dir, actorId: 'usr-admin' });
    expect(path.dirname(file)).toBe(dir);
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(content).toMatchObject({ kind: 'bplims-audit-anchor', v: 1, sequence: head.sequence, hash: head.hash, seal: head.seal, keyGeneration: 1 });
    expect(content.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(content.securityEvents).toHaveProperty('sequence');
    expect(anchor.sequence).toBe(head.sequence);
    expect(await q('SELECT sequence, hash, file_name FROM audit_anchors')).toEqual([{ sequence: head.sequence, hash: head.hash, file_name: path.basename(file) }]);
    expect(await q(`SELECT outcome FROM security_events WHERE event_type = 'AUDIT_ANCHOR'`)).toEqual([{ outcome: 'success' }]);
  });

  it('verifies while the database still holds the anchored rows, also after the chain has grown', async () => {
    await addRows(3, 'B');
    await anchors.writeAnchor(db, { dir, actorId: 'usr-admin' });
    await addRows(2, 'C');
    const v = await anchors.verifyAnchors(db, { dir });
    expect(v).toMatchObject({ isValid: true, anchorsChecked: 2, failures: [] });
    expect(v.latest?.sequence).toBeGreaterThan(5);
  });

  it('a file whose content was edited fails its HMAC; a file in the register that is gone is reported', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchors-copy-'));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
    const edited = JSON.parse(fs.readFileSync(path.join(copy, files[0]), 'utf8'));
    edited.sequence = edited.sequence - 1;
    // anchors are written 0o444; whoever edits one can change the mode first (root ignores it, a CI runner user does not)
    fs.chmodSync(path.join(copy, files[0]), 0o644);
    fs.writeFileSync(path.join(copy, files[0]), JSON.stringify(edited));
    fs.unlinkSync(path.join(copy, files[1]));
    const v = await anchors.verifyAnchors(db, { dir: copy });
    expect(v.isValid).toBe(false);
    expect(v.failures.map(f => f.reason).sort()).toEqual(['FILE_MISSING', 'HMAC_INVALID']);
  });

  it('a file signed with another key is not accepted', async () => {
    const { createKeystore, setKeystore, getKeystore } = await import('../../src/server/crypto/keystore');
    const real = getKeystore();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchors-other-'));
    setKeystore(createKeystore({ current: 1, keys: { 1: 'a-completely-different-master-key-0123456789' } }));
    try { await anchors.writeAnchor(db, { dir: other, actorId: 'usr-admin', register: false }); } finally { setKeystore(real); }
    const v = await anchors.verifyAnchors(db, { dir: other, register: false });
    expect(v.failures.map(f => f.reason)).toEqual(['HMAC_INVALID']);
  });
});

describe('acceptance: rewriting and re-hashing the chain as the owner', () => {
  it('passes the chain check on its own, and the anchor verification reports the mismatch', async () => {
    const before = await anchors.verifyAnchors(db, { dir });
    expect(before.isValid).toBe(true);
    const target = (await q(`SELECT sequence FROM audit_trail WHERE entity_id = 'A-1'`))[0].sequence as number;
    await rewriteAndRehash(target, 'a reason nobody gave');

    // The rewritten chain is self-consistent: the verifier alone cannot see it.
    expect((await verifyAuditChain(db, { writeCheckpoints: false })).isValid).toBe(true);

    const v = await anchors.verifyAnchors(db, { dir, actorId: 'usr-admin' });
    expect(v.isValid).toBe(false);
    expect(v.failures.length).toBe(2);
    expect(v.failures.every(f => f.reason === 'HASH_MISMATCH')).toBe(true);
    const [ev] = await q(`SELECT outcome, detail FROM security_events WHERE event_type = 'AUDIT_ANCHOR_MISMATCH' ORDER BY sequence DESC LIMIT 1`);
    expect(ev.outcome).toBe('failure');
    expect(JSON.parse(ev.detail).failures[0]).toMatchObject({ reason: 'HASH_MISMATCH' });
  });

  it('a chain cut back below an anchor is reported as truncated', async () => {
    const latest = { sequence: (await q('SELECT max(sequence)::int AS s FROM audit_anchors'))[0].s as number };
    const c = await t.pool.connect();
    try {
      await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
      await c.query('DELETE FROM audit_trail WHERE sequence >= $1', [latest.sequence]);
      await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
    } finally { c.release(); }
    const v = await anchors.verifyAnchors(db, { dir, register: false });
    expect(v.failures.map(f => f.reason)).toContain('TRUNCATED');
  });

  it('the start-up check logs the mismatch as an error and does not throw', async () => {
    const lines: string[] = [];
    const v = await anchors.startupAnchorCheck(db, { env: { AUDIT_ANCHOR_DIR: dir }, log: m => lines.push(m) });
    expect(v?.isValid).toBe(false);
    expect(lines.join('\n')).toMatch(/anchor/i);
  });
});
