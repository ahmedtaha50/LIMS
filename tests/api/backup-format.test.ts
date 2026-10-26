/**
 * Backup v2 file format (roadmap M14): BPLIMSBK2, a stream of independently authenticated frames.
 *
 *  - every value is exported as the text PostgreSQL stores (microseconds and all), so a restore is byte-identical;
 *  - frames are AES-256-GCM with counter IVs and the frame index in the authenticated data, so a flipped bit, a swapped,
 *    dropped or appended frame is detected, and verification names the frame;
 *  - the footer carries the manifest (schema version, per-table counts and hashes, empty blob section);
 *  - a v1 file (BPLIMSBK1) can still be verified and restored.
 *
 * Runs against real PostgreSQL databases (scratch databases migrated by the product's own runner).
 */
import { createCipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { linkHash, sealAnchor, sealHash } from '../../src/server/audit/hash';
import {
  createBackup, listFrames, restoreBackup, verifyAuditChain, verifyBackup, verifyBackupFile,
} from '../../src/server/backup';
import { bootDatabase } from '../../src/server/boot';
import { ROOT, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const PASS = 'correct horse battery staple';
const DRIZZLE = path.join(ROOT, 'drizzle');

/** n audit rows continuing the chain, written with the product's hash formulas (a v2 row has a seal). */
async function appendAudit(pool: Scratch['pool'], n: number) {
  const last = (await pool.query('select sequence, hash, seal from audit_trail order by sequence desc limit 1')).rows[0];
  let prev = { sequence: last.sequence as number, hash: last.hash as string, seal: (last.seal ?? null) as string | null };
  for (let i = 0; i < n; i++) {
    const sequence = prev.sequence + 1;
    const timestamp = new Date(Date.UTC(2026, 9, 13, 13, 16, 51, 889)).toISOString();
    const rec = { sequence, timestamp, userId: 'u1', action: 'Update', entity: 'Sample', entityId: `S${i % 3}`, field: 'state', oldValue: `o${i}`, newValue: `n${i}`, reason: `r${i}` };
    const hash = linkHash(rec, prev.hash);
    const seal = sealHash({ ...rec, actorName: 'U One', actorRole: 'Analyst', sessionId: null, appVersion: '0.1.0', hash }, sealAnchor(prev));
    await pool.query(
      `insert into audit_trail (id, sequence, timestamp, timestamp_str, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash,
                                actor_name, actor_role, app_version, hash_version, hash_alg, seal)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'U One','Analyst','0.1.0',2,'sha256',$15)`,
      [`adt-f-${sequence}`, sequence, timestamp, timestamp, rec.userId, rec.action, rec.entity, rec.entityId, rec.field, rec.oldValue, rec.newValue, rec.reason, hash, prev.hash, seal]);
    prev = { sequence, hash, seal };
  }
}

/** The database as one comparable value per table: the text of every row, in primary-key order, in a UTC session. */
async function fingerprintOf(pool: Scratch['pool']): Promise<Record<string, string>> {
  const c = await pool.connect();
  try {
    await c.query("set time zone 'UTC'");
    const tables = (await c.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map(r => r.table_name);
    const out: Record<string, string> = {};
    for (const t of tables) {
      out[t] = (await c.query(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') || ':' || count(*) as f from "${t}" x`)).rows[0].f;
    }
    return out;
  } finally { c.release(); }
}

let src: Scratch;
let dir: string;
beforeAll(async () => {
  dir = tempDir('bplims-format');
  src = await scratchDb('format-src');
  await bootDatabase({ migrate: true, pool: src.pool, dir: DRIZZLE, backup: null });
  await src.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'Analyst')`);
  await src.pool.query(`insert into samples (id, material, batch, state, created_by, created_at) values ('S0', 'M', 'B', 'Testing', 'u1', '2026-03-29 00:30:00.123456+00')`);
  await src.pool.query(`insert into results (id, sample_id, parameter, value, spec_min, spec_max, entered_by, entered_at, attachment_name, attachment_data)
                        values ('R0', 'S0', 'Assay', '99.5', 0.1, 101.5, 'u1', '2026-10-13 13:16:51.889123+00', 'raw.txt', $1)`, ['Zm9v'.repeat(5000) + 'é中😀']);
  await src.pool.query(`insert into signatures (id, sample_id, signer_id, meaning, reason, timestamp, record_version, content_hash, audit_entry_id)
                        values ('G0', 'S0', 'u1', 'Authorship', 'r', '2026-10-13 13:16:51.889123+00', 1, 'h', 'a')`);
  await src.pool.query(`insert into specifications (id, material, version, effective_date, status, parameters) values ('SP0', 'M', 1, '2026-01-01', 'Active', '{"b": 1, "a": [1.50, "x"]}'::jsonb)`);
  await appendAudit(src.pool, 40);
});

describe('BPLIMSBK2 file', () => {
  it('is written as frames, with a manifest that holds schema version, per-table counts and hashes, and an empty blob section', async () => {
    const b = await createBackup(src.pool, PASS, dir, { frameBytes: 8 * 1024 });
    expect(b.verified).toBe(true);
    expect(b.sha256).toBe(createHash('sha256').update(fs.readFileSync(b.file)).digest('hex'));
    const head = fs.readFileSync(b.file).subarray(0, 9).toString();
    expect(head).toBe('BPLIMSBK2');
    expect(listFrames(b.file).length).toBeGreaterThan(3);

    const m = b.manifest;
    expect(m.format).toBe(2);
    expect(m.schemaVersion).toBe((await src.pool.query('select max(id) as id from schema_migrations')).rows[0].id);
    expect(m.blobs).toEqual([]);
    expect(m.counts.users).toBe(1);
    expect(m.counts.audit_trail).toBe(41);
    expect(m.auditHead.sequence).toBe(41);
    for (const [table, n] of Object.entries(m.counts)) {
      expect(m.tables![table].rows, table).toBe(n);
      expect(m.tables![table].sha256, table).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(m.tables!.signatures.tsColumns).toEqual(['timestamp']);
    expect(m.tables!.results.tsColumns).toEqual(['entered_at']);
  });

  it('does not contain the data in the clear', async () => {
    const b = await createBackup(src.pool, PASS, dir);
    const bytes = fs.readFileSync(b.file);
    expect(bytes.includes(Buffer.from('Test Analyst'))).toBe(false);
    expect(bytes.includes(Buffer.from('Zm9vZm9v'))).toBe(false);
    expect(bytes.includes(Buffer.from('U One'))).toBe(false);
  });

  it('restores into an empty database with every row identical: micro-second timestamps, jsonb, real, non-ASCII text, 5,000-fold attachment text', async () => {
    const b = await createBackup(src.pool, PASS, dir, { frameBytes: 16 * 1024 });
    const target = await scratchDb('format-dst');
    const r = await restoreBackup(b.file, PASS, target.pool);
    expect(r).toMatchObject({ chainIntact: true, countsMatch: true, hashesMatch: true, timestampsMatch: true });
    expect(await fingerprintOf(target.pool)).toEqual(await fingerprintOf(src.pool));

    const c = await target.pool.connect();
    try {
      await c.query("set time zone 'UTC'");
      const row = (await c.query(`select s.created_at::text as sample, r.entered_at::text as result, g.timestamp::text as sig from samples s, results r, signatures g`)).rows[0];
      expect(row).toEqual({ sample: '2026-03-29 00:30:00.123456+00', result: '2026-10-13 13:16:51.889123+00', sig: '2026-10-13 13:16:51.889123+00' });
    } finally { c.release(); }
    // The restored schema is the schema of the backup's version: the journal came back too.
    expect((await target.pool.query('select count(*)::int as n from schema_migrations')).rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it('never restores into a database that already holds data', async () => {
    const b = await createBackup(src.pool, PASS, dir);
    await expect(restoreBackup(b.file, PASS, src.pool)).rejects.toThrow(/not empty/i);
  });

  it('refuses to restore a backup made by a newer schema than this application knows, and says so', async () => {
    const newer = await scratchDb('format-newer');
    await bootDatabase({ migrate: true, pool: newer.pool, dir: DRIZZLE, backup: null });
    await newer.pool.query(`insert into schema_migrations (id, sha256, app_version) values ('9999_from_the_future', 'x', '99.0.0')`);
    const b = await createBackup(newer.pool, PASS, tempDir('bplims-newer'));
    expect(b.manifest.schemaVersion).toBe('9999_from_the_future');
    await expect(restoreBackup(b.file, PASS, (await scratchDb('format-newer-target')).pool)).rejects.toThrow(/newer version of the application/);
  });

  it('refuses the wrong passphrase and a short one', async () => {
    const b = await createBackup(src.pool, PASS, dir);
    expect(() => verifyBackupFile(b.file, 'another passphrase entirely')).toThrow(/wrong passphrase or file damaged/i);
    await expect(verifyBackup(b.file, 'another passphrase entirely')).rejects.toThrow(/wrong passphrase or file damaged/i);
    await expect(createBackup(src.pool, 'short', dir)).rejects.toThrow(/at least 12/);
  });

  it('leaves no temporary file behind (the file is written as .part and renamed only after it was read back and verified)', async () => {
    const fresh = tempDir('bplims-clean');
    const b = await createBackup(src.pool, PASS, fresh);
    expect(fs.readdirSync(fresh)).toEqual([path.basename(b.file)]);
  });
});

describe('damaged files', () => {
  let file: string;
  let frames: ReturnType<typeof listFrames>;
  beforeAll(async () => {
    file = (await createBackup(src.pool, PASS, dir, { frameBytes: 4 * 1024 })).file;
    frames = listFrames(file);
  });
  const copy = (name: string) => { const f = path.join(dir, name); fs.copyFileSync(file, f); return f; };

  it('one flipped bit in one frame fails verification and names that frame (sync and streaming verifier agree)', async () => {
    const data = frames.filter(f => f.type === 1);
    expect(data.length).toBeGreaterThan(5);
    for (const k of [0, 3, data.length - 1]) {
      const f = copy(`flip-${k}.bak`);
      const fd = fs.openSync(f, 'r+');
      const at = data[k].offset + 5 + Math.floor(data[k].length / 2);
      const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, at); b[0] ^= 0x01; fs.writeSync(fd, b, 0, 1, at); fs.closeSync(fd);
      const sync = verifyBackupFile(f, PASS);
      expect(sync.ok).toBe(false);
      expect(sync.corruptFrame).toBe(data[k].index);
      expect(sync.problems.join(' ')).toMatch(new RegExp(`frame ${data[k].index}\\b`));
      expect(await verifyBackup(f, PASS)).toMatchObject({ ok: false, corruptFrame: data[k].index });
      await expect(restoreBackup(f, PASS, (await scratchDb('flip-target')).pool)).rejects.toThrow(/failed verification/);
    }
  });

  it('a dropped frame, two swapped frames, a truncated file and appended bytes are all detected', async () => {
    const bytes = fs.readFileSync(file);
    const data = frames.filter(f => f.type === 1);
    const slice = (f: { offset: number; length: number }) => bytes.subarray(f.offset, f.offset + f.length);
    const before = (f: { offset: number }) => bytes.subarray(0, f.offset);
    const after = (f: { offset: number; length: number }) => bytes.subarray(f.offset + f.length);

    // A missing frame moves the footer, so the trailer no longer points at it: the file is refused, either as unreadable or as failing.
    const dropped = path.join(dir, 'dropped.bak');
    fs.writeFileSync(dropped, Buffer.concat([before(data[2]), after(data[2])]));
    let droppedOk = true;
    try { droppedOk = verifyBackupFile(dropped, PASS).ok; } catch { droppedOk = false; }
    expect(droppedOk).toBe(false);
    await expect(restoreBackup(dropped, PASS, (await scratchDb('dropped-target')).pool)).rejects.toThrow();

    const swapped = path.join(dir, 'swapped.bak');
    fs.writeFileSync(swapped, Buffer.concat([before(data[1]), slice(data[2]), slice(data[1]), after(data[2])]));
    expect(verifyBackupFile(swapped, PASS)).toMatchObject({ ok: false, corruptFrame: data[1].index });

    const truncated = path.join(dir, 'truncated.bak');
    fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 40));
    expect(() => verifyBackupFile(truncated, PASS)).toThrow(/incomplete|truncated|damaged/i);

    const appended = path.join(dir, 'appended.bak');
    fs.writeFileSync(appended, Buffer.concat([bytes, Buffer.from('extra')]));
    expect(() => verifyBackupFile(appended, PASS)).toThrow(/incomplete|truncated|damaged/i);
  });

  it('a broken audit chain inside the backup is reported with its sequence', async () => {
    const tampered = await scratchDb('format-tampered');
    await bootDatabase({ migrate: true, pool: tampered.pool, dir: DRIZZLE, backup: null });
    await tampered.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'Analyst')`);
    await appendAudit(tampered.pool, 10);
    const c = await tampered.pool.connect();
    try { // the owner lifts the guard for one statement, which is exactly what the chain exists to detect
      await c.query('alter table audit_trail disable trigger user');
      await c.query(`update audit_trail set new_value = 'forged' where sequence = 7`);
      await c.query('alter table audit_trail enable trigger user');
    } finally { c.release(); }
    const b = await createBackup(tampered.pool, PASS, tempDir('bplims-tampered'));
    expect(b.verified).toBe(false);
    const v = verifyBackupFile(b.file, PASS);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/audit chain broken at sequence 7/);
  });
});

describe('version 1 files', () => {
  /** The writer of the previous release, kept here as the definition of what v1 looks like. */
  function writeV1(file: string, payload: unknown) {
    const salt = randomBytes(16), iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', scryptSync(PASS, salt, 32), iv);
    const enc = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload)))), c.final()]);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('BPLIMSBK1'), salt, iv, c.getAuthTag(), enc]));
  }

  it('is still verified and restored', async () => {
    const tables: Record<string, any[]> = {};
    const counts: Record<string, number> = {};
    for (const t of ['users', 'samples', 'audit_trail']) { const r = await src.pool.query(`select * from "${t}" order by 1`); tables[t] = JSON.parse(JSON.stringify(r.rows)); counts[t] = r.rows.length; }
    const audit = [...tables.audit_trail].sort((a, b) => a.sequence - b.sequence);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const manifest = { format: 1, createdAt: new Date().toISOString(), auditHead: { sequence: audit.at(-1).sequence, hash: audit.at(-1).hash }, counts, dataHash: sha(JSON.stringify(tables)) };
    const file = path.join(dir, 'old.bak');
    writeV1(file, { manifest, tables });

    expect(verifyBackupFile(file, PASS)).toMatchObject({ ok: true, problems: [] });
    expect(await verifyBackup(file, PASS)).toMatchObject({ ok: true, problems: [] });
    const target = await scratchDb('format-v1');
    const r = await restoreBackup(file, PASS, target.pool);
    expect(r).toMatchObject({ chainIntact: true, countsMatch: true });
    expect((await target.pool.query('select count(*)::int as n from audit_trail')).rows[0].n).toBe(41);
  });
});

describe('verifyAuditChain (rows in memory, kept for older callers)', () => {
  it('answers { isValid, compromisedSequence } for snake_case and camelCase rows', async () => {
    const rows = (await src.pool.query('select * from audit_trail order by sequence')).rows;
    expect(verifyAuditChain(rows)).toEqual({ isValid: true, compromisedSequence: null });
    const broken = rows.map(r => (r.sequence === 12 ? { ...r, new_value: 'x' } : r));
    expect(verifyAuditChain(broken)).toEqual({ isValid: false, compromisedSequence: 12 });
  });
});
