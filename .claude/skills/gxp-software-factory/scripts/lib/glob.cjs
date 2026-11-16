// @ts-check
// Glob patterns as the roadmap writes them (`*`, `**`, `?`, `{a,b}`): matching a path, and deciding without any file whether two
// patterns can ever match the same path. Pure functions, no I/O: tested by tests/glob.test.cjs, including a randomised check
// against brute force.
'use strict';

/** @typedef {{ k: 'chr', c: string } | { k: 'one' } | { k: 'seg' } | { k: 'any' }} Token */

const esc = (/** @type {string} */ s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&');
/** @type {Map<string, RegExp>} */
const regexCache = new Map();

/**
 * The regular expression of a glob, compiled once per pattern.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  const hit = regexCache.get(glob);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j > -1) { re += '(?:' + glob.slice(i + 1, j).split(',').map(esc).join('|') + ')'; i = j; } else re += '\\{';
    } else re += esc(c);
  }
  const rx = new RegExp('^' + re + '$');
  regexCache.set(glob, rx);
  return rx;
}

/** @param {string} g */
const hasWild = (g) => /[*?{]/.test(g);

/**
 * A predicate for "matches any of these patterns". Literal paths are looked up in a Set; only real globs run a regex.
 * @param {readonly string[]} patterns
 * @returns {(file: string) => boolean}
 */
function matcher(patterns) {
  const literal = new Set(patterns.filter(p => !hasWild(p)));
  const res = patterns.filter(hasWild).map(globToRegex);
  return (f) => literal.has(f) || res.some(r => r.test(f));
}

/**
 * {a,b} alternatives written out (at most `limit` patterns), so the comparison only sees *, ** and ?.
 * @param {string} glob
 * @param {number} [limit]
 * @returns {string[]}
 */
function braces(glob, limit = 64) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  /** @type {string[]} */
  const out = [];
  for (const alt of m[1].split(',')) {
    for (const g of braces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length), limit)) { out.push(g); if (out.length >= limit) return out; }
  }
  return out;
}

/**
 * @param {string} glob
 * @returns {Token[]}
 */
function tokens(glob) {
  /** @type {Token[]} */
  const t = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') i++; t.push({ k: 'any' }); } else t.push({ k: 'seg' }); }
    else if (c === '?') t.push({ k: 'one' });
    else t.push({ k: 'chr', c });
  }
  return t;
}

/**
 * Can one path match both token lists? A walk over the product of the two patterns (no file needed).
 * @param {Token[]} A
 * @param {Token[]} B
 */
function intersect(A, B) {
  /** @returns {Array<[string, number]>} what one step of token i may consume: a literal character, 'seg' (not "/") or 'any' */
  const steps = (/** @type {Token[]} */ T, /** @type {number} */ i) => {
    const t = T[i];
    if (!t) return [];
    if (t.k === 'chr') return [[t.c, i + 1]];
    if (t.k === 'one') return [['seg', i + 1]];
    if (t.k === 'seg') return [['seg', i]];
    return [['any', i]];
  };
  const meet = (/** @type {string} */ x, /** @type {string} */ y) => {
    if (x === 'any' || y === 'any') return !(x === 'seg' && y === '/') && !(y === 'seg' && x === '/');
    if (x === 'seg' && y === 'seg') return true;
    if (x === 'seg') return y !== '/';
    if (y === 'seg') return x !== '/';
    return x === y;
  };
  const width = B.length + 1, seen = new Uint8Array((A.length + 1) * width);
  /** @type {Array<[number, number]>} */
  const todo = [[0, 0]];
  while (todo.length) {
    const [i, j] = /** @type {[number, number]} */ (todo.pop());
    if (seen[i * width + j]) continue;
    seen[i * width + j] = 1;
    if (i === A.length && j === B.length) return true;
    const a = A[i], b = B[j];
    if (a && (a.k === 'seg' || a.k === 'any')) todo.push([i + 1, j]);   // the wildcard matches nothing more
    if (b && (b.k === 'seg' || b.k === 'any')) todo.push([i, j + 1]);
    for (const [ca, ni] of steps(A, i)) for (const [cb, nj] of steps(B, j)) if (meet(ca, cb)) todo.push([ni, nj]);
  }
  return false;
}

/** @type {Map<string, boolean>} */
const pairCache = new Map();
/**
 * Can any path match both globs? Never says "no" when a common path exists (the randomised test checks that);
 * slightly generous for "**\/" (it may say "yes" where only a path with an empty directory name would match).
 * @param {string} ga
 * @param {string} gb
 */
function globsIntersect(ga, gb) {
  const key = ga < gb ? ga + '\0' + gb : gb + '\0' + ga;
  const hit = pairCache.get(key);
  if (hit !== undefined) return hit;
  let res = false;
  outer: for (const a of braces(ga)) for (const b of braces(gb)) if (intersect(tokens(a), tokens(b))) { res = true; break outer; }
  pairCache.set(key, res);
  return res;
}

module.exports = { globToRegex, matcher, hasWild, braces, tokens, globsIntersect };
