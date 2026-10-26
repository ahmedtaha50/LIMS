/**
 * From a series to a chart (roadmap M39, r3-spc): limits, the rule violations per point, capability. Advisory output only.
 * Limits come from the Approved baseline when there is one (then they are the signed, reproducible reference) and otherwise from the
 * approved points of the request (a provisional chart, labelled as such). Rules and capability use approved points only.
 */
import { capability, evaluateRules, imrLimits, RULE_LABELS, zScore, type CapabilityResult, type ControlLimits, type RuleSet, type RuleViolation } from '../../lib/spc';
import type { SeriesPoint } from './series';

export interface BaselineLimits { id: string; revision: number; ruleSet: RuleSet; n: number; cl: number; mrBar: number; sigma: number; ucl: number; lcl: number }

export interface ChartPoint extends SeriesPoint {
  index: number | null; // position among the approved points (null for an unapproved point)
  z: number | null;
  violations: Array<{ rule: string; label: string; severity: string; side: string }>;
}

export interface Analysis {
  limits: ControlLimits | null;
  limitsSource: 'baseline' | 'computed' | 'none';
  provisional: boolean;
  ruleSet: RuleSet;
  points: ChartPoint[];
  violations: RuleViolation[];
  capability: CapabilityResult | { ok: false; reason: 'NO_LIMITS'; message: string };
  specLimits: { lower: number | null; upper: number | null; changed: boolean };
}

export const PROVISIONAL_BELOW = 20;

export function limitsOfBaseline(b: BaselineLimits): ControlLimits {
  return { n: b.n, cl: b.cl, sigma: b.sigma, ucl: b.ucl, lcl: b.lcl, mrBar: b.mrBar, mrUcl: 3.267 * b.mrBar, method: 'IMR' };
}

export function analyse(points: SeriesPoint[], baseline: BaselineLimits | null, ruleSet?: RuleSet): Analysis {
  const approved = points.filter(p => p.approved);
  const rs: RuleSet = ruleSet ?? baseline?.ruleSet ?? 'nelson';
  const limits = baseline ? limitsOfBaseline(baseline) : approved.length >= 2 ? imrLimits(approved.map(p => p.value)) : null;
  const violations = limits ? evaluateRules(approved.map(p => p.value), limits, rs) : [];
  let a = 0;
  const chart: ChartPoint[] = points.map(p => {
    if (!p.approved) return { ...p, index: null, z: limits ? zScore(p.value, limits) : null, violations: [] };
    const index = a++;
    return {
      ...p, index, z: limits ? zScore(p.value, limits) : null,
      violations: violations.filter(v => v.index === index).map(v => ({ rule: v.rule, label: RULE_LABELS[v.rule], severity: v.severity, side: v.side })),
    };
  });

  // Capability against the specification in force at the latest approved result, over the approved points judged against it.
  const last = approved[approved.length - 1];
  const same = last ? approved.filter(p => p.lower === last.lower && p.upper === last.upper) : [];
  const cap = last ? capability(same.map(p => p.value), last.lower, last.upper) : { ok: false as const, reason: 'NO_LIMITS' as const, message: 'There are no approved results.' };
  return {
    limits, limitsSource: baseline ? 'baseline' : limits ? 'computed' : 'none', provisional: !baseline && approved.length < PROVISIONAL_BELOW, ruleSet: rs,
    points: chart, violations, capability: cap,
    specLimits: { lower: last?.lower ?? null, upper: last?.upper ?? null, changed: last ? same.length !== approved.length : false },
  };
}
