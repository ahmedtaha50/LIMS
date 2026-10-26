/**
 * First code that runs in the server process (see entry.ts). Order matters:
 *  1. validate the configuration; on failure print one readable message and exit before anything is loaded
 *  2. make process.env agree with it (NODE_ENV, HOST, PORT, JWT_SECRET are read straight from process.env by older code)
 *  3. route the shared logger through pino with redaction
 * Only after this does the application module (server.ts and everything it imports) get loaded.
 */
import fs from 'fs';
import { applyConfigToEnv, ConfigError, describeConfig, formatConfigError, getConfig, type Config } from '../config';
import { log } from '../core/logger';
import { createLogger, installLogger } from './logger';

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaced in tests. */
  exit?: (code: number) => never;
}

export function bootstrap({ env = process.env, exit = (code) => process.exit(code) }: BootstrapOptions = {}): Config {
  let config: Config;
  try {
    config = getConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    fs.writeSync(2, formatConfigError(err) + '\n'); // synchronous: the message must be out before the process is
    return exit(1);
  }
  applyConfigToEnv(config, env);
  installLogger(log, createLogger({ level: config.logLevel }));
  log.info({ config: describeConfig(config) }, 'configuration loaded');
  if (config.jwtSecretGenerated) log.warn({}, 'JWT_SECRET is not set: this process uses a random secret, so sessions end when it restarts');
  return config;
}
