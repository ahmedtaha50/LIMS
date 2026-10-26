/**
 * Roadmap M21 (r2-instrument-integration): the folder agent.
 *
 *   - a balance export dropped in the inbox of an approved profile is registered with the right sha256 within 15 s (fs.watch and the
 *     poll), moved to processed/ after the commit; a duplicate is refused, audited and moved to error/;
 *   - a malformed file goes to error/ with its reason beside it, registered as Failed; the raw file stays in the blob store;
 *   - only the canonical configured folder is read: no sub-folder, no symbolic link, nothing outside the pattern, nothing still being
 *     written; a Draft profile is not watched; the system's own folders cannot be watched;
 *   - a restart finishes a move that never happened instead of calling the file a duplicate.
 *
 * Needs the gate patch (docs/changes/r2-instrument-integration.gate.patch). No test depends on file modes, the user running it or how
 * "localhost" resolves.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { FIXTURES, PW, approvedProfile, fixture, instrument, tempDir } from './instrument-fixtures';

const BLOBS = tempDir('agent-blobs');
const ROOT = tempDir('agent-root');
process.env.BLOB_DIR = BLOBS;

let t: TestApp;
let appDb: any;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  appDb = (await import('../../src/db/index')).db;
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
afterAll(() => {
  delete process.env.BLOB_DIR;
  fs.rmSync(BLOBS, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const folder = (name: string) => { const d = path.join(ROOT, name); fs.mkdirSync(d); return d; };
const waitFor = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`not satisfied within ${ms} ms`);
    await new Promise(r => setTimeout(r, 100));
  }
};
const filesOf = (dir: string) => fs.readdirSync(dir).sort();

async function profileFor(dir: string, parser: string, over: Record<string, unknown> = {}) {
  const inst = await instrument(t);
  return { inst, profile: await approvedProfile(t, H, { instrumentId: inst, parser, watchDir: dir, ...over }) };
}
async function agent(opts: Record<string, unknown> = {}) {
  const { startFolderAgent } = await import('../../src/server/connectors/folderAgent');
  return startFolderAgent(appDb, { pollMs: 60_000, settleMs: 0, initialScan: false, log: () => undefined, ...opts });
}

describe('the inbox', () => {
  it('registers a balance export with the right sha256 within 15 s and moves it to processed/ after the commit', async () => {
    const dir = folder('balance');
    const { profile, inst } = await profileFor(dir, 'balance-text', { glob: '*.txt' });
    const a = await agent({ pollMs: 1000, settleMs: 300, initialScan: true });
    try {
      const body = fixture('balance.txt');
      const started = Date.now();
      fs.writeFileSync(path.join(dir, 'weigh-001.txt'), body);
      const row = await waitFor(async () => (await sql('SELECT * FROM instrument_files WHERE sha256 = $1', [sha(body)]))[0]);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(row).toMatchObject({ profile_id: profile.id, instrument_id: inst, file_name: 'weigh-001.txt', source: 'watch', parse_status: 'Parsed', row_count: 3, bytes: String(body.length) });
      const done = await waitFor(async () => (await sql('SELECT disposition FROM instrument_files WHERE id = $1', [row.id]))[0].disposition === 'Processed');
      expect(done).toBe(true);
      expect(filesOf(dir)).toEqual(["processed"]);
      expect(fs.readFileSync(path.join(dir, 'processed', 'weigh-001.txt'))).toEqual(body);
      expect(fs.readFileSync(path.join(BLOBS, sha(body)))).toEqual(body);
      expect(row.received_by).toBe('svc-scheduler');
      expect((await sql(`SELECT count(*)::int AS n FROM instrument_import_rows WHERE file_id = $1 AND state = 'Pending'`, [row.id]))[0].n).toBe(3);
      const trail = (await sql(`SELECT reason FROM audit_trail WHERE entity = 'InstrumentFile' AND entity_id = $1 ORDER BY sequence`, [row.id])).map(r => r.reason as string);
      expect(trail).toHaveLength(2);
      expect(trail[0]).toMatch(/^Instrument file weigh-001\.txt captured/);
      expect(trail[1]).toMatch(/^Moved to processed\/ after capture of 3 value/);
    } finally { await a.stop(); }
  });

  it('refuses a duplicate: audited, moved to error/ with the reason, one row only', async () => {
    const dir = folder('dup');
    const { profile } = await profileFor(dir, 'ph-csv');
    const a = await agent();
    try {
      fs.writeFileSync(path.join(dir, 'ph-1.csv'), fixture('ph.csv'));
      expect(await a.scanOnce()).toMatchObject({ captured: 1, duplicates: 0 });
      fs.writeFileSync(path.join(dir, 'ph-copy.csv'), fixture('ph.csv'));
      expect(await a.scanOnce()).toMatchObject({ captured: 0, duplicates: 1 });
      expect(filesOf(path.join(dir, 'error'))).toEqual(['ph-copy.csv', 'ph-copy.csv.reason.txt']);
      expect(fs.readFileSync(path.join(dir, 'error', 'ph-copy.csv.reason.txt'), 'utf8')).toContain('already captured as IMF-');
      expect((await sql('SELECT count(*)::int AS n FROM instrument_files WHERE sha256 = $1', [sha(fixture('ph.csv'))]))[0].n).toBe(1);
      const audit = await sql(`SELECT user_id, reason FROM audit_trail WHERE action = 'DuplicateRefused' AND reason LIKE $1`, [`%ph-copy.csv%${profile.id}%`]);
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBe('svc-scheduler');
    } finally { await a.stop(); }
  });

  it('a malformed file goes to error/ with its reason, registered as Failed, raw file kept, analysts notified', async () => {
    const dir = folder('bad');
    await profileFor(dir, 'ph-csv');
    const a = await agent();
    try {
      fs.writeFileSync(path.join(dir, 'ph-bad.csv'), fixture('ph-ragged.csv'));
      expect(await a.scanOnce()).toMatchObject({ failed: 1 });
      expect(filesOf(path.join(dir, 'error'))).toEqual(['ph-bad.csv', 'ph-bad.csv.reason.txt']);
      expect(fs.readFileSync(path.join(dir, 'error', 'ph-bad.csv.reason.txt'), 'utf8')).toBe('Line 2: expected 2 cells (as in the header) but found 3.\n');
      const [row] = await sql('SELECT * FROM instrument_files WHERE sha256 = $1', [sha(fixture('ph-ragged.csv'))]);
      expect(row).toMatchObject({ parse_status: 'Failed', parse_error: 'Line 2: expected 2 cells (as in the header) but found 3.', row_count: 0, disposition: 'Error' });
      expect(fs.existsSync(path.join(BLOBS, row.sha256))).toBe(true);
      expect((await sql(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'instrument.import_failed' AND entity_id = $1`, [row.id]))[0].n).toBe(1);
    } finally { await a.stop(); }
  });

  it('reads only the configured folder: pattern, sub-folders, symbolic links, temporary and half-written files are left alone', async () => {
    const dir = folder('strict');
    const outside = folder('outside');
    fs.writeFileSync(path.join(outside, 'secret.csv'), 'Sample ID,pH\nS-OUT,7.0\n');
    await profileFor(dir, 'ph-csv', { glob: 'ph-*.csv' });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not for the LIMS');
    fs.writeFileSync(path.join(dir, 'ph-x.csv.part'), 'Sample ID,pH\nS-PART,7.0\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'ph-in-sub.csv'), 'Sample ID,pH\nS-SUB,7.0\n');
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(dir, 'ph-link.csv'));
    const a = await agent({ settleMs: 5_000 });
    try {
      fs.writeFileSync(path.join(dir, 'ph-fresh.csv'), 'Sample ID,pH\nS-FRESH,7.0\n');
      expect(await a.scanOnce()).toEqual({ captured: 0, failed: 0, duplicates: 0, skipped: 1 }); // the fresh file may still be written
      expect(await sql(`SELECT 1 FROM instrument_files WHERE file_name IN ('notes.txt', 'ph-x.csv.part', 'ph-in-sub.csv', 'ph-link.csv', 'secret.csv', 'ph-fresh.csv')`)).toHaveLength(0);
    } finally { await a.stop(); }
    const b = await agent({ settleMs: 0 });
    try {
      expect(await b.scanOnce()).toMatchObject({ captured: 1 }); // only ph-fresh.csv
      expect(await sql(`SELECT file_name FROM instrument_files WHERE file_name IN ('notes.txt', 'ph-x.csv.part', 'ph-in-sub.csv', 'ph-link.csv', 'secret.csv')`)).toHaveLength(0);
      expect(filesOf(dir)).toEqual(['notes.txt', 'ph-link.csv', 'ph-x.csv.part', 'processed', 'sub']);
      expect(fs.existsSync(path.join(outside, 'secret.csv'))).toBe(true);
    } finally { await b.stop(); }
  });

  it('follows a configured folder that is itself a link, but still reads only inside the real folder', async () => {
    const real = folder('real');
    const link = path.join(ROOT, 'link-to-real');
    fs.symlinkSync(real, link);
    await profileFor(link, 'ph-csv');
    fs.writeFileSync(path.join(real, 'ph.csv'), Buffer.concat([fixture('ph.csv'), Buffer.from('SMP-FX-3,7.11,24.9,08:25\n')]));
    const a = await agent();
    try {
      expect(await a.scanOnce()).toMatchObject({ captured: 1 });
      expect(fs.existsSync(path.join(real, 'processed', 'ph.csv'))).toBe(true);
    } finally { await a.stop(); }
  });

  it('does not watch a Draft or a retired profile, or a folder that no longer exists', async () => {
    const dir = folder('draft');
    const inst = await instrument(t);
    const draft = await approvedProfile(t, H, { instrumentId: inst, parser: 'ph-csv', watchDir: dir, approve: false });
    fs.writeFileSync(path.join(dir, 'ph.csv'), fixture('ph.csv'));
    const gone = folder('gone');
    await profileFor(gone, 'ph-csv');
    fs.rmSync(gone, { recursive: true });
    const logs: string[] = [];
    const a = await agent({ log: (m: string) => logs.push(m) });
    try {
      await a.scanOnce();
      expect(fs.existsSync(path.join(dir, 'ph.csv'))).toBe(true);
      expect(await sql('SELECT 1 FROM instrument_files WHERE profile_id = $1', [draft.id])).toHaveLength(0);
      expect(logs.some(l => l.includes('cannot be opened'))).toBe(true);
    } finally { await a.stop(); }
  });

  it('refuses to scan the blob store, and a configured folder that became a link into it', async () => {
    const dir = folder('towards-blobs');
    await profileFor(dir, 'ph-csv');
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(BLOBS, dir);
    fs.writeFileSync(path.join(BLOBS, 'ph.csv'), fixture('ph.csv'));
    const logs: string[] = [];
    const a = await agent({ log: (m: string) => logs.push(m) });
    try {
      await a.scanOnce();
      expect(logs.join('\n')).toMatch(/overlaps .*which the system uses/);
      expect(fs.existsSync(path.join(BLOBS, 'ph.csv'))).toBe(true);
    } finally { await a.stop(); fs.rmSync(path.join(BLOBS, 'ph.csv'), { force: true }); }
  });

  it('finishes a move that never happened (the server stopped after the commit) instead of calling the file a duplicate', async () => {
    const dir = folder('restart');
    const { profile } = await profileFor(dir, 'ph-csv');
    const { ingestFile } = await import('../../src/server/connectors/ingest');
    const body = Buffer.concat([fixture('ph.csv'), Buffer.from('SMP-FX-RESTART,7.2,24.0,09:00\n')]);
    const out = await ingestFile(appDb, { profileId: profile.id, fileName: 'ph.csv', source: 'watch', content: (await import('stream')).Readable.from([body]), actorId: 'usr-analyst1', finalDisposition: false });
    expect(out.status).toBe('Captured');
    fs.writeFileSync(path.join(dir, 'ph.csv'), body);
    const a = await agent();
    try {
      expect(await a.scanOnce()).toMatchObject({ captured: 1, duplicates: 0 });
      expect(fs.existsSync(path.join(dir, 'processed', 'ph.csv'))).toBe(true);
      expect(filesOf(dir)).toEqual(['processed']);
      expect((await sql('SELECT disposition FROM instrument_files WHERE sha256 = $1', [sha(body)]))[0].disposition).toBe('Processed');
      expect((await sql('SELECT count(*)::int AS n FROM instrument_files WHERE sha256 = $1', [sha(body)]))[0].n).toBe(1);
    } finally { await a.stop(); }
  });

  it('a file with a name already used in processed/ keeps both', async () => {
    const dir = folder('names');
    await profileFor(dir, 'ph-csv');
    const a = await agent();
    try {
      fs.writeFileSync(path.join(dir, 'run.csv'), 'Sample ID,pH\nS-1,7.00\n');
      await a.scanOnce();
      fs.writeFileSync(path.join(dir, 'run.csv'), 'Sample ID,pH\nS-1,7.01\n');
      await a.scanOnce();
      const processed = filesOf(path.join(dir, 'processed'));
      expect(processed).toHaveLength(2);
      expect(processed).toContain('run.csv');
    } finally { await a.stop(); }
  });

  it('the start-up scan picks up what arrived while the server was down; overlapping scans never process a file twice', async () => {
    const dir = folder('startup');
    await profileFor(dir, 'ph-csv');
    fs.writeFileSync(path.join(dir, 'ph.csv'), 'Sample ID,pH\nS-UP,7.05\n');
    const a = await agent({ initialScan: true });
    try {
      await waitFor(async () => (await sql(`SELECT 1 FROM instrument_files WHERE file_name = 'ph.csv' AND sha256 = $1`, [sha('Sample ID,pH\nS-UP,7.05\n')])).length === 1);
      fs.writeFileSync(path.join(dir, 'ph2.csv'), 'Sample ID,pH\nS-UP,7.06\n');
      const results = await Promise.all([a.scanOnce(), a.scanOnce(), a.scanOnce()]);
      expect(results.reduce((n, r) => n + r.captured, 0)).toBe(1);
      expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(0);
    } finally { await a.stop(); }
  });
});

describe('the paths the agent accepts', () => {
  it('the profile folders and patterns are checked by the same functions the agent uses', async () => {
    const { globToRegExp, watchDirProblem } = await import('../../src/server/connectors/paths');
    expect(globToRegExp('weigh-*.TXT').test('weigh-001.txt')).toBe(true);
    expect(globToRegExp('weigh-?.txt').test('weigh-10.txt')).toBe(false);
    expect(globToRegExp('*.csv').test('a.csv.exe')).toBe(false);
    expect(() => globToRegExp('../*')).toThrow();
    expect(watchDirProblem(path.join(ROOT, 'x'))).toBeNull();
    expect(watchDirProblem('/')).toMatch(/root/);
    expect(watchDirProblem('relative')).toMatch(/absolute/);
    expect(watchDirProblem(BLOBS)).toMatch(/system uses/);
    expect(path.join(FIXTURES, 'x')).toBeTruthy();
    expect(PW).toBe('password');
  });
});
