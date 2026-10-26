/**
 * CLI: backup | verify | restore | drill. Secrets via env: BACKUP_PASSPHRASE. See validation/ and README.
 *
 *   backup   BACKUP_DIR                                  make a backup (no run record: use the application for that)
 *   verify   BACKUP_FILE                                 exit 0 ok, 2 a check failed (counts, hashes, audit chain), 1 file unreadable or damaged
 *   restore  BACKUP_FILE RESTORE_DB_NAME [SCHEMA_FILE]   into a NEW empty database (the schema of the backup's version, unless SCHEMA_FILE)
 *   drill    BACKUP_FILE                                 restore into a scratch database, compare with the manifest, drop it; exit 2 when it differs
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { createPool } from '../db/index';
import { createBackup, restoreBackup, verifyBackup } from './backup';

async function main() {
  const [cmd] = process.argv.slice(2);
  const pass = process.env.BACKUP_PASSPHRASE || '';
  if (!pass) throw new Error('Set BACKUP_PASSPHRASE');
  if (cmd === 'backup') {
    const r = await createBackup(createPool(), pass, process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
    console.log(JSON.stringify({ file: r.file, sha256: r.sha256, verified: r.verified, problems: r.problems, auditHead: r.manifest.auditHead, counts: r.manifest.counts }));
    if (!r.verified) process.exit(2);
  } else if (cmd === 'verify') {
    const r = await verifyBackup(process.env.BACKUP_FILE!, pass);
    console.log(JSON.stringify({ ok: r.ok, problems: r.problems, corruptFrame: r.corruptFrame, auditHead: r.manifest.auditHead }));
    if (r.corruptFrame !== null) process.exit(1); // the file itself is damaged
    if (!r.ok) process.exit(2);
  } else if (cmd === 'restore' || cmd === 'drill') {
    const name = cmd === 'drill' ? `${process.env.SQL_DB_NAME || 'lims'}_drill_${Date.now()}` : process.env.RESTORE_DB_NAME;
    if (!name || name === process.env.SQL_DB_NAME) throw new Error('RESTORE_DB_NAME must name a NEW database different from SQL_DB_NAME');
    const conn = { host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD };
    if (cmd === 'drill') { const admin = new pg.Client({ ...conn, database: 'postgres' }); await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`); await admin.end(); }
    const target = new pg.Pool({ ...conn, database: name });
    let r;
    try {
      const schema = process.env.SCHEMA_FILE ? fs.readFileSync(process.env.SCHEMA_FILE, 'utf8') : undefined; // default: built from the migrations, at the backup's schema version
      r = await restoreBackup(process.env.BACKUP_FILE!, pass, target, schema);
    } finally {
      await target.end();
      if (cmd === 'drill') { const admin = new pg.Client({ ...conn, database: 'postgres' }); await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
    }
    console.log(JSON.stringify(r));
    if (!r.chainIntact || !r.countsMatch || r.hashesMatch === false || r.timestampsMatch === false) process.exit(2);
  } else throw new Error('Usage: backup-cli backup|verify|restore|drill');
  process.exit(0);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
