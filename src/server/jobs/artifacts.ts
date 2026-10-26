/**
 * Files produced by jobs (a Certificate of Analysis PDF), roadmap M15. The file lives in ARTIFACT_DIR under a random name; the
 * job row keeps its checksum, size and expiry. Only the user who owns the job may read it (src/server/reports.ts checks that).
 * After ARTIFACT_RETENTION_DAYS (30, fixed) the file is deleted and the row says so; the checksum stays, as the record of what was issued.
 */
import { randomUUID, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { jobs } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { ensureServicePrincipal } from './principal';
import type { ArtifactRef } from './types';

export const ARTIFACT_RETENTION_DAYS = 30;

/** ARTIFACT_DIR, else an `artifacts` folder next to the backups folder (the desktop shell puts BACKUP_DIR in the user's data folder). */
export function artifactDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARTIFACT_DIR || path.join(path.dirname(env.BACKUP_DIR || path.join(process.cwd(), 'backups')), 'artifacts');
}

export interface StoreOptions {
  /** File name without extension. Default: a random UUID. A given name is overwritten, so a retried job rewrites its own file. */
  name?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export function storeArtifact(bytes: Buffer, extension: string, mime: string, o: StoreOptions = {}): ArtifactRef {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  const dir = artifactDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${o.name ?? randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(dir, path.basename(name)), bytes, { flag: o.name ? 'w' : 'wx', mode: 0o600 });
  return { name, mime, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, expiresAt: new Date(now.getTime() + ARTIFACT_RETENTION_DAYS * 86_400_000) };
}

/** Full path of a stored artifact. Only the base name of what the database holds is used. */
export const artifactPath = (name: string, env: NodeJS.ProcessEnv = process.env) => path.join(artifactDir(env), path.basename(name));

/**
 * Deletes the files whose retention has ended and marks the rows. Each deletion is an audit entry of the service principal
 * (Part 11: a deletion is a change). Returns how many artifacts were purged.
 */
export async function purgeExpiredArtifacts(db: Db, now = new Date(), limit = 500): Promise<number> {
  const due = await db.select({ id: jobs.id, name: jobs.artifactName, sha: jobs.artifactSha256 }).from(jobs)
    .where(and(isNotNull(jobs.artifactName), isNull(jobs.artifactPurgedAt), lte(jobs.artifactExpiresAt, now))).limit(limit);
  if (due.length === 0) return 0;
  for (const j of due) fs.rmSync(artifactPath(j.name!), { force: true }); // idempotent: a file already gone is fine
  const actor = await ensureServicePrincipal(db);
  await db.transaction(async (tx) => {
    for (const j of due) {
      await tx.update(jobs).set({ artifactPurgedAt: now }).where(and(eq(jobs.id, j.id), isNull(jobs.artifactPurgedAt)));
      await writeAudit(tx, actor, 'Delete', 'JobArtifact', j.id, 'artifact', `sha256=${j.sha}`, '', 'Scheduled: artifact retention (30 days)');
    }
  });
  return due.length;
}
