import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// E16#3: no component counts users or enforces a user limit. The capacity test signs 300 users in at once; this check
// keeps a limit from being added quietly: no licence check, seat count or maximum of users anywhere in the server.
const SERVER = fileURLToPath(new URL('../../server', import.meta.url));
const files = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; });

describe('no user limit (E16#3)', () => {
  it('the server code has no licence, seat count or maximum number of users', () => {
    const hits = files(SERVER).filter(f => /\.ts$/.test(f)).flatMap(f => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const))
      .filter(([, , l]) => /max[_ ]?users|user[_ ]?limit|seat[_ ]?(count|limit)|licen[cs]e[_ ]?(key|check|count)|count\(\*\)[^;]*from users/i.test(l))
      .map(([f, n, l]) => `${f.slice(SERVER.length + 1)}:${n}: ${l.trim()}`);
    expect(hits).toEqual([]);
  });
});
