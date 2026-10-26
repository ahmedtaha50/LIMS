// The custody status of a sample (roadmap M29), parallel to its lifecycle state: SampleState is not changed by custody. Read by the
// Logged -> Testing guard (src/server/workflow/guards/custody.ts), the custody routes and the scan lookup (GET /resolve).
import { and, eq } from 'drizzle-orm';
import { sampleCustody, sampleRetains } from '../../db/schema/custody';
import type { Executor } from '../core/tx';

export type Receipt = typeof sampleCustody.$inferSelect;

export const CUSTODY_STATUSES = ['Not received', 'Received', 'Deviation: awaiting QA', 'Deviation acknowledged'] as const;
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number];

export function custodyStatus(receipt: Receipt | null | undefined): CustodyStatus {
  if (!receipt) return 'Not received';
  if (receipt.deviation) return receipt.deviationAckAt ? 'Deviation acknowledged' : 'Deviation: awaiting QA';
  return 'Received';
}

export const readReceipt = async (ex: Executor, sampleId: string): Promise<Receipt | null> =>
  (await ex.select().from(sampleCustody).where(eq(sampleCustody.sampleId, sampleId)).limit(1))[0] ?? null;

/** The open retain of a container (status Retained), or null. */
export const activeRetainOf = async (ex: Executor, containerId: string) =>
  (await ex.select().from(sampleRetains).where(and(eq(sampleRetains.containerId, containerId), eq(sampleRetains.status, 'Retained'))).limit(1))[0] ?? null;

/** Why testing may not start on the sample, or null. */
export function receiptBlocker(sampleId: string, receipt: Receipt | null | undefined): string | null {
  switch (custodyStatus(receipt)) {
    case 'Not received':
      return `Sample ${sampleId} has not been received: record its receipt (condition, seal, temperature) before testing starts.`;
    case 'Deviation: awaiting QA':
      return `Sample ${sampleId} has a receipt deviation (${receipt!.deviationReasons}) that QA has not acknowledged: testing may not start until QA signs the acknowledgement.`;
    default:
      return null;
  }
}

/** today as YYYY-MM-DD, in UTC (the dates of this domain are calendar dates without a zone). */
export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * The deviation a receipt raises, as reasons (empty when there is none): a temperature outside the required range, no temperature
 * where a range is required, a broken seal, a condition other than Intact, a sample already past its expiry date.
 */
export function receiptDeviations(r: {
  condition: string; sealIntact: boolean; temperatureC?: number | null; requiredTempMin?: number | null; requiredTempMax?: number | null;
  expDate?: string | null; receivedAt: Date;
}): string[] {
  const out: string[] = [];
  const hasRange = r.requiredTempMin != null || r.requiredTempMax != null;
  const range = `${r.requiredTempMin ?? '-∞'} to ${r.requiredTempMax ?? '+∞'} °C`;
  if (hasRange && r.temperatureC == null) out.push(`no temperature was measured on receipt, required ${range}`);
  else if (r.temperatureC != null && ((r.requiredTempMin != null && r.temperatureC < r.requiredTempMin) || (r.requiredTempMax != null && r.temperatureC > r.requiredTempMax))) {
    out.push(`temperature on receipt ${r.temperatureC} °C is outside the required ${range}`);
  }
  if (!r.sealIntact) out.push('the seal was broken');
  if (r.condition !== 'Intact') out.push(`the container was ${r.condition.toLowerCase()}`);
  if (r.expDate && r.expDate < todayIso(r.receivedAt)) out.push(`the sample expired on ${r.expDate}`);
  return out;
}
