// Request schemas of the QMS routes (roadmap M27). Strict. Owned by r2-qms.
// Server-controlled fields (id, state, version, origin, source, created_by, closed_at, signatures, action status) are never accepted:
// a state moves only through /transition or /sign, an action is completed only through /complete, and the record number is the
// server's. The payload of each record type has its own strict schema (QMS_PAYLOAD_SCHEMAS); the route validates the payload as a
// whole after merging an edit into what the record holds.
import { z } from 'zod';
import { signatureFields } from '../../lib/validations/signatures';
import { QMS_CLASSIFICATIONS, QMS_TYPES } from '../../db/schema/qms';

const text = (label: string, max = 200) => z.string(`${label} is required.`).trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);
const longText = (label: string, max = 5000) => z.string(`${label} must be text.`).trim().max(max, `${label} is too long (at most ${max} characters).`);
const expectedVersion = z.number('expectedVersion is required.').int().positive('Record version mismatch. Refresh required.');
const userId = (label: string) => z.string(`${label} is required.`).trim().min(1, `${label} is required.`).max(100);

/** A calendar day, YYYY-MM-DD, that exists. */
export function isCalendarDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const day = (label: string) => z.string(`${label} must be a date.`).refine(isCalendarDay, `${label} must be a calendar day written YYYY-MM-DD.`);
const classification = z.enum(QMS_CLASSIFICATIONS, { error: `classification must be one of ${QMS_CLASSIFICATIONS.join(', ')}.` });

// ---- payloads, one per record type ---------------------------------------------------------------------------------------------

export const QMS_PAYLOAD_SCHEMAS = {
  Deviation: z.object({
    occurredOn: day('Date of occurrence').optional(),
    area: longText('Area', 200).optional(),
    immediateAction: longText('Immediate action').optional(),
    impactAssessment: longText('Impact assessment').optional(),
    rootCause: longText('Root cause').optional(),
  }).strict(),
  CAPA: z.object({
    kind: z.enum(['Corrective', 'Preventive', 'Corrective and preventive'], { error: 'kind must be Corrective, Preventive or Corrective and preventive.' }).optional(),
    rootCause: longText('Root cause').optional(),
    plan: longText('Action plan').optional(),
    effectivenessCriteria: longText('Effectiveness criteria').optional(),
  }).strict(),
  ChangeControl: z.object({
    changeType: z.enum(['Specification', 'Role', 'Document', 'Equipment', 'Process', 'Other'], { error: 'changeType must be Specification, Role, Document, Equipment, Process or Other.' }).optional(),
    justification: longText('Justification').optional(),
    impactAssessment: longText('Impact assessment').optional(),
    implementationPlan: longText('Implementation plan').optional(),
    emergency: z.boolean('emergency must be true or false.').optional(),
  }).strict(),
  AuditFinding: z.object({
    auditRef: longText('Audit reference', 200).optional(),
    requirement: longText('Requirement').optional(),
    response: longText('Response').optional(),
  }).strict(),
} as const;

// ---- records -------------------------------------------------------------------------------------------------------------------

/** POST /qms/records. The record starts in its initial state with the number the server gives it. */
export const qmsCreateSchema = z.object({
  type: z.enum(QMS_TYPES, { error: `type must be one of ${QMS_TYPES.join(', ')}.` }),
  title: text('Title'),
  description: longText('Description').optional(),
  classification: classification.optional(),
  ownerId: userId('Owner').optional(),
  dueDate: day('Due date').optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** PUT /qms/records/:id. Content fields only while the record is in an editable state; owner and due date while it is not final. */
export const qmsUpdateSchema = z.object({
  title: text('Title').optional(),
  description: longText('Description').optional(),
  classification: classification.optional(),
  ownerId: userId('Owner').optional(),
  dueDate: day('Due date').optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  reason: z.string('A reason must be text.').trim().min(1).max(1000).optional(),
  expectedVersion,
}).strict();

/** POST /qms/records/:id/transition: an unsigned step. */
export const qmsTransitionSchema = z.object({
  to: text('Target state', 50),
  reason: z.string('A reason must be text.').trim().min(5, 'Give the reason (at least 5 characters).').max(1000).optional(),
  expectedVersion,
}).strict();

const signing = {
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: signatureFields.reason,
  expectedVersion,
};

/** POST /qms/records/:id/sign: a signed step. The meaning is the step's (src/server/qms/states.ts), never the client's. */
export const qmsSignSchema = z.object({ to: text('Target state', 50), ...signing }).strict();

/** POST /qms/records/:id/effectiveness: a signed effectiveness check of a CAPA in Effectiveness Check. */
export const qmsEffectivenessSchema = z.object({
  result: z.enum(['Effective', 'Not effective'], { error: 'result must be Effective or Not effective.' }),
  evidence: text('Evidence', 5000),
  ...signing,
}).strict();

export const QMS_LINK_TARGET_TYPES = ['QmsRecord', 'Sample', 'Batch', 'OOS', 'Specification', 'User', 'Instrument', 'Document'] as const;
/** POST /qms/records/:id/links. `implemented` and `source` are written by the server only. */
export const qmsLinkSchema = z.object({
  relation: z.enum(['capa', 'affects', 'related'], { error: 'relation must be capa, affects or related.' }),
  targetType: z.enum(QMS_LINK_TARGET_TYPES, { error: `targetType must be one of ${QMS_LINK_TARGET_TYPES.join(', ')}.` }),
  targetId: text('Target id', 200),
}).strict();

/** POST /qms/records/:id/comments */
export const qmsCommentSchema = z.object({ text: text('Comment', 5000) }).strict();

// ---- actions -------------------------------------------------------------------------------------------------------------------

/** POST /qms/records/:id/actions. The due date may not lie in the past. */
export const qmsActionCreateSchema = z.object({
  title: text('Action'),
  description: longText('Description').optional(),
  ownerId: userId('Owner'),
  dueDate: day('Due date'),
}).strict();

/** PUT /qms/actions/:id, while the action is Open. */
export const qmsActionUpdateSchema = z.object({
  title: text('Action').optional(),
  description: longText('Description').optional(),
  ownerId: userId('Owner').optional(),
  dueDate: day('Due date').optional(),
  reason: z.string('A reason is required.').trim().min(5, 'Give the reason for the change (at least 5 characters).').max(1000),
  expectedVersion,
}).strict();

/** POST /qms/actions/:id/complete: e-signed (QMS_ACTION_COMPLETION), with the evidence. */
export const qmsActionCompleteSchema = z.object({ evidenceRef: text('Evidence', 2000), ...signing }).strict();

/** POST /qms/actions/:id/cancel */
export const qmsActionCancelSchema = z.object({
  reason: z.string('A reason is required.').trim().min(5, 'Give the reason for cancelling (at least 5 characters).').max(1000),
  expectedVersion,
}).strict();

// ---- settings ------------------------------------------------------------------------------------------------------------------

/** PUT /qms/settings: e-signed (QMS_SETTING_CHANGE, reason required by the catalog). */
export const qmsSettingsSchema = z.object({
  changeControlRequired: z.boolean('changeControlRequired must be true or false.'),
  ...signing,
}).strict();

// ---- list filters --------------------------------------------------------------------------------------------------------------

export const qmsRecordQuerySchema = z.object({
  type: z.enum(QMS_TYPES).optional(),
  state: z.string().max(50).optional(),
  open: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
}).strict();

export const qmsActionQuerySchema = z.object({
  overdue: z.enum(['true', 'false']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  status: z.enum(['Open', 'Done', 'Cancelled']).optional(),
}).strict();
