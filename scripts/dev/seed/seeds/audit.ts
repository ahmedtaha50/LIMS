// Demo data: Chained Audit Trail & Digital Hash Chain. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import { createHash, randomBytes } from 'crypto';
import type { Db } from '../../../../src/server/core/context';
import { auditTrail } from '../../../../src/db/schema';

export async function seedAuditTrail(db: Db): Promise<void> {
  const existingAudit = await db.select().from(auditTrail);
  if (existingAudit.length === 0) {
    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const auditSeed = [
      { sequence: 1, action: 'Create', entity: 'Sample', entityId: 'SMP-2026-00001', field: 'all', oldValue: '', newValue: '{"material":"Paracetamol 500mg Finished Tablets","batch":"BATCH-2026-001"}', reason: 'Initial Batch Registration' },
      { sequence: 2, action: 'Dispense', entity: 'BatchMaterial', entityId: 'BM-PARA-API', field: 'quantityDispensed', oldValue: '', newValue: '500.00 kg API Dispensed & CoA Verified', reason: 'Dispensing per Manufacturing Order MO-2026-104' },
      { sequence: 3, action: 'Update', entity: 'Result', entityId: 'RES-001-1', field: 'value', oldValue: '', newValue: '99.8', reason: 'HPLC Assay result quantified per USP <621>' },
      { sequence: 4, action: 'Update', entity: 'Result', entityId: 'RES-001-2', field: 'value', oldValue: '', newValue: '94.2', reason: 'Dissolution testing completed per USP <711>' },
      { sequence: 5, action: 'Approve', entity: 'Sample', entityId: 'SMP-2026-00001', field: 'state', oldValue: 'Pending Review', newValue: 'Approved', reason: 'All analytical specifications confirmed within limits' },
      { sequence: 6, action: 'Create', entity: 'Sample', entityId: 'SMP-2026-00002', field: 'all', oldValue: '', newValue: '{"material":"Amoxicillin 250mg/5mL Oral Suspension","batch":"BATCH-2026-002"}', reason: 'Initial Batch Registration' },
      { sequence: 7, action: 'Release', entity: 'BatchRelease', entityId: 'BATCH-2026-002', field: 'status', oldValue: 'Quarantine', newValue: 'Released', reason: 'Qualified Person final release authorization' },
    ];

    for (const item of auditSeed) {
      const timestamp = new Date().toISOString();
      const content = JSON.stringify({
        sequence: item.sequence,
        timestamp,
        userId: 'usr-admin',
        action: item.action,
        entity: item.entity,
        entityId: item.entityId,
        field: item.field,
        oldValue: item.oldValue,
        newValue: item.newValue,
        reason: item.reason
      });
      const hash = createHash('sha256').update(content + prevHash).digest('hex');

      await db.insert(auditTrail).values({
        id: `adt-${randomBytes(6).toString('hex')}`,
        sequence: item.sequence,
        userId: 'usr-admin',
        action: item.action,
        entity: item.entity,
        entityId: item.entityId,
        field: item.field,
        oldValue: item.oldValue,
        newValue: item.newValue,
        reason: item.reason,
        hash,
        prevHash,
        timestampStr: timestamp
      });

      prevHash = hash;
    }
  }
}
