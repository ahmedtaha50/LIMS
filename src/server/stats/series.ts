/**
 * The data of a control chart (roadmap M39, r3-spc): the numeric results of one parameter of one product, read with ONE join (samples,
 * results, the product by its material text), ordered by the time the result was entered (not by the sample's creation), with the
 * specification limits as they were when the result was entered (copied onto the result at registration).
 *
 * Only results of APPROVED samples are data. A viewer may opt in to see Testing and Pending Review samples (marked `approved: false`,
 * drawn hollow); those points are never used for limits, rules, capability or alerts. A rejected sample is never shown. Samples that
 * were pulled for a stability study (sample_context.origin 'stability') are not process data and are left out (they are trended by age
 * in the stability view). A value that is not a plain number (a qualifier such as "<0.1", a text) is counted, not plotted.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '../core/tx';
import { SERIES_LIMIT_DEFAULT, UNAPPROVED_STATES } from './constants';

export interface SeriesPoint {
  resultId: string;
  sampleId: string;
  batch: string;
  value: number;
  enteredAt: string;
  sampleState: string;
  approved: boolean;
  lower: number | null;
  upper: number | null;
  unit: string | null;
  specRevision: number | null;
}

export interface Series {
  points: SeriesPoint[];
  /** Results in the window that are not plain numbers, left out. */
  skippedNonNumeric: number;
  /** True when more points matched than were returned (the most recent are kept). */
  truncated: boolean;
}

export interface SeriesQuery {
  productId: string;
  parameter: string;
  from?: string;
  to?: string;
  includeUnapproved?: boolean;
  limit?: number;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
export const parseNumber = (t: string | null | undefined): number | null => {
  if (t == null) return null;
  const s = t.trim();
  if (!NUMBER.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const limitOf = (text: string | null, real: number | null): number | null => (text != null ? parseNumber(text) : real);

export async function loadSeries(ex: Executor, q: SeriesQuery): Promise<Series> {
  const limit = q.limit ?? SERIES_LIMIT_DEFAULT;
  const states = q.includeUnapproved ? ['Approved', ...UNAPPROVED_STATES] : ['Approved'];
  const res = await ex.execute(sql`
    SELECT r.id AS result_id, r.sample_id, r.value, r.entered_at, r.spec_min, r.spec_max, r.lower_text, r.upper_text, r.limit_kind, r.unit,
           s.batch, s.state, s.spec_revision
    FROM results r
    JOIN samples s ON s.id = r.sample_id
    JOIN products p ON lower(btrim(p.name)) = lower(btrim(s.material))
    LEFT JOIN sample_context sc ON sc.sample_id = s.id
    WHERE p.id = ${q.productId}
      AND r.parameter = ${q.parameter}
      AND r.entered_at IS NOT NULL
      AND r.value IS NOT NULL
      AND s.state IN (${sql.join(states.map(x => sql`${x}`), sql`, `)})
      AND COALESCE(sc.origin, 'registration') <> 'stability'
      ${q.from ? sql`AND r.entered_at >= ${q.from}::timestamptz` : sql``}
      ${q.to ? sql`AND r.entered_at <= ${q.to}::timestamptz` : sql``}
    ORDER BY r.entered_at DESC, r.id COLLATE "C" DESC`);
  const rows = (res as unknown as { rows: any[] }).rows;
  let skipped = 0;
  const points: SeriesPoint[] = [];
  for (const r of rows) {
    const value = parseNumber(r.value);
    if (value === null) { skipped++; continue; }
    points.push({
      resultId: r.result_id, sampleId: r.sample_id, batch: r.batch, value, enteredAt: new Date(r.entered_at).toISOString(), sampleState: r.state,
      approved: r.state === 'Approved', lower: limitOf(r.lower_text, r.spec_min), upper: limitOf(r.upper_text, r.spec_max),
      unit: r.unit ?? null, specRevision: r.spec_revision ?? null,
    });
  }
  const truncated = points.length > limit;
  return { points: points.slice(0, limit).reverse(), skippedNonNumeric: skipped, truncated };
}

/** The parameters of a product that have at least one numeric approved result, with their counts. */
export async function loadParameters(ex: Executor, productId: string): Promise<Array<{ parameter: string; approved: number; unit: string | null }>> {
  const res = await ex.execute(sql`
    SELECT r.parameter, count(*)::int AS approved, max(r.unit) AS unit
    FROM results r
    JOIN samples s ON s.id = r.sample_id
    JOIN products p ON lower(btrim(p.name)) = lower(btrim(s.material))
    LEFT JOIN sample_context sc ON sc.sample_id = s.id
    WHERE p.id = ${productId} AND s.state = 'Approved' AND r.entered_at IS NOT NULL
      AND r.value ~ '^\\s*[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?\\s*$'
      AND COALESCE(sc.origin, 'registration') <> 'stability'
    GROUP BY r.parameter
    ORDER BY r.parameter COLLATE "C"`);
  return (res as unknown as { rows: any[] }).rows.map(r => ({ parameter: r.parameter, approved: r.approved, unit: r.unit ?? null }));
}
