/**
 * Typed, fail-fast configuration (roadmap M02). One place that reads the environment variables the process shell needs,
 * validates them with Zod and turns them into a typed object. A malformed or missing required variable produces ONE
 * readable message (formatConfigError) and the entry point exits; nothing starts half-configured.
 *
 *  - NODE_ENV is production unless it says otherwise. Development has to be asked for; it is never the default.
 *  - The server binds loopback unless LIMS_BIND_LAN=1, and LAN mode needs a TLS certificate and key.
 *  - JWT_SECRET is required in production. Outside production a missing one is replaced by a random per-process
 *    secret, never by a fixed literal.
 *  - Secrets are never printed: describeConfig() redacts them and formatConfigError() does not echo their values.
 *
 * Other modules still read process.env directly (db, backup, ai); they are not changed here. Their variables
 * that matter for start-up are validated here so a typo is caught before the first request.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { parseAllowList } from './events/ssrf';

export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface RateLimitSettings {
  /** Backstop per client address (the desktop build serves every user from 127.0.0.1, so this is generous). */
  ipPerMinute: number;
  /** Per signed-in session. */
  userPerMinute: number;
  /** Failed logins per address, and per e-mail address, within authWindowMinutes. */
  authIpFailures: number;
  authEmailFailures: number;
  authWindowMinutes: number;
}

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  isDevelopment: boolean;
  host: string;
  port: number;
  bindLan: boolean;
  tls: { certFile: string; keyFile: string } | null;
  /** Number of reverse proxies in front of the server whose X-Forwarded-For may be trusted. 0 = none. */
  trustProxy: number;
  distDir: string;
  jwtSecret: string;
  /** True when jwtSecret was generated for this process because none was configured (not production). */
  jwtSecretGenerated: boolean;
  database: { host?: string; user?: string; password?: string; name?: string };
  logLevel: LogLevel;
  rateLimit: RateLimitSettings;
  backupDir: string | null;
  geminiApiKey: string | null;
  rabbitmqUrl: string | null;
}

/** Every variable this module reads. .env.example must document exactly these (tests/unit/shell/repo-hygiene.test.ts). */
export const ENV_VARIABLES: ReadonlyArray<{ name: string; secret?: boolean }> = [
  { name: 'NODE_ENV' },
  { name: 'HOST' },
  { name: 'PORT' },
  { name: 'LIMS_BIND_LAN' },
  { name: 'LIMS_TLS_CERT_FILE' },
  { name: 'LIMS_TLS_KEY_FILE' },
  { name: 'TRUST_PROXY' },
  { name: 'DIST_DIR' },
  { name: 'JWT_SECRET', secret: true },
  { name: 'SQL_HOST' },
  { name: 'SQL_USER' },
  { name: 'SQL_PASSWORD', secret: true },
  { name: 'SQL_DB_NAME' },
  { name: 'LOG_LEVEL' },
  { name: 'RATE_LIMIT_IP_PER_MINUTE' },
  { name: 'RATE_LIMIT_USER_PER_MINUTE' },
  { name: 'RATE_LIMIT_AUTH_IP_FAILURES' },
  { name: 'RATE_LIMIT_AUTH_EMAIL_FAILURES' },
  { name: 'BACKUP_DIR' },
  { name: 'BACKUP_MIRROR_DIR' },
  { name: 'BACKUP_PASSPHRASE', secret: true },
  { name: 'BACKUP_PASSPHRASE_FILE' },
  { name: 'BACKUP_RETENTION' },
  { name: 'BACKUP_CRON' },
  { name: 'ARTIFACT_DIR' },
  { name: 'BLOB_DIR' },
  { name: 'ARCHIVE_DIR' },
  { name: 'ATTACHMENT_MAX_BYTES' },
  { name: 'INSTRUMENT_AGENT' },
  { name: 'INSTRUMENT_POLL_MS' },
  { name: 'QUEUE_DRIVER' },
  { name: 'EVENTS_WEBHOOK_ALLOWLIST' },
  { name: 'EVENTS_DROP_DIR' },
  { name: 'EVENTS_SMTP_HOST' },
  { name: 'EVENTS_SMTP_PORT' },
  { name: 'EVENTS_SMTP_SECURITY' },
  { name: 'EVENTS_SMTP_FROM' },
  { name: 'EVENTS_SMTP_USER' },
  { name: 'EVENTS_SMTP_PASSWORD', secret: true },
  { name: 'GEMINI_API_KEY', secret: true },
  { name: 'RABBITMQ_URL', secret: true },
];
const SECRET_NAMES = new Set(ENV_VARIABLES.filter(v => v.secret).map(v => v.name));

/** The fixed secret older builds fell back to. Anyone who read the source can forge a token with it. */
const LEGACY_PUBLIC_SECRET = 'dev-only-insecure-jwt-secret';
const MIN_SECRET_LENGTH = 32;
/**
 * LAN mode needs an HTTPS listener, and the only place that creates the listener is server.ts (r1-core's file; see
 * docs/changes/r1-build-shell.md, "needs from other tracks"). Until it passes config.tls to https.createServer this
 * stays false and LIMS_BIND_LAN is refused at start-up: a setting that suggests TLS must not run without it.
 */
const LAN_LISTENER_WIRED = false;
const LOOPBACK = (h: string) => h === 'localhost' || h === '::1' || /^127\./.test(h);

export class ConfigError extends Error {
  constructor(readonly issues: string[], readonly offending: Record<string, string | undefined> = {}) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const whole = (min: number, max: number) =>
  z.string().regex(/^\d+$/, { error: 'must be a whole number' }).transform(Number)
    .refine(n => n >= min && n <= max, { error: `must be between ${min} and ${max}` });
const flag = z.stringbool({ error: 'must be 1 or 0 (true or false)' });
const text = z.string().min(1);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test'], { error: 'must be development, production or test' }).optional(),
  HOST: text.optional(),
  PORT: whole(1, 65535).optional(),
  LIMS_BIND_LAN: flag.optional(),
  LIMS_TLS_CERT_FILE: text.optional(),
  LIMS_TLS_KEY_FILE: text.optional(),
  TRUST_PROXY: whole(0, 10).optional(),
  DIST_DIR: text.optional(),
  JWT_SECRET: text.optional(),
  SQL_HOST: text.optional(),
  SQL_USER: text.optional(),
  SQL_PASSWORD: text.optional(),
  SQL_DB_NAME: text.optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent'], { error: 'must be debug, info, warn, error or silent' }).optional(),
  RATE_LIMIT_IP_PER_MINUTE: whole(1, 1_000_000).optional(),
  RATE_LIMIT_USER_PER_MINUTE: whole(1, 1_000_000).optional(),
  RATE_LIMIT_AUTH_IP_FAILURES: whole(1, 10_000).optional(),
  RATE_LIMIT_AUTH_EMAIL_FAILURES: whole(1, 10_000).optional(),
  BACKUP_DIR: text.optional(),
  BACKUP_MIRROR_DIR: text.optional(),
  BACKUP_PASSPHRASE: z.string().min(12, { error: 'must be at least 12 characters' }).optional(),
  BACKUP_PASSPHRASE_FILE: text.optional(),
  BACKUP_RETENTION: z.string().regex(/^\d+\/\d+\/\d+$/, { error: 'must be the daily/weekly/monthly counts, such as 7/4/12' }).optional(),
  BACKUP_CRON: z.string().regex(/^\S+(\s+\S+){4}$/, { error: 'must be a cron expression with five fields, such as 0 2 * * *' }).optional(),
  ARTIFACT_DIR: text.optional(),
  BLOB_DIR: text.optional(),
  ARCHIVE_DIR: text.optional(),
  ATTACHMENT_MAX_BYTES: whole(1, 1024 * 1024 * 1024).optional(),
  INSTRUMENT_AGENT: z.enum(['on', 'off'], { error: 'must be on or off' }).optional(),
  INSTRUMENT_POLL_MS: whole(500, 3_600_000).optional(),
  QUEUE_DRIVER: z.enum(['pg', 'amqp'], { error: 'must be pg or amqp' }).optional(),
  // Outbound events (r2-events, roadmap M23): see src/server/events/ssrf.ts and sinks/.
  EVENTS_WEBHOOK_ALLOWLIST: z.string().refine(v => { try { parseAllowList(v); return true; } catch { return false; } },
    { error: 'must be a comma separated list of IP addresses and CIDR ranges, such as 10.0.0.0/8,192.168.1.20' }).optional(),
  EVENTS_DROP_DIR: text.optional(),
  EVENTS_SMTP_HOST: text.optional(),
  EVENTS_SMTP_PORT: whole(1, 65535).optional(),
  EVENTS_SMTP_SECURITY: z.enum(['starttls', 'tls', 'none'], { error: 'must be starttls, tls or none' }).optional(),
  EVENTS_SMTP_FROM: z.string().regex(/^[^\s@]+@[^\s@]+$/, { error: 'must be an e-mail address' }).optional(),
  EVENTS_SMTP_USER: text.optional(),
  EVENTS_SMTP_PASSWORD: text.optional(),
  GEMINI_API_KEY: text.optional(),
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, { error: 'must be an amqp:// or amqps:// URL' }).optional(),
});

/** Pure: reads the given environment object (default process.env), touches nothing. Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  // An empty variable counts as unset (Windows shells and .env files leave empty values behind).
  const raw: Record<string, string> = {};
  for (const { name } of ENV_VARIABLES) {
    const v = env[name];
    if (typeof v === 'string' && v.trim() !== '') raw[name] = v.trim();
  }

  const issues: string[] = [];
  const offending: Record<string, string | undefined> = {};
  const fail = (name: string, message: string) => {
    issues.push(`${name}: ${message}${SECRET_NAMES.has(name) || raw[name] === undefined ? '' : ` (got "${raw[name]}")`}`);
    offending[name] = SECRET_NAMES.has(name) ? undefined : raw[name];
  };

  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fail(String(issue.path[0] ?? 'environment'), issue.message);
    throw new ConfigError(issues, offending);
  }
  const e = parsed.data;

  const nodeEnv: NodeEnv = e.NODE_ENV ?? 'production';
  const production = nodeEnv === 'production';

  // --- secrets ---------------------------------------------------------------------------------------------
  let jwtSecret = e.JWT_SECRET;
  let jwtSecretGenerated = false;
  if (jwtSecret === LEGACY_PUBLIC_SECRET) fail('JWT_SECRET', 'this is the publicly known development secret; set a random value');
  else if (!jwtSecret && production) fail('JWT_SECRET', `is required in production (random, at least ${MIN_SECRET_LENGTH} characters)`);
  else if (jwtSecret && production && jwtSecret.length < MIN_SECRET_LENGTH) fail('JWT_SECRET', `must be at least ${MIN_SECRET_LENGTH} characters in production`);
  if (!jwtSecret && !production) { jwtSecret = randomBytes(32).toString('hex'); jwtSecretGenerated = true; }

  if (production) {
    for (const name of ['SQL_HOST', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DB_NAME'] as const) {
      if (!e[name]) fail(name, 'is required in production');
    }
  }

  // --- network exposure ------------------------------------------------------------------------------------
  const bindLan = e.LIMS_BIND_LAN ?? false;
  const host = e.HOST ?? (bindLan ? '0.0.0.0' : '127.0.0.1');
  if (nodeEnv !== 'test' && !bindLan && !LOOPBACK(host)) {
    fail('HOST', `"${host}" is not a loopback address; the server only listens on this PC unless LIMS_BIND_LAN=1 is set (which also needs LIMS_TLS_CERT_FILE and LIMS_TLS_KEY_FILE)`);
  }
  let tls: Config['tls'] = null;
  if (bindLan) {
    for (const name of ['LIMS_TLS_CERT_FILE', 'LIMS_TLS_KEY_FILE'] as const) {
      const file = e[name];
      if (!file) { fail(name, 'is required when LIMS_BIND_LAN=1 (the LAN must not carry credentials in clear text)'); continue; }
      try { fs.accessSync(file, fs.constants.R_OK); } catch { fail(name, `file is not readable: ${file}`); }
    }
    if (e.LIMS_TLS_CERT_FILE && e.LIMS_TLS_KEY_FILE) tls = { certFile: e.LIMS_TLS_CERT_FILE, keyFile: e.LIMS_TLS_KEY_FILE };
    if (!LAN_LISTENER_WIRED) fail('LIMS_BIND_LAN', 'LAN mode is not available in this build: the HTTPS listener is not wired into server.ts yet, so the server only serves this PC');
  }

  if (issues.length) throw new ConfigError(issues, offending);

  return {
    nodeEnv,
    isProduction: production,
    isDevelopment: nodeEnv === 'development',
    host,
    port: e.PORT ?? 3000,
    bindLan,
    tls,
    trustProxy: e.TRUST_PROXY ?? 0,
    distDir: e.DIST_DIR ?? path.join(process.cwd(), 'dist'),
    jwtSecret: jwtSecret!,
    jwtSecretGenerated,
    database: { host: e.SQL_HOST, user: e.SQL_USER, password: e.SQL_PASSWORD, name: e.SQL_DB_NAME },
    logLevel: e.LOG_LEVEL ?? 'info',
    rateLimit: {
      ipPerMinute: e.RATE_LIMIT_IP_PER_MINUTE ?? 3000,
      userPerMinute: e.RATE_LIMIT_USER_PER_MINUTE ?? 600,
      authIpFailures: e.RATE_LIMIT_AUTH_IP_FAILURES ?? 20,
      authEmailFailures: e.RATE_LIMIT_AUTH_EMAIL_FAILURES ?? 10,
      authWindowMinutes: 15,
    },
    backupDir: e.BACKUP_DIR ?? null,
    geminiApiKey: e.GEMINI_API_KEY ?? null,
    rabbitmqUrl: e.RABBITMQ_URL ?? null,
  };
}

let cached: Config | undefined;
/** The process-wide configuration, loaded on first use. Throws ConfigError. */
export function getConfig(): Config {
  return (cached ??= loadConfig());
}

/** Safe to log: every secret replaced. */
export function describeConfig(c: Config): Record<string, unknown> {
  const R = '[REDACTED]';
  return {
    nodeEnv: c.nodeEnv, host: c.host, port: c.port, bindLan: c.bindLan, tls: c.tls ? { certFile: c.tls.certFile, keyFile: c.tls.keyFile } : null,
    trustProxy: c.trustProxy, distDir: c.distDir, logLevel: c.logLevel, rateLimit: c.rateLimit, backupDir: c.backupDir,
    jwtSecret: R, jwtSecretGenerated: c.jwtSecretGenerated,
    database: { host: c.database.host, user: c.database.user, name: c.database.name, password: c.database.password ? R : undefined },
    geminiApiKey: c.geminiApiKey ? R : null, rabbitmqUrl: c.rabbitmqUrl ? R : null,
  };
}

/** The text an operator sees on stderr: no stack, no secret values. */
export function formatConfigError(err: ConfigError): string {
  return [
    'B-Pharma LIMS cannot start: invalid configuration.',
    ...err.issues.map(i => `  - ${i}`),
    'Correct the variables above and start again (see .env.example).',
  ].join('\n');
}

/**
 * Makes the values the legacy code reads straight from process.env agree with the validated configuration
 * (server.ts reads PORT and HOST, core/auth.ts reads NODE_ENV and JWT_SECRET). Called once by the entry point.
 */
export function applyConfigToEnv(c: Config, env: NodeJS.ProcessEnv = process.env): void {
  env.NODE_ENV = c.nodeEnv;
  env.HOST = c.host;
  env.PORT = String(c.port);
  env.JWT_SECRET = c.jwtSecret;
}
