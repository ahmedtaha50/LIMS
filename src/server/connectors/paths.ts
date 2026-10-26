// Where the folder agent may read (roadmap M21). A watch folder is configuration that QA approves, but the server still refuses
// the places it must never read from or write into (it creates processed/ and error/ there, and moves files).
import fs from 'fs';
import path from 'path';
import { blobDir } from '../blobs';

export const GLOB_PATTERN = /^[A-Za-z0-9._ \-*?]{1,100}$/;

/** A file-name pattern with * and ? only, matched against a plain file name (no folder). */
export function globToRegExp(glob: string): RegExp {
  if (!GLOB_PATTERN.test(glob)) throw new Error(`Not a valid file-name pattern: ${glob}`);
  const body = glob.replace(/[.\-\s]/g, c => `\\${c}`).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`, 'i');
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The folders the agent never uses: the blob store and the backup folder. */
function forbiddenRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [blobDir(env), env.BACKUP_DIR || path.join(process.cwd(), 'backups')].map(d => path.resolve(d));
}

/** Syntax check of a configured folder (no file system access): an absolute path, no NUL byte, no ".." segment, not a forbidden root. */
export function watchDirProblem(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (dir.includes('\u0000')) return 'The folder contains a NUL byte.';
  if (!path.isAbsolute(dir)) return 'The folder must be an absolute path.';
  if (dir.split(/[\\/]+/).includes('..')) return 'The folder must not contain ".." segments.';
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return 'The root of a drive cannot be a watch folder.';
  for (const f of forbiddenRoots(env)) if (inside(resolved, f) || inside(f, resolved)) return `The folder overlaps ${f}, which the system uses for its own files.`;
  return null;
}

/** The canonical (symlink-free) path of a watch folder, or the reason it cannot be used. */
export async function canonicalWatchDir(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; dir: string } | { ok: false; problem: string }> {
  const syntax = watchDirProblem(dir, env);
  if (syntax) return { ok: false, problem: syntax };
  let real: string;
  try { real = await fs.promises.realpath(dir); } catch (e: any) { return { ok: false, problem: `The folder cannot be opened (${e?.code ?? 'error'}).` }; }
  const stat = await fs.promises.stat(real);
  if (!stat.isDirectory()) return { ok: false, problem: 'The path is not a folder.' };
  for (const f of forbiddenRoots(env)) {
    const fr = await fs.promises.realpath(f).catch(() => f);
    if (inside(real, fr) || inside(fr, real)) return { ok: false, problem: `The folder overlaps ${f}, which the system uses for its own files.` };
  }
  return { ok: true, dir: real };
}
