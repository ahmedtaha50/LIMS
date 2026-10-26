/**
 * M03: structured, redacted, rotating logs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, redactText } from '../../../src/server/obs/logger';
import { createRotatingFile } from '../../../src/server/obs/rotate';

function sink() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(...chunk.toString().split('\n').filter(Boolean)); cb(); } });
  return { lines, stream };
}

describe('logger', () => {
  it('writes one JSON object per line in the shape the rest of the server already uses', () => {
    const out = sink(); const err = sink();
    const log = createLogger({ level: 'info', stdout: out.stream, stderr: err.stream });
    log.info({ requestId: 'r1' }, 'hello');
    log.error({ err: new Error('kaput') }, 'failed');
    log.debug({}, 'hidden');
    const info = JSON.parse(out.lines[0]);
    expect(info).toMatchObject({ level: 'info', msg: 'hello', requestId: 'r1' });
    expect(new Date(info.time).toISOString()).toBe(info.time);
    const error = JSON.parse(err.lines[0]);
    expect(error).toMatchObject({ level: 'error', msg: 'failed' });
    expect(error.err.message).toBe('kaput');
    expect(error.err.stack).toContain('kaput');
    expect(out.lines).toHaveLength(1); // debug is below the configured level
  });

  it('redacts credentials in fields, however deep', () => {
    const out = sink();
    const log = createLogger({ level: 'info', stdout: out.stream, stderr: out.stream });
    log.info({ body: { password: 'p1', passphrase: 'p2', newPassword: 'p3' }, req: { headers: { authorization: 'Bearer t', cookie: 'c' } }, user: { totpSecret: 'ABC', passwordHash: 'h' }, tempToken: 'tt' }, 'x');
    const text = out.lines.join('\n');
    for (const v of ['p1', 'p2', 'p3', 'Bearer t', '"ABC"', '"h"', '"tt"']) expect(text).not.toContain(v);
    expect(text).toContain('[REDACTED]');
  });
});

describe('redactText', () => {
  it('masks bearer tokens and key=value credentials in free text', () => {
    const s = redactText('Authorization: Bearer abc.def.ghi password=hunter2 passphrase: "open sesame" x-api-key=K1');
    expect(s).not.toMatch(/abc\.def\.ghi|hunter2|open sesame|K1/);
    expect(s).toContain('[REDACTED]');
    expect(redactText('plain line')).toBe('plain line');
  });
});

describe('rotating file', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('rotates by size and keeps a bounded number of files, newest data in the base file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-rot-'));
    const file = path.join(dir, 'server.log');
    const rot = createRotatingFile(file, { maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 40; i++) rot.write(`line-${String(i).padStart(3, '0')}-${'x'.repeat(30)}`);
    rot.close();
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    for (const n of names) expect(fs.statSync(path.join(dir, n)).size).toBeLessThanOrEqual(200 + 64);
    expect(fs.readFileSync(file, 'utf8')).toContain('line-039');
    const all = names.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    expect(all).not.toContain('line-000'); // oldest rotated out
  });

  it('appends to an existing file after a restart', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-rot-'));
    const file = path.join(dir, 'a.log');
    createRotatingFile(file).write('first');
    const again = createRotatingFile(file); again.write('second'); again.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('first\nsecond\n');
  });
});
