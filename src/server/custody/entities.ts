/**
 * The custody records that are e-signed (src/server/esign/registry.ts), and what a signature on each covers (hash version 2).
 *
 *   SampleReceipt   QA's acknowledgement of a receipt deviation (CUSTODY_DEVIATION_ACK): the receipt as recorded, the deviation and
 *                   who acknowledged it when. No route changes a receipt after it is recorded, except this acknowledgement, once.
 *   SampleRetain    the disposal of a retained sample (RETAIN_DISPOSAL): the retain row as disposed; nothing changes it afterwards.
 */
import { eq } from 'drizzle-orm';
import { sampleCustody, sampleRetains } from '../../db/schema/custody';
import { registerSignable } from '../esign';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

registerSignable({
  type: 'SampleReceipt',
  async canonical(ex, { id }) {
    const [r] = await ex.select().from(sampleCustody).where(eq(sampleCustody.sampleId, id)).limit(1);
    if (!r) return null;
    return {
      sampleId: r.sampleId, receivedAt: iso(r.receivedAt), receivedBy: r.receivedBy, condition: r.condition, sealIntact: r.sealIntact,
      temperatureC: r.temperatureC, requiredStorage: r.requiredStorage, requiredTempMin: r.requiredTempMin, requiredTempMax: r.requiredTempMax,
      mfgDate: r.mfgDate, expDate: r.expDate, deviation: r.deviation, deviationReasons: r.deviationReasons,
      deviationAckBy: r.deviationAckBy, deviationAckAt: iso(r.deviationAckAt),
    };
  },
});

registerSignable({
  type: 'SampleRetain',
  async canonical(ex, { id }) {
    const [r] = await ex.select().from(sampleRetains).where(eq(sampleRetains.id, id)).limit(1);
    if (!r) return null;
    return {
      id: r.id, sampleId: r.sampleId, containerId: r.containerId, retainUntil: r.retainUntil, status: r.status,
      disposedBy: r.disposedBy, disposedAt: iso(r.disposedAt), disposalMethod: r.disposalMethod,
    };
  },
});
