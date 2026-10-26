/**
 * M02: the server project is type-checked with strictNullChecks, so a misspelt column (r.expirationDate for
 * r.expiryDate, r.isOOS for r.isOos) fails lint. Pre-existing errors live in a baseline that can only shrink.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
const CHECK = path.join(ROOT, 'scripts', 'typecheck-server.cjs');

const PROBE = (typo: boolean) => `
import { db } from ${JSON.stringify(path.join(ROOT, 'src/db/index'))};
export async function reagentsExpired(nowIso: string) {
  const reagents = await db.query.reagents.findMany();
  return reagents.filter(r => r.${typo ? 'expirationDate' : 'expiryDate'} < nowIso).length;
}
`;

describe('server type check', () => {
  let dir: string;
  const tsconfig = (name: string, extendsFile: string) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ extends: path.join(ROOT, extendsFile), include: [path.join(dir, 'probe.ts')], compilerOptions: { noEmit: true, typeRoots: [path.join(ROOT, 'node_modules', '@types')], types: ['node'] } }));
    return path.join(dir, name);
  };
  // Asynchronous on purpose: a synchronous tsc run blocks the vitest worker for tens of seconds, and several in a row exceed the worker's
  // 60 s heartbeat ("Timeout calling onTaskUpdate", an unhandled error that fails the run on a loaded machine).
  const exec = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const tsc = (project: string) => exec([TSC, '-p', project, '--pretty', 'false']);

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-tc-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('flags a misspelt database column under tsconfig.server.json (and the old config did not)', async () => {
    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(true));
    const strict = await tsc(tsconfig('server.json', 'tsconfig.server.json'));
    expect(strict.status).toBe(2);
    expect(strict.stdout).toMatch(/TS2339.*expirationDate/);
    const legacy = await tsc(tsconfig('legacy.json', 'tsconfig.json'));
    expect(legacy.stdout).not.toMatch(/expirationDate/); // this is how the typo survived in production code
  }, 120_000);

  it('accepts the correct column name', async () => {
    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(false));
    const r = await tsc(tsconfig('server-ok.json', 'tsconfig.server.json'));
    expect(r.stdout.trim()).toBe('');
    expect(r.status).toBe(0);
  }, 120_000);

  it('lets a known error pass and blocks a new one (baseline ratchet)', async () => {
    const project = tsconfig('ratchet.json', 'tsconfig.server.json');
    const baseline = path.join(dir, 'baseline.json');
    const run = (...args: string[]) => exec([CHECK, '--project', project, '--baseline', baseline, ...args]);

    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(false));
    fs.writeFileSync(baseline, JSON.stringify({ errors: [] }));
    expect((await run()).status).toBe(0);

    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(true));
    const blocked = await run();
    expect(blocked.status).toBe(1);
    expect(blocked.stdout + blocked.stderr).toMatch(/expirationDate/);

    expect((await run('--update')).status).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    expect(JSON.stringify(recorded)).toContain('expirationDate');
    expect((await run()).status).toBe(0); // now a known error

    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(true) + `\nexport const again = async () => (await db.query.reagents.findMany()).map(r => r.expirationDate);\n`);
    expect((await run()).status).toBe(1); // same error again: the count went up

    fs.writeFileSync(path.join(dir, 'probe.ts'), PROBE(false));
    const shrunk = await run();
    expect(shrunk.status).toBe(0);
    expect(shrunk.stdout).toMatch(/no longer occur|fixed/i); // told to shrink the baseline
  }, 240_000);
});
