/**
 * The file sink (roadmap M23): one JSON file per event in a folder under the drop directory (EVENTS_DROP_DIR), for an ERP or any
 * system that reads a folder. The file is written under a temporary name in the same folder, flushed to disk and then renamed to
 * <event id>.json, so a reader never sees a half-written file; a retry after a crash writes the same name with the same content.
 * The folder is a single name (no separator, no "..") so a subscription cannot write outside the drop directory.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SinkOutcome } from './types';

const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const dropDirOf = (env: NodeJS.ProcessEnv = process.env): string | null => (env.EVENTS_DROP_DIR?.trim() ? path.resolve(env.EVENTS_DROP_DIR.trim()) : null);

/** A problem with `folder` as a file-sink target, or null when it is usable. */
export function fileTargetProblem(folder: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!dropDirOf(env)) return 'File delivery is not configured on this server (EVENTS_DROP_DIR is not set).';
  if (!FOLDER.test(folder) || folder.includes('..')) return 'The folder must be one name of letters, digits, ".", "_" or "-" (at most 64), inside the drop directory.';
  return null;
}

export async function deliverFile(input: { folder: string; eventId: string; body: string }, env: NodeJS.ProcessEnv = process.env): Promise<SinkOutcome> {
  const problem = fileTargetProblem(input.folder, env);
  if (problem) return { ok: false, error: problem };
  const dir = path.join(dropDirOf(env)!, input.folder);
  const final = path.join(dir, `${input.eventId}.json`);
  const temp = path.join(dir, `.${input.eventId}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const handle = await fs.promises.open(temp, 'wx', 0o640);
    try { await handle.writeFile(input.body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(temp, final);
    return { ok: true };
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    return { ok: false, error: `The file could not be written: ${(err as Error).message}` };
  }
}
