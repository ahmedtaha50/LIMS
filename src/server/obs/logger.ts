/**
 * The server logger: pino, one JSON object per line, credentials redacted before they are serialised.
 *  info and below go to stdout, warn and above to stderr, so a supervisor or service manager can tell them apart.
 * It has the same call shape as core/logger.ts (fields first, message second), which is what the rest of the server uses.
 */
import pino from 'pino';
import type { Writable } from 'stream';
import type { Logger } from '../core/logger';

/** Property names whose values never reach a log, at any depth up to four levels. */
const SECRET_KEYS = [
  'password', 'newPassword', 'currentPassword', 'passphrase', 'tempToken', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'totpSecret', 'totpCode', 'secret', 'jwtSecret', 'passwordHash', 'apiKey', 'privateKey',
];
const CASELESS = new Set(SECRET_KEYS.map(k => k.toLowerCase()));

const REDACT_PATHS = SECRET_KEYS.flatMap(k => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]);

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  stdout?: Writable | NodeJS.WriteStream;
  stderr?: Writable | NodeJS.WriteStream;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const streams = pino.multistream(
    [
      { level: 'debug', stream: opts.stdout ?? process.stdout },
      { level: 'warn', stream: opts.stderr ?? process.stderr },
    ],
    { dedupe: true },
  );
  return pino(
    {
      level: opts.level ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }), bindings: (b) => ({ pid: b.pid }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    streams,
  ) as unknown as Logger;
}

/**
 * Routes every call on the shared `log` object (core/logger.ts) through `impl`. The rest of the server imported that
 * object by reference, so patching its methods is enough; no call site changes.
 */
export function installLogger(target: Logger, impl: Logger): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    target[level] = (fields, msg) => impl[level](fields, msg);
  }
}

const KEY_VALUE = /((?:pass(?:word|phrase|wd)|pwd|secret|token|api[-_]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Free text (Node's own crash output, third-party library messages): mask what looks like a credential. */
export function redactText(text: string): string {
  return text.replace(BEARER, '$1[REDACTED]').replace(KEY_VALUE, '$1[REDACTED]');
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = CASELESS.has(k.toLowerCase()) ? '[REDACTED]' : redactDeep(v, depth + 1);
    return out;
  }
  return typeof value === 'string' ? redactText(value) : value;
}

/** One captured output line: a JSON object line is redacted by key, anything else as text. */
export function redactLine(line: string): string {
  if (line.startsWith('{')) {
    try { return JSON.stringify(redactDeep(JSON.parse(line))); } catch { /* not JSON after all */ }
  }
  return redactText(line);
}
