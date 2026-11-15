/**
 * Roadmap M37 (r2-validation): the requirements traceability matrix is generated from executed tests, and a program, not a reader,
 * decides whether a Critical or High requirement is covered.
 *
 * Two layers:
 *   - the gate itself (validation/build/check.cjs) is tested with synthetic content: it must complain about a Critical requirement with no
 *     test and no open deviation, about a reference that did not pass, and about a deviation that is not open;
 *   - the real package must be structurally sound without any run: every Critical/High requirement has a verification, every Vitest
 *     reference names a test file that exists and a title fragment that is in it, every mechanism names files that exist.
 * Whether the references PASSED is checked against the executed evidence by `node validation/build/check.cjs` (CI, after the suite).
 */
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..', '..');
const { findings } = require('../../validation/build/check.cjs');
const content = require('../../validation/build/content.cjs');

const fake = (over: Record<string, unknown> = {}) => ({
  URS: [['URS-900', 'A critical thing.', 'Critical', 'Area'], ['URS-901', 'A medium thing.', 'Medium', 'Area']],
  FRS: [['FRS-900', 'src/server/qualified.ts does it.', ['URS-900', 'URS-901']]],
  VERIF: { 'URS-900': { type: 'P', ref: 'OQ-X', tests: [{ file: 'tests/api/x.test.ts', match: 'works' }] }, 'URS-901': { type: 'P*', ref: 'OQ-X', note: 'read' } },
  DEVIATIONS: [['DEV-1', 'open one', 'action', 'OPEN'], ['DEV-2', 'closed one', 'action', 'CLOSED']],
  ...over,
});
const passed = { statusOfRef: () => ({ status: 'Pass', found: 1 }), refId: (r: any) => r.match };
const failed = { statusOfRef: () => ({ status: 'Fail', found: 1 }), refId: (r: any) => r.match };
const absent = { statusOfRef: () => ({ status: 'NOT RUN', found: 0 }), refId: (r: any) => r.match };

describe('the traceability gate', () => {
  it('is quiet for a Critical requirement whose test passed, and for a Medium one verified by reading', () => {
    expect(findings({ content: fake(), results: passed })).toEqual([]);
  });

  it('complains about a Critical or High requirement with no test and no deviation, but not about a Medium one', () => {
    const c = fake({ VERIF: { 'URS-900': { type: 'P*', ref: 'OQ-X', note: 'read' }, 'URS-901': { type: 'P*', ref: 'OQ-X', note: 'read' } } });
    expect(findings({ content: c, results: passed })).toEqual(['URS-900 (Critical): no executed test and no open deviation']);
  });

  it('accepts an open deviation instead of a test, and refuses a closed or an unknown one', () => {
    const v = (dev: string) => fake({ VERIF: { 'URS-900': { type: 'P*', ref: 'OQ-X', note: 'read', deviation: dev }, 'URS-901': { type: 'P*', ref: 'OQ-X' } } });
    expect(findings({ content: v('DEV-1'), results: passed })).toEqual([]);
    expect(findings({ content: v('DEV-2'), results: passed })).toEqual(['URS-900: its deviation DEV-2 is CLOSED, not OPEN']);
    expect(findings({ content: v('DEV-9'), results: passed })).toEqual(['URS-900: names the deviation DEV-9, which does not exist']);
  });

  it('turns red when a referenced test failed, or cannot be found in the executed run', () => {
    expect(findings({ content: fake(), results: failed })).toEqual(['URS-900: works is Fail']);
    expect(findings({ content: fake(), results: absent })).toEqual(['URS-900: works is NOT RUN (not found in the evidence)']);
  });

  it('names a requirement no mechanism addresses, and a mechanism that names a file that does not exist', () => {
    expect(findings({ content: fake({ FRS: [] }), results: passed })).toEqual(['URS-900: no functional mechanism (FRS) names it', 'URS-901: no functional mechanism (FRS) names it']);
    expect(findings({ content: fake({ FRS: [['FRS-900', 'src/server/no-such-file.ts does it.', ['URS-900', 'URS-901']]] }), results: passed })).toEqual(['FRS-900: the path src/server/no-such-file.ts does not exist']);
  });
});

describe('the real validation package', () => {
  it('has no structural finding: every Critical/High requirement has a verification, every mechanism names files that exist', () => {
    expect(findings({ requireEvidence: false })).toEqual([]);
  });

  it('references only Vitest tests that exist: the file is there and the title fragment is in it', () => {
    const missing: string[] = [];
    for (const [id, v] of Object.entries<any>(content.VERIF)) {
      for (const t of v.tests ?? []) {
        if (!t.file) continue;
        const path = join(ROOT, t.file);
        if (!existsSync(path)) { missing.push(`${id}: ${t.file} does not exist`); continue; }
        const source = readFileSync(path, 'utf8').replace(/\\'/g, "'");
        if (!source.includes(t.match)) missing.push(`${id}: "${t.match}" is not in ${t.file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every Critical and High requirement has an executed test or an open deviation', () => {
    const weak = content.URS.filter((u: string[]) => u[2] === 'Critical' || u[2] === 'High').filter((u: string[]) => {
      const v = content.VERIF[u[0]];
      return !(v?.tests?.length || v?.checks?.length || v?.file || v?.deviation);
    }).map((u: string[]) => u[0]);
    expect(weak).toEqual([]);
  });

  it('numbers requirements and deviations without a duplicate', () => {
    const ids = content.URS.map((u: string[]) => u[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const devs = content.DEVIATIONS.map((d: string[]) => d[0]);
    expect(new Set(devs).size).toBe(devs.length);
  });
});
