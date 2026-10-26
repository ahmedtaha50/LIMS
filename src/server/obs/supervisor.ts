/**
 * Keeps the server child process alive and keeps its output.
 *  - the child's stdout and stderr are written, redacted, to <logDir>/server.log (rotating), so a crash leaves its
 *    stack trace behind even when the process died before its own logger could write it
 *  - an unexpected exit is followed by a restart after a back-off (first restart 0.5 s), recorded as a
 *    SERVER_RESTART event; the new child learns that it is a restart (LIMS_RESTART_COUNT, LIMS_LAST_EXIT)
 *  - a child that keeps failing right after start is given up on (SERVER_GAVE_UP) instead of restarting forever
 * Used by the Electron main process (desktop/main.cjs loads dist-server/supervisor.cjs).
 */
import { fork, type ChildProcess } from 'child_process';
import path from 'path';
import readline from 'readline';
import type { Readable } from 'stream';
import { redactLine } from './logger';
import { createRotatingFile } from './rotate';

export interface RestartEvent { attempt: number; restartCount: number; exitCode: number | null; signal: string | null; ranMs: number; backoffMs: number }
export interface GiveUpEvent { failures: number; exitCode: number | null; signal: string | null; ranMs: number }

export interface SuperviseOptions {
  /** Script the child runs (dist-server/server.cjs). */
  entry: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  logDir: string;
  /** Delay before restart attempt n (the last value repeats). Default 0.5, 1, 2, 4, 8 s: every restart starts within 10 s. */
  backoffMs?: number[];
  /** Consecutive early failures tolerated before giving up. Default 5. */
  maxRestarts?: number;
  /** A child that ran this long counts as healthy and clears the failure count. Default 60 s. */
  stableAfterMs?: number;
  maxLogBytes?: number;
  maxLogFiles?: number;
  onRestart?: (e: RestartEvent) => void;
  onGiveUp?: (e: GiveUpEvent) => void;
}

export interface Supervisor {
  /** The running child, or null while waiting to restart, after give-up, and after stop(). */
  readonly child: ChildProcess | null;
  /** Restarts since the supervisor started. */
  readonly restarts: number;
  stop(): Promise<void>;
}

export function superviseServer(o: SuperviseOptions): Supervisor {
  const backoffMs = o.backoffMs?.length ? o.backoffMs : [500, 1000, 2000, 4000, 8000];
  const maxRestarts = o.maxRestarts ?? 5;
  const stableAfterMs = o.stableAfterMs ?? 60_000;
  const file = createRotatingFile(path.join(o.logDir, 'server.log'), { maxBytes: o.maxLogBytes, maxFiles: o.maxLogFiles });

  let child: ChildProcess | null = null;
  let restarts = 0;
  let failures = 0;
  let stopped = false;
  let lastExit = '';
  let timer: NodeJS.Timeout | undefined;
  let startedAt = 0;

  const event = (level: 'info' | 'warn' | 'error', name: string, fields: Record<string, unknown>) =>
    file.write(JSON.stringify({ time: new Date().toISOString(), level, source: 'supervisor', event: name, ...fields }));

  const capture = (stream: Readable | null, name: 'stdout' | 'stderr') => {
    if (!stream) return;
    readline.createInterface({ input: stream }).on('line', (line) => {
      const clean = redactLine(line);
      file.write(clean.startsWith('{') ? clean : JSON.stringify({ time: new Date().toISOString(), level: name === 'stderr' ? 'error' : 'info', source: 'server-output', msg: clean }));
    });
  };

  const start = () => {
    startedAt = Date.now();
    const c = fork(o.entry, o.args ?? [], {
      cwd: o.cwd,
      execArgv: o.execArgv,
      silent: true,
      env: { ...process.env, ...o.env, LIMS_RESTART_COUNT: String(restarts), LIMS_LAST_EXIT: lastExit },
    });
    child = c;
    capture(c.stdout, 'stdout');
    capture(c.stderr, 'stderr');
    c.on('error', (err) => event('error', 'SERVER_SPAWN_ERROR', { message: err.message }));
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopped) return;
      const ranMs = Date.now() - startedAt;
      if (ranMs >= stableAfterMs) failures = 0;
      failures += 1;
      lastExit = signal ? `signal=${signal}` : `code=${code}`;
      if (failures > maxRestarts) {
        event('error', 'SERVER_GAVE_UP', { failures, exitCode: code, signal, ranMs });
        o.onGiveUp?.({ failures, exitCode: code, signal, ranMs });
        return;
      }
      const delay = backoffMs[Math.min(failures - 1, backoffMs.length - 1)];
      restarts += 1;
      const e: RestartEvent = { attempt: failures, restartCount: restarts, exitCode: code, signal, ranMs, backoffMs: delay };
      event('warn', 'SERVER_RESTART', { ...e });
      o.onRestart?.(e);
      timer = setTimeout(() => { if (!stopped) start(); }, delay);
    });
  };

  start();

  return {
    get child() { return child; },
    get restarts() { return restarts; },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const c = child;
      if (c && c.exitCode === null && c.signalCode === null) {
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => c.kill('SIGKILL'), 3000);
          c.once('exit', () => { clearTimeout(force); resolve(); });
          c.kill();
        });
      }
      // let the readline handlers flush the last lines before the file is closed
      await new Promise(r => setTimeout(r, 50));
      file.close();
    },
  };
}
