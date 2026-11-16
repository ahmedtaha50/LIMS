// @ts-check
// Unit tests of lib/common.cjs and lib/runtime.cjs. Run: node --test scripts/tests/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { args, parseCsv, loadRoadmap, loadConfig } = require('../lib/common.cjs');
const { invoke, Exit } = require('../lib/runtime.cjs');

test('args: flags, values and positional arguments', () => {
  const a = args(['in.json', '--repo', '/x', '--json', 'out'], ['--repo']);
  assert.equal(a.opt('--repo'), '/x');
  assert.equal(a.opt('--missing', 'd'), 'd');
  assert.ok(a.flag('--json') && !a.flag('--strict'));
  assert.deepEqual(a.positional, ['in.json', 'out']);
});

test('parseCsv: quotes, doubled quotes, commas and new lines inside a field, CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi""","two\nlines"\r\nx,y,,z\n'), [['a', 'b,c', 'say "hi"', 'two\nlines'], ['x', 'y', '', 'z']]);
});

test('parseCsv reads back what an RFC 4180 writer wrote (randomised)', () => {
  const chars = ['a', 'b', ',', '"', '\n', ' ', 'é'];
  let s = 7;
  const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const field = () => Array.from({ length: Math.floor(r() * 6) }, () => chars[Math.floor(r() * chars.length)]).join('');
  const quote = (/** @type {string} */ f) => (/[",\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f);
  for (let i = 0; i < 300; i++) {
    const rows = Array.from({ length: 1 + Math.floor(r() * 4) }, () => Array.from({ length: 1 + Math.floor(r() * 4) }, field).map(f => f || 'x'));
    assert.deepEqual(parseCsv(rows.map(row => row.map(quote).join(',')).join('\n') + '\n'), rows);
  }
});

test('loadRoadmap reads both shapes and indexes tracks and gaps', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'road-'));
  const plain = { releases: [{ name: 'R1', tracks: [{ track: 't1', gapIds: ['G1'], ownsFiles: ['a/**'] }] }], gaps: [{ id: 'G1', acceptance: ['x'] }] };
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(plain));
  fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify({ synth: { releases: plain.releases, mergedGaps: plain.gaps } }));
  for (const f of ['a.json', 'b.json']) {
    const r = loadRoadmap(path.join(d, f));
    assert.equal(r.byName.get('t1')?.release, 'R1');
    assert.deepEqual(r.byName.get('t1')?.dependsOn, []);
    assert.deepEqual(r.gapById.get('G1')?.acceptance, ['x']);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('loadConfig: defaults, overrides, and a clear error for bad JSON', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  assert.equal(loadConfig(d).ROADMAP, 'docs/roadmap/roadmap.json');
  fs.writeFileSync(path.join(d, 'factory.config.json'), '{"ROADMAP":"plan.json"}');
  assert.equal(loadConfig(d).ROADMAP, 'plan.json');
  fs.writeFileSync(path.join(d, 'factory.config.json'), '{oops');
  assert.throws(() => loadConfig(d), /not valid JSON/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('invoke: exit unwinds from any depth, output is captured in order, cwd is restored', () => {
  const before = process.cwd();
  const r = invoke((argv, io) => { io.console.log('out', 1); io.console.error('err'); const deep = () => io.exit(3); deep(); io.console.log('never'); }, [], { cwd: os.tmpdir() });
  assert.deepEqual(r, { code: 3, out: 'out 1\nerr\n' });
  assert.equal(process.cwd(), before);
});

test('invoke: a returned number is the exit code, nothing returned is 0, stdin is the given input', () => {
  assert.equal(invoke(() => 4, []).code, 4);
  assert.equal(invoke(() => undefined, []).code, 0);
  assert.equal(invoke((a, io) => { io.console.log(io.stdin().trim()); }, [], { input: 'piped\n' }).out, 'piped\n');
});

test('invoke: a crash is reported with its stack as exit 70 and does not escape', () => {
  const r = invoke(() => { throw new TypeError('boom'); }, []);
  assert.equal(r.code, 70);
  assert.match(r.out, /internal error: TypeError: boom/);
});

test('invoke: argv is a copy (a tool cannot change its caller\'s array)', () => {
  const argv = ['a'];
  invoke((a) => { a.push('b'); }, argv);
  assert.deepEqual(argv, ['a']);
  assert.ok(new Exit(2) instanceof Error);
});
