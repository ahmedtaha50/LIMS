// @ts-check
// Unit and randomised tests of lib/glob.cjs. Run: node --test scripts/tests/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { globToRegex, matcher, braces, globsIntersect } = require('../lib/glob.cjs');

/** A small seeded generator, so a failure prints a seed that reproduces it. */
/** @param {number} seed @returns {() => number} */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** @template T @param {() => number} r @param {readonly T[]} xs @returns {T} */
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

test('globToRegex: the forms the roadmaps use', () => {
  /** @type {Array<[string, string[], string[]]>} */
  const cases = [
    ['src/server/**', ['src/server/a.ts', 'src/server/x/y.ts'], ['src/serverx/a.ts', 'src/a.ts']],
    ['src/**/*.test.ts', ['src/a.test.ts', 'src/x/y/a.test.ts'], ['src/a.ts', 'lib/a.test.ts']],
    ['migrations/002*', ['migrations/0020_x.sql', 'migrations/002'], ['migrations/0030.sql', 'migrations/x/002']],
    ['tests/api/esign*.test.ts', ['tests/api/esign.test.ts', 'tests/api/esign-x.test.ts'], ['tests/api/x/esign.test.ts']],
    ['src/{a,b}/*.ts', ['src/a/x.ts', 'src/b/y.ts'], ['src/c/x.ts', 'src/a/x/y.ts']],
    ['file?.md', ['file1.md'], ['file.md', 'file12.md', 'file/.md']],
    ['a.b+c(d).ts', ['a.b+c(d).ts'], ['aXb+c(d).ts']],
  ];
  for (const [g, yes, no] of cases) {
    for (const p of yes) assert.ok(globToRegex(g).test(p), `${g} should match ${p}`);
    for (const p of no) assert.ok(!globToRegex(g).test(p), `${g} should not match ${p}`);
  }
});

test('globToRegex compiles each pattern once', () => {
  assert.equal(globToRegex('x/**/y'), globToRegex('x/**/y'));
});

test('matcher: literal paths and globs together', () => {
  const m = matcher(['src/app.ts', 'src/routes/**']);
  assert.ok(m('src/app.ts') && m('src/routes/a/b.ts'));
  assert.ok(!m('src/app.tsx') && !m('src/other.ts'));
});

test('braces writes out alternatives, nested and capped', () => {
  assert.deepEqual(braces('a/{x,y}/{1,2}'), ['a/x/1', 'a/x/2', 'a/y/1', 'a/y/2']);
  assert.equal(braces('{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}', 10).length, 10);
});

test('globsIntersect: known pairs', () => {
  const yes = [['src/**', 'src/a/*.ts'], ['migrations/002*', 'migrations/00*'], ['**/*.test.ts', 'tests/api/*.ts'], ['a/{x,y}/*', 'a/y/z']];
  const no = [['migrations/001*', 'migrations/003*'], ['src/a/**', 'src/b/**'], ['tests/*.ts', 'tests/x/*.ts'], ['*.md', '*.ts'], ['src/{a,b}/*', 'src/c/*']];
  for (const [a, b] of yes) { assert.ok(globsIntersect(a, b), `${a} ~ ${b}`); assert.ok(globsIntersect(b, a), `${b} ~ ${a} (symmetric)`); }
  for (const [a, b] of no) assert.ok(!globsIntersect(a, b), `${a} !~ ${b}`);
});

test('globsIntersect never misses a real overlap (randomised against brute force)', () => {
  const seed = Number(process.env.GLOB_SEED || 20261116), r = rng(seed);
  const atom = () => pick(r, ['a', 'b', '/', '*', '**/', '?', '{a,b}', 'a', 'b', '/']);
  const glob = () => Array.from({ length: 1 + Math.floor(r() * 5) }, atom).join('');
  const pathOf = () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, ['a', 'b', '/'])).join('');
  const paths = Array.from({ length: 400 }, pathOf);
  let pairs = 0, overlaps = 0;
  for (let i = 0; i < 1500; i++) {
    const ga = glob(), gb = glob(), ra = globToRegex(ga), rb = globToRegex(gb);
    const witness = paths.find(p => ra.test(p) && rb.test(p));
    pairs++;
    if (witness) { overlaps++; assert.ok(globsIntersect(ga, gb), `seed ${seed}: "${ga}" and "${gb}" both match "${witness}" but globsIntersect said no`); }
  }
  assert.ok(overlaps > 100, `the generator produced too few overlapping pairs (${overlaps} of ${pairs}) to mean anything`);
});
