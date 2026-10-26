// Where the blob store lives and how large one file may be (roadmap M20). Read at each use, like jobs/artifacts.ts, so a test or the
// desktop shell can point it elsewhere. Both variables are declared in src/server/config.ts.
import path from 'path';

/** 50 MiB: a chromatography data file or a scanned worksheet fits; a disk image does not. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** BLOB_DIR, else a `blobs` folder next to the backups folder (the desktop shell puts BACKUP_DIR in the user's data folder). */
export function blobDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOB_DIR || path.join(path.dirname(env.BACKUP_DIR || path.join(process.cwd(), 'backups')), 'blobs');
}

/** ATTACHMENT_MAX_BYTES (a whole number of bytes), else 50 MiB. A value that is not a positive whole number is a configuration error. */
export function maxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATTACHMENT_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_ATTACHMENT_BYTES;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`ATTACHMENT_MAX_BYTES must be a positive whole number of bytes, not "${raw}".`);
  return Number(raw);
}
