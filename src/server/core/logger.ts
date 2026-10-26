/**
 * Minimal structured logger: one JSON object per line, errors and warnings on stderr.
 * LOG_LEVEL=debug|info|warn|error|silent (default info). The interface is deliberately the
 * pino shape (fields first, message second) so the observability layer can swap the implementation.
 */
export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

/** An Error (or any thrown value) as plain data: never throws, never includes request bodies. */
export function serializeError(err: unknown): { name?: string; message: string; code?: unknown; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, code: (err as any).code, stack: err.stack };
  return { message: typeof err === 'string' ? err : JSON.stringify(err) ?? String(err) };
}

function make(level: keyof typeof LEVELS): (fields: Record<string, unknown>, msg: string) => void {
  return (fields, msg) => {
    const configured = LEVELS[(process.env.LOG_LEVEL as keyof typeof LEVELS) || 'info'] ?? LEVELS.info;
    if (LEVELS[level] < configured) return;
    const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
}

export const log: Logger = { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
