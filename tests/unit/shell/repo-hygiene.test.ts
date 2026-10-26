/**
 * M02: the repository root holds configuration only; no firebase; no Google-hosted fonts; one lockfile.
 */
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_VARIABLES } from '../../../src/server/config';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const script = path.join(ROOT, 'scripts', 'check-root-clean.sh');
const pkg = () => JSON.parse(read('package.json'));

describe('scripts/check-root-clean.sh', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  function fixtureRepo(files: Record<string, string>) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-root-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    for (const [f, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.writeFileSync(path.join(tmp, f), content);
    }
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    return tmp;
  }
  const check = (dir: string) => spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' });

  it('passes for a root with configuration files and scripts in subdirectories', () => {
    const r = check(fixtureRepo({ 'package.json': '{}', 'server.ts': '', 'vite.config.ts': '', 'vitest.config.ts': '', 'scripts/ok.cjs': '', 'src/a.ts': '' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('accepts the root configuration file of a tool that only reads it from the root (eslint.config.js)', () => {
    // eslint's flat config is looked up at the root only (r2-ui-foundation's accessibility lint); it is configuration, not a generator.
    const r = check(fixtureRepo({ 'package.json': '{}', 'eslint.config.js': 'export default [];', 'src/a.ts': '' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('fails and names every stray root script and the second lockfile', () => {
    const r = check(fixtureRepo({ 'package.json': '{}', 'patch-api.cjs': '', 'fix.js': '', 'tool.mjs': '', 'clear-audit.ts': '', 'bun.lock': '' }));
    expect(r.status).toBe(1);
    for (const f of ['patch-api.cjs', 'fix.js', 'tool.mjs', 'clear-audit.ts', 'bun.lock']) expect(r.stdout + r.stderr).toContain(f);
  });

  it('ignores a file that is still in the index but already deleted from disk', () => {
    const dir = fixtureRepo({ 'package.json': '{}', 'patch-api.cjs': '' });
    fs.rmSync(path.join(dir, 'patch-api.cjs'));
    expect(check(dir).status).toBe(0);
  });

  it('passes for this repository', () => {
    const r = check(ROOT);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('dependencies and assets', () => {
  it('has no firebase packages, no second lockfile and no source files for them', () => {
    const p = pkg();
    const deps = { ...p.dependencies, ...p.devDependencies };
    expect(Object.keys(deps).filter(d => d.startsWith('firebase'))).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'bun.lock'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'firebase-applet-config.json'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/firebase.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/firebase-admin.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/queue'))).toBe(false);
  });

  it('loads no resource from another host (fonts are self-hosted)', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(html).not.toMatch(/(?:href|src)=["']https?:\/\//);
    expect(html).toMatch(/@fontsource\/outfit/);
    expect(html).toMatch(/@fontsource\/plus-jakarta-sans/);
    const p = pkg();
    expect(p.devDependencies['@fontsource/outfit']).toBeTruthy();
    expect(p.devDependencies['@fontsource/plus-jakarta-sans']).toBeTruthy();
  });

  it('builds the server outside the static root and ships it', () => {
    const p = pkg();
    expect(p.scripts.build).toContain('scripts/build-server.cjs');
    expect(p.scripts.start).toContain('dist-server/server.cjs');
    expect(p.build.files).toContain('dist-server/**');
    const builder = read('scripts/build-server.cjs');
    expect(builder).not.toMatch(/outfile:\s*['"`]dist\//);
  });

  it('documents the real authentication stack, not Firebase', () => {
    const agents = read('AGENTS.md');
    expect(agents).not.toMatch(/Firebase (?:Auth|Admin)|firebase-admin/i);
    expect(agents).toMatch(/req\.user/);
  });

  it('documents every configuration variable in .env.example, and only those', () => {
    const documented = new Set([...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]));
    const known = new Set(ENV_VARIABLES.map(v => v.name));
    expect([...known].filter(k => !documented.has(k))).toEqual([]);
    expect([...documented].filter(k => !known.has(k))).toEqual([]);
  });
});

describe('desktop shell', () => {
  it('lets the setup page run only its own script and style (hashes in its CSP match the inline blocks)', () => {
    const html = read('desktop/setup.html');
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).not.toContain('unsafe-inline');
    const hash = (b: string) => `'sha256-${createHash('sha256').update(b).digest('base64')}'`;
    const inline = (tag: string) => [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => m[1]);
    for (const body of inline('script')) expect(csp).toContain(hash(body));
    for (const body of inline('style')) expect(csp).toContain(hash(body));
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('exposes the database bridge to the setup and update windows only', () => {
    const main = read('desktop/main.cjs');
    // exactly one BrowserWindow is created with a preload, and the application window has none
    expect(main.match(/preload:/g)).toHaveLength(1);
    const openMain = /function openMain[\s\S]*?\n}\n/.exec(main)?.[0] ?? '';
    expect(openMain).not.toContain('preload');
    expect(openMain).not.toContain('bridgeWindow');
    // the one preload sits in bridgeWindow(), sandboxed, and only the setup and update windows call it
    const bridge = /function bridgeWindow[\s\S]*?\n}\n/.exec(main)?.[0] ?? '';
    expect(bridge).toContain('preload.cjs');
    expect(bridge).toContain('sandbox: true');
    expect(bridge).toContain('contextIsolation: true');
    expect(bridge).toContain('nodeIntegration: false');
    expect(main.match(/bridgeWindow\(\{/g)).toHaveLength(2);
    // both IPC handlers check the sender
    expect(main.match(/if \(!fromSetup\(e\)\)/g)).toHaveLength(2);
    // navigation is compared by origin, not by string prefix
    expect(main).not.toMatch(/startsWith\(origin\)/);
    expect(main).toMatch(/new URL\(u\)\.origin === origin/);
  });
});
