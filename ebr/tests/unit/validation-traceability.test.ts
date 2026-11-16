/**
 * E20 (r3-validation): the validation package is generated from the requirements and the executed tests, and a program, not a
 * reader, decides whether a Critical or High requirement is covered.
 *
 *   - the gate (validation/build/check.cjs) is tested with synthetic content and synthetic results;
 *   - the RTM rows (validation/build/build.cjs) take their result from the results given, never from the content source;
 *   - the real package is structurally sound without any run: every requirement comes from the roadmap, every reference names a
 *     test file that exists and a title fragment that is in it.
 * Whether the references PASSED is checked against the executed evidence by `node validation/build/check.cjs` (after the suite).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { findings } = require('../../validation/build/check.cjs');
const { rtmRows } = require('../../validation/build/build.cjs');
const content = require('../../validation/build/content.cjs');

type Ref = { file?: string; match?: string; perf?: string };
const fake = (over: Record<string, unknown> = {}) => ({
  URS: [['URS-E90-1', 'A high thing.', 'High', 'Area'], ['URS-E90-2', 'A medium thing.', 'Medium', 'Area']],
  FRS: [['FRS-E90', 'server/core/db.ts does it.', ['URS-E90-1', 'URS-E90-2']]],
  GRA: [['Area', 3, 3, 3, 'why', ['URS-E90-1', 'URS-E90-2']]],
  VERIF: { 'URS-E90-1': { type: 'P', ref: 'OQ-E90', tests: [{ file: 'tests/api/x.test.ts', match: 'works' }] }, 'URS-E90-2': { type: 'P*', ref: 'OQ-E90', tests: [], deviation: 'DEV-1' } },
  DEVIATIONS: [['DEV-1', 'open one', 'action', 'OPEN'], ['DEV-2', 'closed one', 'action', 'CLOSED']],
  ...over,
});
const res = (status: string, found = 1) => ({ statusOfRef: () => ({ status, found }), refId: (r: Ref) => r.match, statusOfVerif: (v: { tests?: Ref[] }) => (v.tests?.length ? status : null) });
const passed = res('Pass'), failed = res('Fail'), absent = res('NOT RUN', 0);

describe('the traceability gate (E20#2)', () => {
  it('E20#2: is quiet for a High requirement whose test passed and a Medium one under an open deviation', () => {
    expect(findings({ content: fake(), results: passed })).toEqual([]);
  });
  it('E20#2: complains about a High requirement with no test and no deviation, and about P* without a deviation', () => {
    const c = fake({ VERIF: { 'URS-E90-1': { type: 'P', ref: 'OQ', tests: [] }, 'URS-E90-2': { type: 'P*', ref: 'OQ', tests: [] } } });
    expect(findings({ content: c, results: passed })).toEqual(['URS-E90-1 (High): no executed test and no open deviation', 'URS-E90-2 (Medium): P* without a deviation']);
  });
  it('E20#2: accepts an open deviation instead of a test, and refuses a closed or an unknown one', () => {
    const v = (dev: string) => fake({ VERIF: { 'URS-E90-1': { type: 'GAP', ref: 'OQ', tests: [], deviation: dev }, 'URS-E90-2': { type: 'P*', ref: 'OQ', tests: [], deviation: 'DEV-1' } } });
    expect(findings({ content: v('DEV-1'), results: passed })).toEqual([]);
    expect(findings({ content: v('DEV-2'), results: passed })).toEqual(['URS-E90-1: its deviation DEV-2 is CLOSED, not OPEN']);
    expect(findings({ content: v('DEV-9'), results: passed })).toEqual(['URS-E90-1: names the deviation DEV-9, which does not exist']);
  });
  it('E20#2: turns red when a referenced test failed, or cannot be found in the executed run', () => {
    expect(findings({ content: fake(), results: failed })).toEqual(['URS-E90-1: works is Fail']);
    expect(findings({ content: fake(), results: absent })).toEqual(['URS-E90-1: works is NOT RUN (not found in the evidence)']);
  });
  it('E20#2: names a requirement with no mechanism or no risk score, and a mechanism naming a file that does not exist', () => {
    expect(findings({ content: fake({ FRS: [], GRA: [] }), results: passed })).toEqual([
      'URS-E90-1: no functional mechanism (FRS) names it', 'URS-E90-1: not scored in the risk assessment (GRA)',
      'URS-E90-2: no functional mechanism (FRS) names it', 'URS-E90-2: not scored in the risk assessment (GRA)']);
    expect(findings({ content: fake({ FRS: [['FRS-E90', 'server/no-such-file.ts does it.', ['URS-E90-1', 'URS-E90-2']]] }), results: passed }))
      .toEqual(['FRS-E90: the path server/no-such-file.ts does not exist']);
  });
});

describe('the package is generated, nothing is typed as a result (E20#1)', () => {
  it('E20#1: the RTM result of a requirement follows the executed evidence given, not the content source', () => {
    const c = fake();
    expect(rtmRows(c, passed).map((r: string[]) => r[5])).toEqual(['Pass', 'Not executed (DEV-1)']);
    expect(rtmRows(c, failed)[0][5]).toBe('Fail');
    expect(rtmRows(c, absent)[0][5]).toBe('NOT RUN');
  });
  it('E20#1: the requirements are the acceptance criteria of the roadmap, one for one', () => {
    const roadmap = JSON.parse(readFileSync(join(ROOT, 'docs/roadmap/roadmap.json'), 'utf8'));
    const expected = roadmap.gaps.flatMap((g: { id: string; acceptance: string[] }) => g.acceptance.map((_, i) => `URS-${g.id}-${i + 1}`));
    expect(content.URS.map((u: string[]) => u[0])).toEqual(expected);
  });
  it('E20#1: the content source holds no result: no Pass, Fail or NOT RUN is written in it', () => {
    const src = readFileSync(join(ROOT, 'validation/build/content.cjs'), 'utf8');
    expect(src.match(/['"](Pass|Fail|NOT RUN|PASS|FAIL)['"]/g)).toBeNull();
  });
});

describe('the real validation package', () => {
  it('has no structural finding: every requirement has a verification, a mechanism and a risk score; every path exists', () => {
    expect(findings({ requireEvidence: false })).toEqual([]);
  });
  it('references only tests that exist: the file is there and the title fragment is in it', () => {
    const missing: string[] = [];
    for (const [id, v] of Object.entries<{ tests: Ref[] }>(content.VERIF)) {
      for (const t of v.tests) {
        if (!t.file) continue;
        const p = join(ROOT, t.file);
        if (!existsSync(p)) { missing.push(`${id}: ${t.file} does not exist`); continue; }
        if (!readFileSync(p, 'utf8').replace(/\\'/g, "'").includes(t.match ?? '')) missing.push(`${id}: "${t.match}" is not in ${t.file}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it('numbers requirements and deviations without a duplicate', () => {
    const ids = content.URS.map((u: string[]) => u[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const devs = content.DEVIATIONS.map((d: string[]) => d[0]);
    expect(new Set(devs).size).toBe(devs.length);
  });
});
