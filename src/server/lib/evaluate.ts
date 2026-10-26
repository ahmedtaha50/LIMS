/**
 * The result evaluator (roadmap M10). Owned by r1-results-oos. Pure: no database, no clock.
 *
 *   evaluateResult(raw, limit)   is the value acceptable as written, and is it out of specification?
 *   limitOfResult(row)           the limit a result row was registered with (the copy taken from the specification revision), or,
 *                                for a row written by v0.1.0, the limit read from spec_min / spec_max.
 *
 * Numeric limits (RANGE, NMT, NLT): the value is parsed strictly (src/lib/numeric.ts), rounded half-up to the decimals the limit
 * declares (USP General Notices 7.20) and compared as a decimal string. A limit without declared decimals (v0.1.0 rows, and
 * specifications nobody has revised since) is compared without rounding. Censored tokens: see CENSORED_TOKENS.
 * TEXT and PRESENCE limits: the value is one of a fixed pair of verdicts (TEXT_VERDICTS, PRESENCE_VERDICTS).
 */
import { compareDecimal, limitText, parseDecimal, roundHalfUp } from '../../lib/numeric';
import { CENSORED_TOKENS, PRESENCE_VERDICTS, TEXT_VERDICTS } from '../../lib/constants/results';
import type { LimitKind } from '../../lib/validations/specifications';

export interface ResultLimit {
  limitKind: LimitKind;
  /** Limits as decimal strings, exactly as written in the specification. */
  lower: string | null;
  upper: string | null;
  decimals: number | null;
  text: string | null;
}

export type Evaluation =
  | { ok: true; value: string; reportable: string; isOos: boolean }
  | { ok: false; error: string };

const isNumericKind = (k: LimitKind) => k === 'RANGE' || k === 'NMT' || k === 'NLT';

/** The limit has an upper bound and no lower bound that a "less than" result could fail to meet. */
function acceptsCensored(limit: ResultLimit): boolean {
  if (limit.upper === null) return false;
  return limit.lower === null || compareDecimal(limit.lower, '0') <= 0;
}

const round = (v: string, limit: ResultLimit) => (limit.decimals === null ? v : roundHalfUp(v, limit.decimals));

function outside(v: string, limit: ResultLimit): boolean {
  if (limit.lower !== null && (limit.limitKind === 'RANGE' || limit.limitKind === 'NLT') && compareDecimal(v, limit.lower) < 0) return true;
  if (limit.upper !== null && (limit.limitKind === 'RANGE' || limit.limitKind === 'NMT') && compareDecimal(v, limit.upper) > 0) return true;
  return false;
}

function verdict(raw: string, pair: { pass: string; fail: string }): Evaluation {
  const v = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (v === pair.pass.toLowerCase()) return { ok: true, value: pair.pass, reportable: pair.pass, isOos: false };
  if (v === pair.fail.toLowerCase()) return { ok: true, value: pair.fail, reportable: pair.fail, isOos: true };
  return { ok: false, error: `Record this result as "${pair.pass}" or "${pair.fail}".` };
}

export function evaluateResult(raw: string, limit: ResultLimit): Evaluation {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'A result value is required: enter a number.' };
  if (limit.limitKind === 'TEXT') return verdict(raw, TEXT_VERDICTS);
  if (limit.limitKind === 'PRESENCE') return verdict(raw, PRESENCE_VERDICTS);
  if (!isNumericKind(limit.limitKind)) return { ok: false, error: `Unknown limit kind ${String(limit.limitKind)}.` };

  const trimmed = raw.trim();
  const token = CENSORED_TOKENS.find(t => t.toLowerCase() === trimmed.toLowerCase());
  const lessThan = /^</.test(trimmed) && !token;
  if (token || lessThan) {
    if (!acceptsCensored(limit)) {
      return { ok: false, error: `"${trimmed}" is not accepted for this parameter: a "less than" result cannot show that the lower limit is met. Enter a number.` };
    }
    if (token) return { ok: true, value: token, reportable: token, isOos: false };
    const bound = parseDecimal(trimmed.slice(1));
    if (bound.ok === false) return { ok: false, error: `"${trimmed}" is not a number after "<". ${bound.error}` };
    // "<x" shows the result is within the limit only when x itself is: otherwise fail closed.
    const reportable = round(bound.value, limit);
    return { ok: true, value: `<${bound.value}`, reportable: `<${reportable}`, isOos: outside(reportable, limit) };
  }

  const parsed = parseDecimal(raw);
  if (parsed.ok === false) return { ok: false, error: parsed.error };
  const reportable = round(parsed.value, limit);
  return { ok: true, value: parsed.value, reportable, isOos: outside(reportable, limit) };
}

/** The columns of a results row that carry its limit. */
export interface ResultLimitColumns {
  limitKind: string | null;
  lowerText: string | null;
  upperText: string | null;
  decimals: number | null;
  acceptanceText: string | null;
  specMin: number | null;
  specMax: number | null;
}

export function limitOfResult(row: ResultLimitColumns): ResultLimit {
  if (row.limitKind) {
    return { limitKind: row.limitKind as LimitKind, lower: row.lowerText, upper: row.upperText, decimals: row.decimals, text: row.acceptanceText };
  }
  // v0.1.0 row: the limits survive only as `real`; PostgreSQL prints a float4 with the shortest text that reads back the same.
  const lower = limitText(row.specMin, null);
  const upper = limitText(row.specMax, null);
  const limitKind: LimitKind = lower !== null && upper !== null ? 'RANGE' : lower !== null ? 'NLT' : upper !== null ? 'NMT' : 'TEXT';
  return { limitKind, lower, upper, decimals: null, text: null };
}
