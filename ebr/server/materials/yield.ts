import type { Client, Pool } from '../core/db.js';
import { settingsOf } from '../settings/index.js';

/**
 * E29: the yield limits of a batch. A master batch record may set its own (`yieldLimits` in its design, approved by QA with
 * the version); the batch uses the limits of the very version it was made from. Without them the site limits apply (site
 * settings yield.minPct and yield.maxPct, default 95 to 102 percent). The source is returned so the exception can name it.
 */
export type YieldLimits = { min: number; max: number; source: string };

export async function yieldLimitsFor(c: Client | Pool, batchId: string): Promise<YieldLimits> {
  const r = (await c.query<{ limits: { minPct: number; maxPct: number } | null; code: string; version_no: number }>(
    `SELECT v.design->'yieldLimits' AS limits, m.code, v.version_no
       FROM batches b JOIN mbr_versions v ON v.id = b.mbr_version_id JOIN mbr_masters m ON m.id = b.mbr_master_id WHERE b.id = $1`, [batchId])).rows[0];
  if (r?.limits) return { min: r.limits.minPct, max: r.limits.maxPct, source: `recipe ${r.code} version ${r.version_no}` };
  const s = await settingsOf(c, ['yield.minPct', 'yield.maxPct'] as const);
  return { min: Number(s['yield.minPct']), max: Number(s['yield.maxPct']), source: 'site limits' };
}
