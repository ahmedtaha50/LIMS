/**
 * The calculation engine (roadmap M18). Owned by r2-methods-calc. Pure: no database, no clock, no randomness, no AI.
 *
 *   compileFormula(expression)            parses a formula with a hand-written Pratt-style parser. There is no eval, no Function, no
 *                                         property access and no string: the only things a formula can contain are numbers, input
 *                                         names, the operators below, parentheses and calls to the allow-listed functions
 *                                         (FORMULA_FUNCTIONS in src/lib/validations/methods.ts). Anything else is a FormulaError.
 *   evaluateFormula(compiled, inputs)     the value, as a JS number. Errors (a missing input, division by zero, the square root of a
 *                                         negative number, an overflow) are FormulaErrors, never NaN or Infinity.
 *   calculate(expression, inputs, d)      {raw, reported}: raw written to 15 significant digits (toDecimalString), reported rounded
 *                                         ONCE, half-up on that decimal text (USP General Notices 7.20, src/lib/numeric.ts), to the
 *                                         d decimals of the limit; with d null the raw text is reported.
 *
 * Language, lowest precedence first:
 *   a || b    a && b                  logic (1 or 0; the right side is evaluated only when needed)
 *   == != < <= > >=                   comparison (1 or 0), not chained
 *   + -       * /                     arithmetic
 *   -a  +a  !a                        unary; binds looser than ^, so -x^2 is -(x^2)
 *   a ^ b                             power, right-associative: 2^3^2 is 2^9
 *   name(args)                        an allow-listed function; if(c, a, b) evaluates only the branch it takes
 * Numbers are digits with an optional fraction (98, 0.5): no exponent, no leading or trailing point. An input holds one number or a
 * list of replicates; a list is used only through an aggregate (mean, sd, rsd, sum, count, min, max), which also takes plain numbers.
 * sd is the sample standard deviation (n - 1); rsd is 100 * sd / |mean|.
 */
import { roundHalfUp } from '../../lib/numeric';
import { FORMULA_FUNCTIONS, isReservedName } from '../../lib/validations/methods';

export class FormulaError extends Error {
  constructor(message: string) { super(message); this.name = 'FormulaError'; }
}

export const ALLOWED_FUNCTIONS: readonly string[] = FORMULA_FUNCTIONS.map(f => f.name).sort();
const FUNCTIONS = new Map(FORMULA_FUNCTIONS.map(f => [f.name, f] as const));
const AGGREGATES = new Set(FORMULA_FUNCTIONS.filter(f => f.aggregate).map(f => f.name));

export const MAX_FORMULA_LENGTH = 2000;
export const MAX_FORMULA_DEPTH = 40;

export type Inputs = Readonly<Record<string, number | readonly number[]>>;

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'un'; op: '-' | '+' | '!'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node };

export interface CompiledFormula {
  readonly expression: string;
  readonly ast: Node;
  /** The input names the formula uses, sorted. */
  readonly variables: readonly string[];
  /** The functions it calls, sorted. */
  readonly functions: readonly string[];
}

// ---- lexer ---------------------------------------------------------------------------------------------------------------------

type Tok = { k: 'num'; v: number; text: string; at: number } | { k: 'name'; text: string; at: number } | { k: 'op'; text: string; at: number } | { k: 'end'; text: ''; at: number };

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '^', '!', '(', ')', ','];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: 'num', v: Number(num[0]), text: num[0], at: i }); i += num[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) { out.push({ k: 'name', text: name[0], at: i }); i += name[0].length; continue; }
    const op = OPERATORS.find(o => src.startsWith(o, i));
    if (op) { out.push({ k: 'op', text: op, at: i }); i += op.length; continue; }
    const hint = c === '=' ? ' (compare with ==)' : c === '&' || c === '|' ? ' (use && or ||)' : '';
    throw new FormulaError(`Unexpected character '${c}' at position ${i + 1}${hint}: a formula holds numbers, input names, + - * / ^, comparisons, parentheses and the allowed functions.`);
  }
  out.push({ k: 'end', text: '', at: src.length });
  return out;
}

// ---- parser --------------------------------------------------------------------------------------------------------------------

class Parser {
  private pos = 0;
  private depth = 0;
  readonly variables = new Set<string>();
  readonly functions = new Set<string>();
  constructor(private readonly toks: Tok[]) {}

  private peek() { return this.toks[this.pos]; }
  private next() { return this.toks[this.pos++]; }
  private isOp(text: string) { const t = this.peek(); return t.k === 'op' && t.text === text; }
  private unexpected(t: Tok): never {
    if (t.k === 'end') throw new FormulaError('Unexpected end of the formula: something is missing after the last operator.');
    throw new FormulaError(`Unexpected '${t.text}' at position ${t.at + 1}.`);
  }

  parse(): Node {
    const node = this.or();
    const t = this.peek();
    if (t.k !== 'end') this.unexpected(t);
    return node;
  }

  private enter() {
    if (++this.depth > MAX_FORMULA_DEPTH) throw new FormulaError(`The formula is nested too deeply (more than ${MAX_FORMULA_DEPTH} levels).`);
  }

  private or(): Node {
    this.enter();
    let a = this.and();
    while (this.isOp('||')) { this.next(); a = { t: 'bin', op: '||', a, b: this.and() }; }
    this.depth--;
    return a;
  }
  private and(): Node {
    let a = this.cmp();
    while (this.isOp('&&')) { this.next(); a = { t: 'bin', op: '&&', a, b: this.cmp() }; }
    return a;
  }
  private cmp(): Node {
    const a = this.add();
    const t = this.peek();
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.next();
      const b = this.add();
      const after = this.peek();
      if (after.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(after.text)) {
        throw new FormulaError(`Unexpected '${after.text}' at position ${after.at + 1}: comparisons cannot be chained; join them with &&.`);
      }
      return { t: 'bin', op: t.text, a, b };
    }
    return a;
  }
  private add(): Node {
    let a = this.mul();
    for (let t = this.peek(); t.k === 'op' && (t.text === '+' || t.text === '-'); t = this.peek()) { this.next(); a = { t: 'bin', op: t.text, a, b: this.mul() }; }
    return a;
  }
  private mul(): Node {
    let a = this.unary();
    for (let t = this.peek(); t.k === 'op' && (t.text === '*' || t.text === '/'); t = this.peek()) { this.next(); a = { t: 'bin', op: t.text, a, b: this.unary() }; }
    return a;
  }
  private unary(): Node {
    const t = this.peek();
    if (t.k === 'op' && (t.text === '-' || t.text === '+' || t.text === '!')) {
      this.next();
      this.enter();
      const a = this.unary();
      this.depth--;
      return { t: 'un', op: t.text as '-' | '+' | '!', a };
    }
    return this.power();
  }
  private power(): Node {
    const base = this.primary();
    if (this.isOp('^')) {
      this.next();
      this.enter();
      const exp = this.unary();
      this.depth--;
      return { t: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }
  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'op' && t.text === '(') {
      const inner = this.or();
      if (!this.isOp(')')) throw new FormulaError(`Expected ')' at position ${this.peek().at + 1} to close the '(' at position ${t.at + 1}.`);
      this.next();
      return inner;
    }
    if (t.k === 'name') {
      if (isReservedName(t.text)) throw new FormulaError(`The name '${t.text}' is not allowed in a formula.`);
      if (this.isOp('(')) return this.call(t);
      if (FUNCTIONS.has(t.text)) throw new FormulaError(`'${t.text}' is a function: call it as ${t.text}(...).`);
      this.variables.add(t.text);
      return { t: 'var', name: t.text };
    }
    return this.unexpected(t);
  }
  private call(name: Tok): Node {
    const fn = FUNCTIONS.get(name.text);
    if (!fn) throw new FormulaError(`The function '${name.text}' is not allowed. Allowed: ${ALLOWED_FUNCTIONS.join(', ')}.`);
    this.next(); // (
    this.enter();
    const args: Node[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.or());
        if (this.isOp(',')) { this.next(); continue; }
        break;
      }
    }
    if (!this.isOp(')')) throw new FormulaError(`Expected ')' at position ${this.peek().at + 1} to close ${name.text}(.`);
    this.next();
    this.depth--;
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const n = fn.minArgs === fn.maxArgs ? `exactly ${fn.minArgs}` : `at least ${fn.minArgs}`;
      throw new FormulaError(`${name.text}() takes ${n} argument${fn.minArgs === 1 ? '' : 's'}; it was given ${args.length}.`);
    }
    this.functions.add(name.text);
    return { t: 'call', fn: name.text, args };
  }
}

export function compileFormula(expression: string): CompiledFormula {
  if (typeof expression !== 'string' || expression.trim() === '') throw new FormulaError('The formula is empty.');
  if (expression.length > MAX_FORMULA_LENGTH) throw new FormulaError(`The formula is too long (${expression.length} characters; at most ${MAX_FORMULA_LENGTH}).`);
  const p = new Parser(lex(expression));
  const ast = p.parse();
  return Object.freeze({ expression, ast, variables: Object.freeze([...p.variables].sort()), functions: Object.freeze([...p.functions].sort()) });
}

// ---- evaluation ----------------------------------------------------------------------------------------------------------------

type Value = number | number[];

const finite = (n: number, what: string): number => {
  if (!Number.isFinite(n)) throw new FormulaError(`${what} gives a number that is not finite (overflow).`);
  return n;
};

/** Neumaier summation: the sum of many replicates without losing digits to the order of addition. */
function sumOf(xs: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

function sdOf(xs: readonly number[], fn: string): number {
  if (xs.length < 2) throw new FormulaError(`${fn}() needs at least two values (it was given ${xs.length}).`);
  const m = sumOf(xs) / xs.length;
  return Math.sqrt(sumOf(xs.map(x => (x - m) * (x - m))) / (xs.length - 1));
}

function aggregate(fn: string, xs: number[]): number {
  if (fn === 'count') return xs.length;
  if (xs.length === 0) throw new FormulaError(`${fn}(): there are no values.`);
  switch (fn) {
    case 'sum': return sumOf(xs);
    case 'mean': return sumOf(xs) / xs.length;
    case 'min': return Math.min(...xs);
    case 'max': return Math.max(...xs);
    case 'sd': return sdOf(xs, fn);
    case 'rsd': {
      const s = sdOf(xs, fn);
      const m = sumOf(xs) / xs.length;
      if (m === 0) throw new FormulaError('rsd(): the mean is zero, so the relative standard deviation is not defined.');
      return (100 * s) / Math.abs(m);
    }
    default: throw new FormulaError(`Unknown aggregate ${fn}.`);
  }
}

function readInput(inputs: Inputs, name: string): Value {
  if (!Object.prototype.hasOwnProperty.call(inputs, name)) throw new FormulaError(`The input '${name}' has no value.`);
  const v = inputs[name];
  if (Array.isArray(v)) {
    if (!v.every(x => typeof x === 'number' && Number.isFinite(x))) throw new FormulaError(`Every replicate of '${name}' must be a finite number.`);
    return [...v];
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FormulaError(`The input '${name}' is not a finite number.`);
  return v;
}

function evaluate(node: Node, inputs: Inputs): Value {
  const scalar = (n: Node): number => {
    const v = evaluate(n, inputs);
    if (Array.isArray(v)) {
      const name = n.t === 'var' ? n.name : 'a list';
      throw new FormulaError(`'${name}' holds replicates: use it through an aggregate such as mean(${name}) or sd(${name}).`);
    }
    return v;
  };
  switch (node.t) {
    case 'num': return node.v;
    case 'var': return readInput(inputs, node.name);
    case 'un': {
      const a = scalar(node.a);
      return node.op === '-' ? -a : node.op === '+' ? a : (a === 0 ? 1 : 0);
    }
    case 'bin': {
      if (node.op === '&&') return scalar(node.a) !== 0 && scalar(node.b) !== 0 ? 1 : 0;
      if (node.op === '||') return scalar(node.a) !== 0 || scalar(node.b) !== 0 ? 1 : 0;
      const a = scalar(node.a);
      const b = scalar(node.b);
      switch (node.op) {
        case '+': return finite(a + b, 'An addition');
        case '-': return finite(a - b, 'A subtraction');
        case '*': return finite(a * b, 'A multiplication');
        case '/': if (b === 0) throw new FormulaError('Division by zero.'); return finite(a / b, 'A division');
        case '^': return finite(Math.pow(a, b), 'A power');
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        default: throw new FormulaError(`Unknown operator ${node.op}.`);
      }
    }
    case 'call': {
      const { fn, args } = node;
      if (AGGREGATES.has(fn)) {
        const xs: number[] = [];
        for (const a of args) { const v = evaluate(a, inputs); if (Array.isArray(v)) xs.push(...v); else xs.push(v); }
        return finite(aggregate(fn, xs), `${fn}()`);
      }
      if (fn === 'if') return scalar(args[0]) !== 0 ? scalar(args[1]) : scalar(args[2]);
      const x = scalar(args[0]);
      switch (fn) {
        case 'abs': return Math.abs(x);
        case 'sqrt': if (x < 0) throw new FormulaError(`sqrt() of a negative number (${x}).`); return Math.sqrt(x);
        case 'exp': return finite(Math.exp(x), 'exp()');
        case 'ln': if (x <= 0) throw new FormulaError(`ln() needs a positive number (it was given ${x}).`); return Math.log(x);
        case 'log10': if (x <= 0) throw new FormulaError(`log10() needs a positive number (it was given ${x}).`); return Math.log10(x);
        case 'pow': return finite(Math.pow(x, scalar(args[1])), 'pow()');
        default: throw new FormulaError(`Unknown function ${fn}.`);
      }
    }
  }
}

export function evaluateFormula(compiled: CompiledFormula, inputs: Inputs): number {
  const v = evaluate(compiled.ast, inputs);
  if (Array.isArray(v)) throw new FormulaError('The formula gives a list of replicates, not one value: use an aggregate such as mean().');
  return v;
}

/** A number as decimal text: 15 significant digits, no exponent, no trailing zeros, no negative zero. */
export function toDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new FormulaError('The value is not a finite number.');
  if (n === 0) return '0';
  const [mant, e] = n.toPrecision(15).split('e');
  const exponent = e ? Number(e) : 0;
  const neg = mant.startsWith('-');
  const [ip, fp = ''] = (neg ? mant.slice(1) : mant).split('.');
  const digits = ip + fp;
  const point = ip.length + exponent;
  let text = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  text = text.replace(/^0+(?=\d)/, '');
  return text === '0' ? '0' : (neg ? `-${text}` : text);
}

export interface Calculation { raw: string; reported: string }

/** Compiles, evaluates, and rounds once (half-up) to `decimals`; with decimals null the raw text is reported. */
export function calculate(expression: string | CompiledFormula, inputs: Inputs, decimals: number | null): Calculation {
  const compiled = typeof expression === 'string' ? compileFormula(expression) : expression;
  const raw = toDecimalString(evaluateFormula(compiled, inputs));
  return { raw, reported: decimals === null ? raw : roundHalfUp(raw, decimals) };
}
