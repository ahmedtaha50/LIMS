/**
 * Shelf-life estimation from the stability programme (roadmap M39, r3-spc; the approach of ICH Q1E, as stated in src/lib/spc.ts).
 * The data are the approved results of the samples pulled at the timepoints of a study (stability_timepoints.sample_id), read with one
 * join; the time axis is the timepoint's month point. One regression per study (batch) and storage condition: no pooling across batches,
 * and the figure to consider for a product at a condition is the SHORTEST supported estimate of its batches (conservative). The
 * specification limits are those the latest result was judged against.
 *
 * ADVISORY: the estimate proposes nothing and changes nothing. Setting a retest period or shelf life is a controlled decision.
 */
import { sql } from 'drizzle-orm';
import { shelfLife, SHELF_LIFE_DEFAULTS, type ShelfLifeEstimate } from '../../lib/spc';
import type { Executor } from '../core/tx';
import { parseNumber } from './series';

export interface StabilityPoint { month: number; value: number; resultId: string; sampleId: string; lower: number | null; upper: number | null }

export interface StabilityGroup {
  studyId: string;
  batch: string;
  conditionCode: string;
  points: StabilityPoint[];
  lower: number | null;
  upper: number | null;
  /** The limits changed between the points (a specification revision): the estimate uses the latest. */
  limitsChanged: boolean;
  estimate: { ok: true; value: ShelfLifeEstimate } | { ok: false; reason: string; message: string };
}

export interface StabilityTrend {
  productId: string;
  parameter: string;
  defaults: typeof SHELF_LIFE_DEFAULTS;
  groups: StabilityGroup[];
  /** Per condition: the shortest supported estimate over the batches that have one, and which batch it is. */
  conditions: Array<{ conditionCode: string; supportedMonths: number | null; estimateMonths: number | null; limitingBatch: string | null; batches: number; estimated: number }>;
}

export async function loadStabilityTrend(ex: Executor, q: { productId: string; parameter: string; conditionCode?: string }): Promise<StabilityTrend> {
  const res = await ex.execute(sql`
    SELECT tp.study_id, tp.condition_code, tp.month, st.batch, s.id AS sample_id, r.id AS result_id, r.value, r.spec_min, r.spec_max, r.lower_text, r.upper_text
    FROM stability_timepoints tp
    JOIN stability_studies st ON st.id = tp.study_id
    JOIN stability_study_links l ON l.study_id = st.id
    JOIN samples s ON s.id = tp.sample_id
    JOIN results r ON r.sample_id = s.id AND r.parameter = ${q.parameter}
    WHERE l.product_id = ${q.productId} AND s.state = 'Approved' AND r.value IS NOT NULL
      ${q.conditionCode ? sql`AND tp.condition_code = ${q.conditionCode}` : sql``}
    ORDER BY tp.condition_code COLLATE "C", tp.study_id COLLATE "C", tp.month`);
  const rows = (res as unknown as { rows: any[] }).rows;
  const byKey = new Map<string, StabilityGroup>();
  for (const r of rows) {
    const value = parseNumber(r.value);
    if (value === null) continue;
    const key = `${r.condition_code}\u0000${r.study_id}`;
    let g = byKey.get(key);
    if (!g) { g = { studyId: r.study_id, batch: r.batch, conditionCode: r.condition_code, points: [], lower: null, upper: null, limitsChanged: false, estimate: { ok: false, reason: 'TOO_FEW_POINTS', message: '' } }; byKey.set(key, g); }
    g.points.push({
      month: r.month, value, resultId: r.result_id, sampleId: r.sample_id,
      lower: r.lower_text != null ? parseNumber(r.lower_text) : r.spec_min, upper: r.upper_text != null ? parseNumber(r.upper_text) : r.spec_max,
    });
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    const last = g.points[g.points.length - 1];
    g.lower = last.lower; g.upper = last.upper;
    g.limitsChanged = g.points.some(p => p.lower !== last.lower || p.upper !== last.upper);
    const est = shelfLife(g.points.map(p => p.month), g.points.map(p => p.value), { lsl: g.lower, usl: g.upper });
    g.estimate = est.ok ? { ok: true, value: est.value } : { ok: false, reason: est.reason, message: est.message };
  }

  const conditions = new Map<string, StabilityGroup[]>();
  for (const g of groups) conditions.set(g.conditionCode, [...(conditions.get(g.conditionCode) ?? []), g]);
  return {
    productId: q.productId, parameter: q.parameter, defaults: SHELF_LIFE_DEFAULTS, groups,
    conditions: [...conditions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([conditionCode, gs]) => {
      const ok = gs.filter((g): g is StabilityGroup & { estimate: { ok: true; value: ShelfLifeEstimate } } => g.estimate.ok);
      let worst: (typeof ok)[number] | null = null;
      for (const g of ok) if (!worst || g.estimate.value.supportedMonths < worst.estimate.value.supportedMonths) worst = g;
      return {
        conditionCode, supportedMonths: worst ? worst.estimate.value.supportedMonths : null, estimateMonths: worst ? worst.estimate.value.estimateMonths : null,
        limitingBatch: worst ? worst.batch : null, batches: gs.length, estimated: ok.length,
      };
    }),
  };
}
