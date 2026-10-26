/**
 * Roadmap M24 (r2-ui-foundation): the hash router (src/lib/router.ts) and the URL-held view state (src/lib/useQueryState.ts).
 * A hash router because the desktop build serves the application on a random local port (no server-side path routing).
 * The navigation functions are tested against a stand-in window that behaves like a browser's location and history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatHash, navigate, parseHash, readRoute, setQuery, subscribeRoute } from '../../../src/lib/router';
import { readQueryState } from '../../../src/lib/useQueryState';

class FakeWindow extends EventTarget {
  entries: string[] = ['#/'];
  index = 0;
  location = { get hash() { return '' as string; } } as { hash: string };
  history: { pushState: (s: unknown, t: string, url: string) => void; replaceState: (s: unknown, t: string, url: string) => void; back: () => void; length: number };
  constructor() {
    super();
    const self = this;
    Object.defineProperty(this.location, 'hash', {
      get: () => self.entries[self.index],
      set: (v: string) => { self.entries = self.entries.slice(0, self.index + 1); self.entries.push(v.startsWith('#') ? v : `#${v}`); self.index++; self.dispatchEvent(new Event('hashchange')); },
    });
    this.history = {
      pushState: (_s, _t, url) => { self.entries = self.entries.slice(0, self.index + 1); self.entries.push(url); self.index++; },
      replaceState: (_s, _t, url) => { self.entries[self.index] = url; },
      back: () => { if (self.index > 0) { self.index--; self.dispatchEvent(new Event('hashchange')); } },
      get length() { return self.entries.length; },
    };
  }
}

let win: FakeWindow;
beforeEach(() => { win = new FakeWindow(); (globalThis as any).window = win; });
afterEach(() => { delete (globalThis as any).window; });

describe('parseHash / formatHash', () => {
  it('reads the view, the record id and the query from a pasted deep link', () => {
    const r = parseHash('#/samples/SMP-2026-00001?q=asp&state=Testing');
    expect(r.view).toBe('samples');
    expect(r.segments).toEqual(['SMP-2026-00001']);
    expect(r.query.get('q')).toBe('asp');
    expect(r.query.get('state')).toBe('Testing');
  });

  it('decodes and encodes ids with reserved characters, and round-trips', () => {
    const hash = formatHash('samples', ['A/B C#1'], { q: 'x y&z' });
    expect(hash).toBe('#/samples/A%2FB%20C%231?q=x+y%26z');
    expect(parseHash(hash).segments).toEqual(['A/B C#1']);
    expect(parseHash(hash).query.get('q')).toBe('x y&z');
  });

  it('treats an empty or malformed hash as "no view" and drops empty query values', () => {
    expect(parseHash('').view).toBe('');
    expect(parseHash('#').view).toBe('');
    expect(parseHash('#/').view).toBe('');
    expect(parseHash('#/%E0%A4%A').segments).toEqual([]); // undecodable: no crash
    expect(formatHash('samples', [], { q: '', state: undefined, sort: 'id' })).toBe('#/samples?sort=id');
  });
});

describe('navigation', () => {
  it('navigate pushes an entry, so Back returns to the previous view; a reload reads the same hash', () => {
    const seen: string[] = [];
    const off = subscribeRoute(() => seen.push(readRoute().view));
    navigate('#/samples');
    navigate('#/samples/SMP-2026-00001');
    expect(readRoute().segments).toEqual(['SMP-2026-00001']);
    win.history.back();
    expect(readRoute().view).toBe('samples');
    expect(readRoute().segments).toEqual([]);
    expect(seen).toEqual(['samples', 'samples', 'samples']);
    off();
  });

  it('navigate with replace changes the entry in place and still notifies', () => {
    let calls = 0;
    const off = subscribeRoute(() => calls++);
    navigate('#/samples');
    const len = win.history.length;
    navigate('#/samples?q=a', { replace: true });
    expect(win.history.length).toBe(len);
    expect(readRoute().query.get('q')).toBe('a');
    expect(calls).toBe(2);
    off();
  });

  it('setQuery merges into the current view, removes cleared keys and replaces the entry by default', () => {
    navigate('#/samples/SMP-1?sort=id');
    const len = win.history.length;
    setQuery({ q: 'para', sort: null });
    expect(win.location.hash).toBe('#/samples/SMP-1?q=para');
    expect(win.history.length).toBe(len);
    setQuery({ after: 'abc' }, { push: true });
    expect(win.history.length).toBe(len + 1);
  });

  it('is safe without a window (server rendering)', () => {
    delete (globalThis as any).window;
    expect(readRoute().view).toBe('');
    expect(() => navigate('#/x')).not.toThrow();
  });
});

describe('query state', () => {
  it('reads typed values with defaults; a value outside the allowed set falls back to the default', () => {
    const spec = { q: '', sort: { default: 'createdAt', oneOf: ['createdAt', 'id', 'material'] }, dir: { default: 'desc', oneOf: ['asc', 'desc'] } } as const;
    expect(readQueryState(new URLSearchParams('q=x&sort=material'), spec)).toEqual({ q: 'x', sort: 'material', dir: 'desc' });
    expect(readQueryState(new URLSearchParams('sort=password&dir=up'), spec)).toEqual({ q: '', sort: 'createdAt', dir: 'desc' });
  });
});
