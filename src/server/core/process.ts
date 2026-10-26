import { log as defaultLog, serializeError, type Logger } from './logger';

export interface ProcessHandlerOptions {
  proc?: Pick<NodeJS.Process, 'on' | 'off'>;
  exit?: (code: number) => void;
  log?: Logger;
  /** Called once on an uncaught exception, before exiting: stop accepting connections, flush, and so on. */
  onFatal?: () => void | Promise<void>;
  /** Grace period between logging and exiting, so the log line reaches the disk. */
  exitDelayMs?: number;
}

/**
 * Process-level safety net.
 *  - unhandledRejection: logged, the process keeps running. Request handlers cannot cause one any more (asyncHandler);
 *    what remains is background work, and one failed background promise must not take down a lab's server mid-run.
 *  - uncaughtException: logged, onFatal runs, then the process exits with code 1. After an uncaught exception the
 *    process state is unknown, so continuing could write wrong data; the supervisor restarts it.
 * Returns a function that removes the handlers (used by tests).
 */
export function installProcessHandlers(opts: ProcessHandlerOptions = {}): () => void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? defaultLog;

  const onRejection = (reason: unknown) => {
    log.error({ err: serializeError(reason) }, 'unhandled promise rejection');
  };
  const onException = (err: unknown) => {
    log.error({ err: serializeError(err) }, 'uncaught exception, shutting down');
    let pending: void | Promise<void> = undefined;
    try { pending = opts.onFatal?.(); } catch (e) { log.error({ err: serializeError(e) }, 'shutdown hook failed'); }
    Promise.resolve(pending)
      .catch(e => log.error({ err: serializeError(e) }, 'shutdown hook failed'))
      .finally(() => setTimeout(() => exit(1), opts.exitDelayMs ?? 200));
  };

  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
