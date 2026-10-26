/**
 * The training record types that are e-signed (src/server/esign/registry.ts), hash version 2.
 *
 *   TrainingAssignment     read and understood (TRAINING_ACKNOWLEDGEMENT, by the trainee) or on-the-job certification
 *                          (TRAINING_CERTIFICATION, by a trainer who is not the trainee). The signature covers who was trained, on what
 *                          (curriculum, document version and the sha256 of its file), how, and the completion as the audit entry
 *                          recorded it. A completed assignment never changes (trigger gxp_training_assignments_row_guard).
 *   TrainingRecord         a certification of a named module (POST /training/:userId/certify, TRAINING_CERTIFICATION by Admin or QA):
 *                          who, which module, by whom and when; the row is written once.
 *   AnalystQualification   a QA override (QUALIFICATION_OVERRIDE): user, method, period and reason, frozen at grant; a revocation
 *                          changes only status and revocation fields, which the content does not cover.
 */
import { eq } from 'drizzle-orm';
import { documentVersions } from '../../db/schema/documents';
import { trainingRecords } from '../../db/schema';
import { analystQualifications, trainingAssignments } from '../../db/schema/training';
import { registerSignable } from '../esign';

registerSignable({
  type: 'TrainingAssignment',
  async canonical(ex, { id, change }) {
    if (!change) return null;
    const [row] = await ex.select({ a: trainingAssignments, fileSha256: documentVersions.fileSha256 }).from(trainingAssignments)
      .leftJoin(documentVersions, eq(documentVersions.id, trainingAssignments.documentVersionId)).where(eq(trainingAssignments.id, id)).limit(1);
    if (!row) return null;
    const a = row.a;
    return {
      id: a.id, userId: a.userId, curriculumId: a.curriculumId, documentId: a.documentId, documentVersionId: a.documentVersionId, fileSha256: row.fileSha256,
      trainingMethod: a.trainingMethod, event: { action: change.action, field: change.field, oldValue: change.oldValue, newValue: change.newValue },
    };
  },
});

registerSignable({
  type: 'AnalystQualification',
  async canonical(ex, { id }) {
    const [q] = await ex.select().from(analystQualifications).where(eq(analystQualifications.id, id)).limit(1);
    if (!q) return null;
    return { id: q.id, userId: q.userId, methodCode: q.methodCode, basis: q.basis, reason: q.reason, validUntil: q.validUntil, grantedBy: q.grantedBy };
  },
});

registerSignable({
  type: 'TrainingRecord',
  async canonical(ex, { id }) {
    const [r] = await ex.select().from(trainingRecords).where(eq(trainingRecords.id, id)).limit(1);
    if (!r) return null;
    return { id: r.id, userId: r.userId, moduleName: r.moduleName, certifiedBy: r.certifiedBy, completedAt: r.completedAt?.toISOString() ?? null };
  },
});
