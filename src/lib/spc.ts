/**
 * Statistical process control and stability regression (roadmap M39, r3-spc). Pure functions: no I/O, no clock, no randomness, so the
 * screen (ControlChart) and the server (src/server/stats) share one implementation and a fixture fixes every number.
 *
 * Everything here is ADVISORY. A rule violation, a Cpk or a shelf-life estimate informs a person; it never changes a result, a
 * specification or a disposition (nothing in this file touches a record).
 *
 * Conventions (the defaults are listed for QA's confirmation in docs/changes/r3-spc.md):
 *   - Individuals / moving-range chart: CL = mean of the values, MRbar = mean of |x[i] - x[i-1]|, UCL/LCL = CL +/- 2.66 MRbar.
 *     The zone width sigma is (UCL - CL) / 3 = 2.66 MRbar / 3, so "beyond 3 sigma" and "beyond a control limit" are the same test.
 *   - Capability uses the within-subgroup estimate sigma_w = MRbar / 1.128 (d2 for a moving range of 2) for Cp/Cpk, and the overall
 *     sample standard deviation for Pp/Ppk. Cpk is reported only when n >= 20 and BOTH specification limits exist.
 *   - "Beyond" is strict (a point exactly on a boundary is not beyond it). A series whose sigma is 0 has no zones and no violations.
 *   - Regression is ordinary least squares of the result on time (months). The shelf-life bound is the one-sided 95 % confidence bound
 *     of the MEAN response (the ICH Q1E approach: the shelf life is where that bound meets the acceptance criterion); the one-sided
 *     95 % prediction bound of a single result is reported alongside for information.
 */

export const IMR_E2 = 2.66; // 3 / d2 rounded as the control chart tables print it
export const IMR_D2 = 1.128;
export const IMR_D4 = 3.267; // upper limit of the moving range chart: D4 x MRbar
export const MIN_POINTS_FOR_CPK = 20;

// ---- descriptive statistics --------------------------------------------------------------------------------------------------

export const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

/** Sample standard deviation (n - 1). */
export function sampleSd(v: readonly number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export const movingRanges = (v: readonly number[]): number[] => v.slice(1).map((x, i) => Math.abs(x - v[i]));

// ---- limits ------------------------------------------------------------------------------------------------------------------

export interface ControlLimits {
  n: number;
  cl: number;
  /** Zone width: UCL = cl + 3 sigma, LCL = cl - 3 sigma. */
  sigma: number;
  ucl: number;
  lcl: number;
  mrBar: number | null;
  /** Upper limit of the moving range chart (D4 x MRbar); null for a fixed-limit chart. */
  mrUcl: number | null;
  method: 'IMR' | 'FIXED';
}

/** Individuals chart limits from the values themselves. Needs at least 2 values. */
export function imrLimits(values: readonly number[]): ControlLimits {
  if (values.length < 2) throw new RangeError('An individuals chart needs at least 2 values.');
  const cl = mean(values);
  const mrBar = mean(movingRanges(values));
  return { n: values.length, cl, sigma: (IMR_E2 * mrBar) / 3, ucl: cl + IMR_E2 * mrBar, lcl: cl - IMR_E2 * mrBar, mrBar, mrUcl: IMR_D4 * mrBar, method: 'IMR' };
}

/** Limits from a known mean and standard deviation (a reference or control material, Levey-Jennings chart). */
export function fixedLimits(cl: number, sd: number, n = 0): ControlLimits {
  if (!(sd >= 0) || !Number.isFinite(cl) || !Number.isFinite(sd)) throw new RangeError('A fixed-limit chart needs a finite mean and a standard deviation of 0 or more.');
  return { n, cl, sigma: sd, ucl: cl + 3 * sd, lcl: cl - 3 * sd, mrBar: null, mrUcl: null, method: 'FIXED' };
}

/** Signed distance of a value from the centre line in sigma units (null when sigma is 0). */
export const zScore = (x: number, l: Pick<ControlLimits, 'cl' | 'sigma'>): number | null => (l.sigma > 0 ? (x - l.cl) / l.sigma : null);

// ---- rules -------------------------------------------------------------------------------------------------------------------

export const NELSON_RULES = {
  N1: 'One point beyond 3 sigma',
  N2: '2 of 3 consecutive points beyond 2 sigma on the same side',
  N3: '4 of 5 consecutive points beyond 1 sigma on the same side',
  N4: '8 consecutive points on the same side of the centre line',
  N5: '6 consecutive points steadily increasing or decreasing',
} as const;
export type NelsonRule = keyof typeof NELSON_RULES;

export const WESTGARD_RULES = {
  '1-2s': 'One control value beyond 2 s (warning)',
  '1-3s': 'One control value beyond 3 s',
  '2-2s': '2 consecutive control values beyond 2 s on the same side',
  'R-4s': 'Two consecutive control values more than 4 s apart (one above +2 s, one below -2 s)',
  '4-1s': '4 consecutive control values beyond 1 s on the same side',
  '10x': '10 consecutive control values on the same side of the mean',
} as const;
export type WestgardRule = keyof typeof WESTGARD_RULES;

export type RuleSet = 'nelson' | 'westgard';
export type RuleId = NelsonRule | WestgardRule;

export interface RuleViolation {
  /** Index of the point that completes the pattern (the point the alert is about). */
  index: number;
  rule: RuleId;
  /** Warnings (1-2s) prompt a look; violations prompt an assessment. Neither changes anything by itself. */
  severity: 'warning' | 'violation';
  side: 'above' | 'below' | 'rising' | 'falling' | 'both';
  /** First index of the pattern. */
  start: number;
}

export const RULE_LABELS: Record<RuleId, string> = { ...NELSON_RULES, ...WESTGARD_RULES };

/**
 * Evaluates the rule set on every point, in order. A pattern is reported at the point that completes it, and again at each later
 * point that still completes it (a run of 9 on one side reports the 8th and the 9th). Pure and deterministic.
 */
export function evaluateRules(values: readonly number[], limits: Pick<ControlLimits, 'cl' | 'sigma'>, ruleSet: RuleSet = 'nelson'): RuleViolation[] {
  const out: RuleViolation[] = [];
  if (!(limits.sigma > 0)) return out;
  const z = values.map(x => (x - limits.cl) / limits.sigma);
  const sign = (a: number) => (a > 0 ? 1 : a < 0 ? -1 : 0);
  const sideOf = (s: number): 'above' | 'below' => (s > 0 ? 'above' : 'below');
  const add = (index: number, rule: RuleId, side: RuleViolation['side'], start: number, severity: RuleViolation['severity'] = 'violation') =>
    out.push({ index, rule, severity, side, start });

  /** k of the last w points beyond `t` sigma on one side, the current point included and itself beyond. */
  const kOfW = (i: number, k: number, w: number, t: number, rule: RuleId) => {
    for (const s of [1, -1]) {
      if (z[i] * s <= t) continue;
      const from = Math.max(0, i - w + 1);
      let count = 0; let first = i;
      for (let j = from; j <= i; j++) if (z[j] * s > t) { count++; if (j < first) first = j; }
      if (count >= k) add(i, rule, sideOf(s), first);
    }
  };
  /** n consecutive points beyond `t` sigma on one side. */
  const run = (i: number, n: number, t: number, rule: RuleId) => {
    if (i < n - 1) return;
    for (const s of [1, -1]) {
      let ok = true;
      for (let j = i - n + 1; j <= i; j++) if (!(z[j] * s > t)) { ok = false; break; }
      if (ok) add(i, rule, sideOf(s), i - n + 1);
    }
  };

  for (let i = 0; i < z.length; i++) {
    if (ruleSet === 'nelson') {
      if (Math.abs(z[i]) > 3) add(i, 'N1', sideOf(z[i]), i);
      kOfW(i, 2, 3, 2, 'N2');
      kOfW(i, 4, 5, 1, 'N3');
      run(i, 8, 0, 'N4');
      if (i >= 5) {
        let up = true; let down = true;
        for (let j = i - 5; j < i; j++) { if (!(values[j + 1] > values[j])) up = false; if (!(values[j + 1] < values[j])) down = false; }
        if (up) add(i, 'N5', 'rising', i - 5);
        if (down) add(i, 'N5', 'falling', i - 5);
      }
    } else {
      if (Math.abs(z[i]) > 3) add(i, '1-3s', sideOf(z[i]), i);
      else if (Math.abs(z[i]) > 2) add(i, '1-2s', sideOf(z[i]), i, 'warning');
      run(i, 2, 2, '2-2s');
      if (i >= 1 && ((z[i] > 2 && z[i - 1] < -2) || (z[i] < -2 && z[i - 1] > 2))) add(i, 'R-4s', 'both', i - 1);
      run(i, 4, 1, '4-1s');
      run(i, 10, 0, '10x');
    }
  }
  // Stable order: by point, then by rule id in a plain code-unit comparison.
  return out.sort((a, b) => a.index - b.index || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}

// ---- capability --------------------------------------------------------------------------------------------------------------

export interface Capability {
  n: number;
  mean: number;
  sigmaWithin: number | null;
  sigmaOverall: number;
  cp: number | null;
  cpk: number | null;
  pp: number | null;
  ppk: number | null;
}

export type CapabilityResult = { ok: true; value: Capability } | { ok: false; reason: 'TOO_FEW_POINTS' | 'NEEDS_BOTH_LIMITS' | 'NO_VARIATION' | 'BAD_LIMITS'; message: string };

/** Cpk and Ppk, only with n >= 20 and both specification limits (a one-sided or short series gets no capability index). */
export function capability(values: readonly number[], lsl: number | null | undefined, usl: number | null | undefined): CapabilityResult {
  if (values.length < MIN_POINTS_FOR_CPK) return { ok: false, reason: 'TOO_FEW_POINTS', message: `Capability needs at least ${MIN_POINTS_FOR_CPK} results; there are ${values.length}.` };
  if (lsl == null || usl == null) return { ok: false, reason: 'NEEDS_BOTH_LIMITS', message: 'Capability needs both a lower and an upper specification limit.' };
  if (!(usl > lsl)) return { ok: false, reason: 'BAD_LIMITS', message: 'The upper specification limit must be above the lower.' };
  const m = mean(values);
  const mrBar = mean(movingRanges(values));
  const sw = mrBar / IMR_D2;
  const so = sampleSd(values);
  if (!(sw > 0) || !(so > 0)) return { ok: false, reason: 'NO_VARIATION', message: 'The results do not vary: capability is undefined.' };
  return {
    ok: true,
    value: {
      n: values.length, mean: m, sigmaWithin: sw, sigmaOverall: so,
      cp: (usl - lsl) / (6 * sw), cpk: Math.min((usl - m) / (3 * sw), (m - lsl) / (3 * sw)),
      pp: (usl - lsl) / (6 * so), ppk: Math.min((usl - m) / (3 * so), (m - lsl) / (3 * so)),
    },
  };
}

// ---- Student t ---------------------------------------------------------------------------------------------------------------

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued fraction of the incomplete beta function (modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  let c = 1; let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t with df degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const p = 0.5 * incBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

/** The p-quantile of Student's t (0.5 < p < 1), by bisection on the CDF; accurate to well under 1e-9. */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0.5 && p < 1) || !(df >= 1)) throw new RangeError('tQuantile needs 0.5 < p < 1 and df >= 1.');
  let lo = 0; let hi = 1;
  while (tCdf(hi, df) < p && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-13 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}

// ---- regression and shelf life -----------------------------------------------------------------------------------------------

export interface Fit {
  n: number;
  slope: number;
  intercept: number;
  xBar: number;
  yBar: number;
  sxx: number;
  /** Residual standard error, sqrt(SSE / (n - 2)). */
  s: number;
  df: number;
  r2: number;
}

/** Ordinary least squares. Needs at least 3 points and at least 2 distinct x. */
export function ols(x: readonly number[], y: readonly number[]): Fit {
  const n = x.length;
  if (n !== y.length || n < 3) throw new RangeError('A regression needs at least 3 points.');
  const xBar = mean(x); const yBar = mean(y);
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - xBar) ** 2; sxy += (x[i] - xBar) * (y[i] - yBar); syy += (y[i] - yBar) ** 2; }
  if (!(sxx > 0)) throw new RangeError('A regression needs at least 2 distinct times.');
  const slope = sxy / sxx; const intercept = yBar - slope * xBar;
  const sse = Math.max(0, syy - slope * sxy);
  return { n, slope, intercept, xBar, yBar, sxx, s: Math.sqrt(sse / (n - 2)), df: n - 2, r2: syy > 0 ? 1 - sse / syy : 1 };
}

export const predict = (f: Fit, x: number): number => f.intercept + f.slope * x;

/** Half-width of the one-sided confidence bound of the mean response (kind 'confidence') or prediction bound of one result. */
export function boundHalfWidth(f: Fit, x: number, kind: 'confidence' | 'prediction' = 'confidence', confidence = 0.95): number {
  const t = tQuantile(confidence, f.df);
  return t * f.s * Math.sqrt((kind === 'prediction' ? 1 : 0) + 1 / f.n + (x - f.xBar) ** 2 / f.sxx);
}

export interface ShelfLifeOptions {
  lsl?: number | null;
  usl?: number | null;
  confidence?: number;
  /** Fewest points a fit may use. Default 4 (2 degrees of freedom). */
  minPoints?: number;
  /** How far past the last observation the supported claim may go: min(factor x last, last + extra) months. Default 2 and 12. */
  extrapolationFactor?: number;
  extrapolationExtraMonths?: number;
}

export const SHELF_LIFE_DEFAULTS = { confidence: 0.95, minPoints: 4, extrapolationFactor: 2, extrapolationExtraMonths: 12 } as const;

export interface ShelfLifeEstimate {
  n: number;
  fit: Fit;
  confidence: number;
  /** Months at which the one-sided confidence bound of the mean meets the first limit it reaches; null when it does not within the horizon. */
  estimateMonths: number | null;
  /** The same for the one-sided prediction bound of a single result (information only). */
  predictionMonths: number | null;
  /** Which limit and which side the estimate is bound by. */
  limiting: 'lower' | 'upper' | null;
  /** Observed span (largest time) and the longest claim the data supports without extrapolating further than the default allows. */
  observedMonths: number;
  extrapolationCapMonths: number;
  /** min(estimate, cap), rounded DOWN to a whole month: the figure a person may consider proposing. */
  supportedMonths: number;
  /** True when the cap, not the bound, limits the supported figure. */
  cappedByExtrapolation: boolean;
  /** The bound already violates a limit at time zero. */
  failsAtStart: boolean;
}

export type ShelfLifeResult = { ok: true; value: ShelfLifeEstimate } | { ok: false; reason: 'TOO_FEW_POINTS' | 'NO_TIME_SPREAD' | 'NO_LIMITS'; message: string };

/** First x in [0, horizon] at which `violates(x)` becomes true, refined by bisection; null when it never does. */
function firstCrossing(violates: (x: number) => boolean, horizon: number): number | null {
  if (violates(0)) return 0;
  const step = 0.05;
  let prev = 0;
  for (let x = step; x <= horizon + 1e-9; x += step) {
    if (violates(x)) {
      let lo = prev; let hi = x;
      for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (violates(mid)) hi = mid; else lo = mid; }
      return hi;
    }
    prev = x;
  }
  return null;
}

/**
 * Shelf-life estimate of one attribute from (months, result) pairs of ONE batch and condition: the earliest time at which the
 * one-sided `confidence` bound of the mean regression line crosses a specification limit (lower bound against LSL, upper bound
 * against USL). No pooling across batches is done here; the caller takes the shortest batch (conservative).
 */
export function shelfLife(months: readonly number[], values: readonly number[], opts: ShelfLifeOptions = {}): ShelfLifeResult {
  const confidence = opts.confidence ?? SHELF_LIFE_DEFAULTS.confidence;
  const minPoints = opts.minPoints ?? SHELF_LIFE_DEFAULTS.minPoints;
  const lsl = opts.lsl ?? null; const usl = opts.usl ?? null;
  if (lsl == null && usl == null) return { ok: false, reason: 'NO_LIMITS', message: 'The attribute has no numeric specification limit to reach.' };
  if (months.length < minPoints) return { ok: false, reason: 'TOO_FEW_POINTS', message: `A shelf-life estimate needs at least ${minPoints} time points; there are ${months.length}.` };
  if (new Set(months).size < 3) return { ok: false, reason: 'NO_TIME_SPREAD', message: 'A shelf-life estimate needs results at 3 or more distinct times.' };
  const fit = ols(months, values);
  const observed = Math.max(...months);
  const horizon = Math.max(60, observed * 5);
  const cross = (kind: 'confidence' | 'prediction') => {
    const lower = lsl == null ? null : firstCrossing(x => predict(fit, x) - boundHalfWidth(fit, x, kind, confidence) < lsl, horizon);
    const upper = usl == null ? null : firstCrossing(x => predict(fit, x) + boundHalfWidth(fit, x, kind, confidence) > usl, horizon);
    if (lower == null && upper == null) return { at: null as number | null, side: null as 'lower' | 'upper' | null };
    if (upper == null || (lower != null && lower <= upper)) return { at: lower, side: 'lower' as const };
    return { at: upper, side: 'upper' as const };
  };
  const c = cross('confidence'); const p = cross('prediction');
  const cap = Math.min(observed * (opts.extrapolationFactor ?? SHELF_LIFE_DEFAULTS.extrapolationFactor), observed + (opts.extrapolationExtraMonths ?? SHELF_LIFE_DEFAULTS.extrapolationExtraMonths));
  const reach = c.at ?? Infinity;
  const supported = Math.floor(Math.min(reach, cap) + 1e-9);
  return {
    ok: true,
    value: {
      n: fit.n, fit, confidence, estimateMonths: c.at, predictionMonths: p.at, limiting: c.side, observedMonths: observed,
      extrapolationCapMonths: cap, supportedMonths: supported, cappedByExtrapolation: reach > cap, failsAtStart: c.at === 0,
    },
  };
}
