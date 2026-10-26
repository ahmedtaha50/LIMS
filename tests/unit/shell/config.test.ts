/**
 * M02: typed, fail-fast configuration. Pure function of an environment object; secrets never appear in messages.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, formatConfigError, loadConfig } from '../../../src/server/config';

const SQL = { SQL_HOST: '127.0.0.1', SQL_USER: 'lims', SQL_PASSWORD: 'db-password-123', SQL_DB_NAME: 'lims' };
const PROD = { NODE_ENV: 'production', JWT_SECRET: 's'.repeat(48), ...SQL };

const issuesOf = (env: Record<string, string>) => {
  try { loadConfig(env); } catch (e) { if (e instanceof ConfigError) return e.issues; throw e; }
  return [];
};

describe('loadConfig', () => {
  it('is production when NODE_ENV is unset or empty', () => {
    expect(loadConfig({ JWT_SECRET: PROD.JWT_SECRET, ...SQL }).nodeEnv).toBe('production');
    expect(loadConfig({ NODE_ENV: '', JWT_SECRET: PROD.JWT_SECRET, ...SQL }).nodeEnv).toBe('production');
  });

  it('is development only when asked, and then needs no secret but never uses a fixed one', () => {
    const a = loadConfig({ NODE_ENV: 'development' });
    const b = loadConfig({ NODE_ENV: 'development' });
    expect(a.nodeEnv).toBe('development');
    expect(a.jwtSecret).toHaveLength(64);
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
    expect(a.jwtSecret).not.toContain('dev-only');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(issuesOf({ ...PROD, NODE_ENV: 'staging' }).join('\n')).toMatch(/NODE_ENV/);
  });

  it('requires a strong JWT secret in production and refuses the old public one', () => {
    expect(issuesOf({ NODE_ENV: 'production', ...SQL }).join('\n')).toMatch(/JWT_SECRET/);
    expect(issuesOf({ ...PROD, JWT_SECRET: 'short' }).join('\n')).toMatch(/JWT_SECRET.*32/);
    expect(issuesOf({ ...PROD, JWT_SECRET: 'dev-only-insecure-jwt-secret' }).join('\n')).toMatch(/JWT_SECRET/);
  });

  it('requires the database settings in production', () => {
    const issues = issuesOf({ NODE_ENV: 'production', JWT_SECRET: PROD.JWT_SECRET }).join('\n');
    for (const k of ['SQL_HOST', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DB_NAME']) expect(issues).toContain(k);
  });

  it('reports every malformed variable at once, by name', () => {
    const issues = issuesOf({ ...PROD, PORT: 'abc', LOG_LEVEL: 'loud', TRUST_PROXY: '-1', RATE_LIMIT_USER_PER_MINUTE: '0' }).join('\n');
    for (const k of ['PORT', 'LOG_LEVEL', 'TRUST_PROXY', 'RATE_LIMIT_USER_PER_MINUTE']) expect(issues).toContain(k);
  });

  it('binds loopback by default and refuses a LAN address without LIMS_BIND_LAN', () => {
    expect(loadConfig(PROD).host).toBe('127.0.0.1');
    expect(loadConfig({ ...PROD, HOST: 'localhost' }).host).toBe('localhost');
    expect(issuesOf({ ...PROD, HOST: '0.0.0.0' }).join('\n')).toMatch(/HOST.*LIMS_BIND_LAN/);
  });

  it('validates the LAN settings (TLS certificate and key), and refuses LAN mode until the HTTPS listener is wired', () => {
    expect(issuesOf({ ...PROD, LIMS_BIND_LAN: '1' }).join('\n')).toMatch(/LIMS_TLS_CERT_FILE/);
    expect(issuesOf({ ...PROD, LIMS_BIND_LAN: '1', LIMS_TLS_CERT_FILE: '/nonexistent/c.pem', LIMS_TLS_KEY_FILE: '/nonexistent/k.pem' }).join('\n')).toMatch(/not readable/);
    expect(issuesOf({ ...PROD, LIMS_BIND_LAN: 'maybe' }).join('\n')).toMatch(/LIMS_BIND_LAN/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-tls-'));
    fs.writeFileSync(path.join(dir, 'c.pem'), 'x'); fs.writeFileSync(path.join(dir, 'k.pem'), 'x');
    const issues = issuesOf({ ...PROD, LIMS_BIND_LAN: '1', LIMS_TLS_CERT_FILE: path.join(dir, 'c.pem'), LIMS_TLS_KEY_FILE: path.join(dir, 'k.pem') });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(issues.join('\n')).toMatch(/LIMS_BIND_LAN.*not available/);
    expect(issues.join('\n')).not.toMatch(/not readable|is required/); // the TLS files themselves are fine
  });

  it('has a default port and accepts a valid one', () => {
    expect(loadConfig(PROD).port).toBe(3000);
    expect(loadConfig({ ...PROD, PORT: '3102' }).port).toBe(3102);
    expect(issuesOf({ ...PROD, PORT: '70000' }).join('\n')).toMatch(/PORT/);
  });
});

describe('describeConfig and formatConfigError', () => {
  it('never contains a secret', () => {
    const cfg = loadConfig({ ...PROD, GEMINI_API_KEY: 'gemini-key-xyz', RABBITMQ_URL: 'amqp://user:rabbit-pass@localhost' });
    const text = JSON.stringify(describeConfig(cfg));
    for (const secret of [PROD.JWT_SECRET, 'db-password-123', 'gemini-key-xyz', 'rabbit-pass']) expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('lims'); // non-secret values stay visible
  });

  it('prints one readable message that does not echo secret values', () => {
    try { loadConfig({ ...PROD, JWT_SECRET: 'tooshort', PORT: 'abc' }); } catch (e) {
      const text = formatConfigError(e as ConfigError);
      expect(text).toMatch(/invalid configuration/i);
      expect(text).toContain('PORT');
      expect(text).toContain('"abc"');
      expect(text).not.toContain('tooshort');
      expect(text).not.toMatch(/\n\s+at /);
      return;
    }
    throw new Error('expected a ConfigError');
  });
});
