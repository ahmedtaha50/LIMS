import fs from 'fs';
import path from 'path';

/** Replaced with the package version by the server bundle (scripts/build-server.cjs `define`); undefined when running from source. */
declare const __APP_VERSION__: string | undefined;

let cached: string | undefined;

/**
 * The application version recorded in the migration journal and shown by GET /api/system/info.
 * APP_VERSION (set by the installer or CI) wins; then the version baked into the bundle; then package.json in the working
 * directory (the desktop shell runs the server from the application folder, which contains package.json); else "unknown".
 */
export function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  if (typeof __APP_VERSION__ === 'string') return __APP_VERSION__;
  if (cached === undefined) {
    try {
      cached = String(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || 'unknown');
    } catch {
      cached = 'unknown';
    }
  }
  return cached;
}
