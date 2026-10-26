/**
 * Specifications as the rest of the application uses them (roadmap M11). Owned by r1-spec.
 *
 *   resolveActiveSpec(ex, material, on?)   THE way to choose the specification a sample is tested against: the Active revision of the
 *                                          material with the latest effective date on or before the day asked for (today by default).
 *                                          Registration (r1-results-oos) calls it inside the sample's transaction and keeps the id and
 *                                          the revision it returns, so a sample stays bound to the revision it was registered under.
 *   todayIso(now?)                         the laboratory's calendar day, YYYY-MM-DD, on this machine (not the UTC day).
 *   materialKey(material)                  the key by which two spellings of a material are the same material.
 *   effectivenessOf(rows, today)           what each revision of a material is today: Draft, Scheduled, Effective, Superseded, Unusable.
 *
 * Effective dates are calendar days written YYYY-MM-DD and compared as text. A row whose effective date is not such a day (v0.1.0
 * accepted any text) is never selected: it fails closed, and the list shows it as Unusable until a revision replaces it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { specifications } from '../../db/schema';
import { isEffectiveDate, normalizeParameters, type SpecParameter } from '../../lib/validations/specifications';
import type { Executor } from '../core/tx';

export interface ResolvedSpec {
  id: string;
  material: string;
  /** The revision number (specifications.revision_label), the one the sample keeps. */
  revision: number;
  effectiveDate: string;
  parameters: SpecParameter[];
}

export type Effectiveness = 'Draft' | 'Scheduled' | 'Effective' | 'Superseded' | 'Unusable';

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day of `now` on this machine, YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Case, surrounding spaces and runs of spaces do not make a different material. */
export const materialKey = (material: string): string => material.trim().replace(/\s+/g, ' ').toLowerCase();

/** The same normalisation in SQL, for a WHERE clause on specifications.material (or any material column). */
export const materialKeySql = (column: unknown) => sql`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`;

function dayOf(on: Date | string | undefined): string {
  if (on === undefined) return todayIso();
  if (on instanceof Date) {
    if (Number.isNaN(on.getTime())) throw new Error('resolveActiveSpec: the date is not a valid date (expected a Date or YYYY-MM-DD).');
    return todayIso(on);
  }
  if (!isEffectiveDate(on)) throw new Error(`resolveActiveSpec: "${on}" is not a calendar day written YYYY-MM-DD.`);
  return on;
}

interface RevisionRow { id: string; status: string; effectiveDate: string; revisionLabel: number }

/** Of the Active revisions, the one in force on `day`: latest effective date on or before it, the higher revision on a tie. */
export function inForce<T extends RevisionRow>(rows: readonly T[], day: string): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.status !== 'Active' || !isEffectiveDate(r.effectiveDate) || r.effectiveDate > day) continue;
    if (!best || r.effectiveDate > best.effectiveDate || (r.effectiveDate === best.effectiveDate && r.revisionLabel > best.revisionLabel)) best = r;
  }
  return best;
}

/** What each revision of ONE material is on `day`. */
export function effectivenessOf<T extends RevisionRow>(rows: readonly T[], day: string): Map<string, Effectiveness> {
  const current = inForce(rows, day);
  const out = new Map<string, Effectiveness>();
  for (const r of rows) {
    if (r.status === 'Draft') out.set(r.id, 'Draft');
    else if (r.status !== 'Active') out.set(r.id, 'Superseded');
    else if (!isEffectiveDate(r.effectiveDate)) out.set(r.id, 'Unusable');
    else if (r.effectiveDate > day) out.set(r.id, 'Scheduled');
    else out.set(r.id, r.id === current?.id ? 'Effective' : 'Superseded');
  }
  return out;
}

/**
 * The specification a sample of `material` registered on `on` (default today) is tested against, or null when the material has none in
 * force that day. Works on the database or inside a transaction. The material is matched by materialKey (case and spacing do not matter;
 * POST /specifications refuses two spellings of one material).
 */
export async function resolveActiveSpec(ex: Executor, material: string, on?: Date | string): Promise<ResolvedSpec | null> {
  const day = dayOf(on);
  const rows = await ex.select().from(specifications)
    .where(and(eq(specifications.status, 'Active'), sql`${materialKeySql(specifications.material)} = ${materialKey(material)}`));
  const chosen = inForce(rows, day);
  if (!chosen) return null;
  return {
    id: chosen.id, material: chosen.material, revision: chosen.revisionLabel, effectiveDate: chosen.effectiveDate,
    parameters: normalizeParameters(chosen.parameters),
  };
}
