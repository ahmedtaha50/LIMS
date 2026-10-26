// The folder agent (roadmap M21): the part of the server that watches the folders instruments export into.
//
// For every Approved capture profile it reads ONLY the canonicalised configured folder (realpath; files directly in it, no
// sub-folders, no symbolic links, nothing that resolves outside it), takes the files whose name matches the profile's pattern and that
// have stopped changing, and hands them to ingestFile (./ingest.ts), which hashes them into the blob store and registers them.
//   - registered and read:   the file is moved to processed/ AFTER the transaction committed, and its disposition recorded;
//   - not readable, refused:  moved to error/ with <name>.reason.txt beside it; the analysts are notified (event
//                             instrument.import_failed); the raw file is in the store either way;
//   - identical content seen before: refused and audited, moved to error/. If the earlier capture never got its move (the server
//                             stopped between commit and move) the leftover is finished instead: it goes to processed/.
// fs.watch wakes the scan at once; a poll (INSTRUMENT_POLL_MS, default 5 s) is the fallback where watching is unreliable (network
// shares, some virtual machines), and the first scan at start-up picks up whatever arrived while the server was down. The agent acts
// as the service principal (jobs/principal.ts): the file is attributed to the profile, whose mapping a named person approved.
// INSTRUMENT_AGENT=off disables it.
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { instrumentProfiles } from '../../db/schema';
import type { Db } from '../core/context';
import { ensureServicePrincipal } from '../jobs/principal';
import { canonicalWatchDir, globToRegExp } from './paths';
import { ingestFile, markDisposition } from './ingest';

type Profile = typeof instrumentProfiles.$inferSelect;

export interface FolderAgentOptions {
  /** Poll interval in ms (INSTRUMENT_POLL_MS, default 5000). */
  pollMs?: number;
  /** A file modified less than this long ago is still being written and is left for the next scan (default 1000). */
  settleMs?: number;
  /** Scan once at start (default true): picks up what arrived while the server was down. */
  initialScan?: boolean;
  log?: (message: string) => void;
}

export interface ScanSummary { captured: number; failed: number; duplicates: number; skipped: number }

const TEMP_NAME = /(^\.|\.(part|tmp|crdownload|filepart)$|~$)/i;

async function moveFile(from: string, toDir: string, name: string): Promise<string> {
  await fs.promises.mkdir(toDir, { recursive: true });
  let target = path.join(toDir, name);
  if (await fs.promises.access(target).then(() => true, () => false)) {
    const ext = path.extname(name);
    target = path.join(toDir, `${path.basename(name, ext)}-${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
  }
  try {
    await fs.promises.rename(from, target);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(from, target, fs.constants.COPYFILE_EXCL);
    await fs.promises.unlink(from);
  }
  return target;
}

export async function scanProfile(db: Db, profile: Profile, actorId: string, opts: { settleMs: number; now?: number; log: (m: string) => void }): Promise<ScanSummary> {
  const out: ScanSummary = { captured: 0, failed: 0, duplicates: 0, skipped: 0 };
  const canon = await canonicalWatchDir(profile.watchDir);
  if (!canon.ok) { opts.log(`WARN instrument profile ${profile.id}: ${canon.problem}`); return out; }
  const root = canon.dir;
  const pattern = globToRegExp(profile.glob);
  let names: string[];
  try { names = (await fs.promises.readdir(root)).sort(); } catch (e: any) { opts.log(`WARN instrument profile ${profile.id}: ${e?.code ?? e}`); return out; }

  for (const name of names) {
    if (TEMP_NAME.test(name) || !pattern.test(name)) continue;
    const full = path.join(root, name);
    const lst = await fs.promises.lstat(full).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isFile()) continue;
    if ((opts.now ?? Date.now()) - lst.mtimeMs < opts.settleMs) { out.skipped++; continue; }
    if (path.dirname(await fs.promises.realpath(full).catch(() => '')) !== root) continue;

    try {
      const outcome = await ingestFile(db, {
        profileId: profile.id, fileName: name, source: 'watch', content: fs.createReadStream(full), actorId, finalDisposition: false,
      });
      if (outcome.status === 'Captured') {
        await moveFile(full, path.join(root, 'processed'), name);
        await markDisposition(db, outcome.file.id, actorId, 'Processed', `Moved to processed/ after capture of ${outcome.rowCount} value(s).`);
        out.captured++;
      } else if (outcome.status === 'Failed') {
        const target = await moveFile(full, path.join(root, 'error'), name);
        await fs.promises.writeFile(`${target}.reason.txt`, `${outcome.message}\n`, 'utf8');
        await markDisposition(db, outcome.file.id, actorId, 'Error', `Moved to error/: ${outcome.message}`);
        out.failed++;
      } else {
        const earlier = outcome.existing;
        if (earlier.disposition === 'Pending' && earlier.profileId === profile.id) {
          // The earlier capture committed but its move never happened: finish it rather than call the file a duplicate.
          const ok = earlier.parseStatus === 'Parsed';
          await moveFile(full, path.join(root, ok ? 'processed' : 'error'), name);
          await markDisposition(db, earlier.id, actorId, ok ? 'Processed' : 'Error', 'Move completed after a restart.');
          out.captured += ok ? 1 : 0; out.failed += ok ? 0 : 1;
        } else {
          const target = await moveFile(full, path.join(root, 'error'), name);
          await fs.promises.writeFile(`${target}.reason.txt`, `Duplicate: identical content was already captured as ${earlier.id} (${earlier.fileName}).\n`, 'utf8');
          out.duplicates++;
        }
      }
    } catch (e: any) {
      // Left in place: the next scan tries again (nothing was registered unless the transaction committed).
      opts.log(`ERROR instrument profile ${profile.id}, file ${name}: ${e?.message ?? e}`);
    }
  }
  return out;
}

export interface FolderAgent {
  /** One pass over every approved profile (also what the timer and fs.watch run). Passes never overlap. */
  scanOnce(): Promise<ScanSummary>;
  stop(): Promise<void>;
}

export function startFolderAgent(db: Db, o: FolderAgentOptions = {}): FolderAgent {
  const log = o.log ?? ((m: string) => console.log(m));
  const pollMs = o.pollMs ?? (Number(process.env.INSTRUMENT_POLL_MS) || 5000);
  const settleMs = o.settleMs ?? 1000;
  const watchers = new Map<string, fs.FSWatcher>();
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();
  let debounce: NodeJS.Timeout | null = null;

  const syncWatchers = async (profiles: Profile[]) => {
    const wanted = new Map<string, string>();
    for (const p of profiles) {
      const c = await canonicalWatchDir(p.watchDir);
      if (c.ok) wanted.set(c.dir, c.dir);
    }
    for (const [dir, w] of watchers) if (!wanted.has(dir)) { w.close(); watchers.delete(dir); }
    for (const dir of wanted.keys()) {
      if (watchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, () => {
          if (stopped) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => { void scanOnce().catch(e => log(`ERROR instrument folder agent: ${e?.message ?? e}`)); }, settleMs + 150);
          debounce.unref?.();
        });
        w.on('error', () => { w.close(); watchers.delete(dir); }); // the poll still covers this folder
        watchers.set(dir, w);
      } catch { /* watching is an accelerator; the poll is the guarantee */ }
    }
  };

  const run = async (): Promise<ScanSummary> => {
    const total: ScanSummary = { captured: 0, failed: 0, duplicates: 0, skipped: 0 };
    if (stopped) return total;
    const profiles = await db.select().from(instrumentProfiles).where(eq(instrumentProfiles.status, 'Approved'));
    await syncWatchers(profiles);
    const actorId = await ensureServicePrincipal(db);
    for (const p of profiles) {
      const s = await scanProfile(db, p, actorId, { settleMs, log });
      total.captured += s.captured; total.failed += s.failed; total.duplicates += s.duplicates; total.skipped += s.skipped;
    }
    return total;
  };
  const scanOnce = () => {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next as Promise<ScanSummary>;
  };

  const timer = setInterval(() => { void scanOnce().catch(e => log(`ERROR instrument folder agent: ${e?.message ?? e}`)); }, pollMs);
  timer.unref?.();
  if (o.initialScan !== false) void scanOnce().catch(e => log(`ERROR instrument folder agent (start-up scan): ${e?.message ?? e}`));

  return {
    scanOnce,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      await chain;
    },
  };
}

export const agentEnabled = (env: NodeJS.ProcessEnv = process.env) => (env.INSTRUMENT_AGENT ?? '').toLowerCase() !== 'off';
