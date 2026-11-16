import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain, writeAudit } from '../../server/audit/index.js';
import { withTx } from '../../server/core/db.js';
import { migrate } from '../../server/migrate/runner.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// E19#3: backup and restore are tested: a restored backup passes the audit chain verification. The scripts are the ones
// an installation uses (deploy/backup), run here against a real PostgreSQL with its own pg_dump and pg_restore.
const BACKUP = fileURLToPath(new URL('../../deploy/backup/backup.sh', import.meta.url));
const RESTORE = fileURLToPath(new URL('../../deploy/backup/restore.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const isBuilt = () => { try { readFileSync(join(ROOT, 'dist/server/audit/index.js')); return true; } catch { return false; } };
// CI runs the tests before the build step: the server part is compiled here when it is missing (found on the first CI run)
if (!isBuilt()) execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'tsconfig.build.json')], { stdio: 'inherit' });
const built = isBuilt();
let src: Awaited<ReturnType<typeof freshDatabase>>, dst: Awaited<ReturnType<typeof freshDatabase>>, dir = '';

beforeAll(async () => {
  src = await freshDatabase('bsrc'); dst = await freshDatabase('bdst');
  await migrate(src.pool, MIGRATIONS);
  for (let i = 0; i < 25; i++) await withTx(src.pool, (c) => writeAudit(c, { actorId: 'u', actorName: 'op', action: 'x.done', entity: 'thing', entityId: String(i), newValue: { i } }));
  dir = mkdtempSync(join(tmpdir(), 'ebr-backup-'));
});
afterAll(async () => { await src.drop(); await dst.drop(); rmSync(dir, { recursive: true, force: true }); });

describe('backup and restore (E19#3)', () => {
  it('the build exists (restore.sh verifies the chain with the built application)', () => {
    expect(built, 'run npm run build before this test').toBe(true);
  });
  let dump = '';
  it('backup.sh writes a dump with its SHA-256', () => {
    const out = execFileSync('bash', [BACKUP, dir], { env: { ...process.env, DATABASE_URL: src.url }, encoding: 'utf8' });
    dump = out.match(/backup written: (\S+)/)![1]!;
    expect(readFileSync(dump + '.sha256', 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });
  it('restore.sh restores into an empty database and the audit chain of the restored data verifies', async () => {
    const out = execFileSync('bash', [RESTORE, dump, dst.url], { encoding: 'utf8' });
    expect(out).toMatch(/audit chain of the restored database: \{"ok":true,"entries":25\}/);
    expect(await verifyChain(dst.pool)).toEqual({ ok: true, entries: 25 });
    await expect(dst.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);     // the protections came back too
  });
  it('a backup file that changed is not restored', () => {
    const bad = join(dir, 'changed.dump');
    writeFileSync(bad, Buffer.concat([readFileSync(dump), Buffer.from('x')]));
    writeFileSync(bad + '.sha256', readFileSync(dump + '.sha256'));
    let out = '';
    try { execFileSync('bash', [RESTORE, bad, dst.url], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { out = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? ''); }
    expect(out).toMatch(/does not match its SHA-256: not restored/);
  });
});
