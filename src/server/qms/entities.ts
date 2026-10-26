/**
 * The QMS record types that are e-signed (src/server/esign/registry.ts), and what a signature on each covers (hash version 2).
 *
 *   QmsRecord               the content that is frozen once the record leaves its editable states (states.ts): type, title,
 *                           description, classification, payload, where it came from, and the state as signed. For a change control,
 *                           also the records it affects (links can only be added while it is editable), so the approval covers the
 *                           scope it authorises. Owner and due date are not covered: they may be reassigned until the record is final.
 *   QmsAction               the action as completed: frozen once Done.
 *   QmsEffectivenessCheck   the check row (append-only).
 *   QmsSettings             the setting as signed (an event on a row that keeps changing; the audit chain protects it).
 */
import { and, asc, eq } from 'drizzle-orm';
import { qmsActions, qmsEffectivenessChecks, qmsLinks, qmsRecords, qmsSettings } from '../../db/schema/qms';
import { asSigned, registerSignable } from '../esign';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

registerSignable({
  type: 'QmsRecord',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(qmsRecords).where(eq(qmsRecords.id, id)).limit(1);
    if (!row) return null;
    const content: Record<string, unknown> = {
      id: row.id, type: row.type, title: row.title, description: row.description, classification: row.classification, payload: row.payload,
      origin: row.origin, sourceType: row.sourceType, sourceId: row.sourceId, createdBy: row.createdBy, state: asSigned(change, ['state'], row.state),
    };
    if (row.type === 'ChangeControl') {
      const affects = await ex.select({ targetType: qmsLinks.targetType, targetId: qmsLinks.targetId }).from(qmsLinks)
        .where(and(eq(qmsLinks.recordId, id), eq(qmsLinks.relation, 'affects'))).orderBy(asc(qmsLinks.targetType), asc(qmsLinks.targetId));
      content.affects = affects;
    }
    return content;
  },
});

registerSignable({
  type: 'QmsAction',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(qmsActions).where(eq(qmsActions.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, recordId: row.recordId, title: row.title, description: row.description, ownerId: row.ownerId, dueDate: row.dueDate,
      evidenceRef: row.evidenceRef, completedBy: row.completedBy, completedAt: iso(row.completedAt), status: asSigned(change, ['status'], row.status),
    };
  },
});

registerSignable({
  type: 'QmsEffectivenessCheck',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(qmsEffectivenessChecks).where(eq(qmsEffectivenessChecks.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, recordId: row.recordId, result: row.result, evidence: row.evidence, recordVersion: row.recordVersion, checkedBy: row.checkedBy, checkedAt: iso(row.checkedAt) };
  },
});

registerSignable({
  type: 'QmsSettings',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(qmsSettings).where(eq(qmsSettings.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, changeControlRequired: asSigned(change, ['change_control_required'], String(row.changeControlRequired)) };
  },
});
