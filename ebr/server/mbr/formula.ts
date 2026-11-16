/**
 * Formulas of calculation steps: + - * / ( ), numbers, and references to earlier steps (`granulation.water_added`).
 * Parsed here, never passed to eval: a recipe is data written by people, so it may only do arithmetic.
 * R2 evaluates the same tree on the server from the recorded values (E11#3: the client never sends a calculated value).
 */
export type Node =
  | { k: 'num'; v: number }
  | { k: 'ref'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node };

export class FormulaError extends Error {}

type Tok = { t: 'num'; v: number } | { t: 'ref'; v: string } | { t: 'op'; v: string };
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`a number is not valid at position ${i + 1}`);
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-z_]/.test(c)) {
      const m = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?/.exec(src.slice(i))!;
      out.push({ t: 'ref', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new FormulaError(`"${c}" is not allowed in a formula (position ${i + 1}); use numbers, step names, + - * / and ( )`);
  }
  return out;
}

/** Recursive descent: expr = term (('+'|'-') term)*; term = unary (('*'|'/') unary)*; unary = '-' unary | atom. */
export function parseFormula(src: string): Node {
  if (src.length > 500) throw new FormulaError('a formula has at most 500 characters');
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const expr = (): Node => {
    let a = term();
    while (peek()?.t === 'op' && (peek()!.v === '+' || peek()!.v === '-')) { const op = toks[p++]!.v as '+' | '-'; a = { k: 'bin', op, a, b: term() }; }
    return a;
  };
  const term = (): Node => {
    let a = unary();
    while (peek()?.t === 'op' && (peek()!.v === '*' || peek()!.v === '/')) { const op = toks[p++]!.v as '*' | '/'; a = { k: 'bin', op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => {
    const t = peek();
    if (t?.t === 'op' && t.v === '-') { p++; return { k: 'neg', a: unary() }; }
    if (t?.t === 'op' && t.v === '+') { p++; return unary(); }
    return atom();
  };
  const atom = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaError('the formula ends too early');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'ref') return { k: 'ref', name: t.v };
    if (t.v === '(') { const e = expr(); const c = toks[p++]; if (c?.t !== 'op' || c.v !== ')') throw new FormulaError('a "(" is not closed'); return e; }
    throw new FormulaError(`"${t.v}" is not expected here`);
  };
  if (!toks.length) throw new FormulaError('the formula is empty');
  const tree = expr();
  if (p < toks.length) throw new FormulaError(`"${(toks[p] as Tok).v}" is not expected here`);
  return tree;
}

export function refsOf(n: Node, out = new Set<string>()): Set<string> {
  if (n.k === 'ref') out.add(n.name);
  else if (n.k === 'neg') refsOf(n.a, out);
  else if (n.k === 'bin') { refsOf(n.a, out); refsOf(n.b, out); }
  return out;
}

/** Evaluates with the recorded values. A division by zero or a missing value is an error, never Infinity or NaN. */
export function evaluate(n: Node, values: ReadonlyMap<string, number>): number {
  switch (n.k) {
    case 'num': return n.v;
    case 'ref': { const v = values.get(n.name); if (v === undefined) throw new FormulaError(`${n.name} has no value yet`); return v; }
    case 'neg': return -evaluate(n.a, values);
    case 'bin': {
      const a = evaluate(n.a, values), b = evaluate(n.b, values);
      if (n.op === '/' && b === 0) throw new FormulaError('division by zero');
      const r = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b;
      if (!Number.isFinite(r)) throw new FormulaError('the result is not a finite number');
      return r;
    }
  }
}
