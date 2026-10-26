// Strict request schemas of the worklist routes (roadmap M33). Owned by r2-worklists. Server-controlled fields (id, status, version,
// the person and the time of every step, positions) are not accepted: an unknown key is a 400 (AGENTS.md s.3). The route table
// (src/server/authz/routeTable.ts) names the same schemas as the bodies of the rules, so the two cannot drift.
import { z } from 'zod';
import { resultsBatchItemSchema, RESULTS_BATCH_MAX } from '../../lib/validations/results-batch';

export const WORKLIST_STATUSES = ['Draft', 'Released', 'Completed', 'Cancelled'] as const;
export const ITEM_KINDS = ['Sample', 'Standard', 'Blank', 'SST', 'Control'] as const;

const id = z.string().trim().min(1).max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.').refine(d => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Not a calendar date.');
const version = z.number('expectedVersion must be a number').int().min(1);
/** A reason is optional for a Draft and required (5 characters) once the worklist is Released: the service decides, and audits a refusal. */
const optionalReason = z.string().trim().min(5, 'reason: at least 5 characters.').max(1000).optional();
const requiredReason = z.string('reason is required.').trim().min(5, 'reason: at least 5 characters.').max(1000);

/** POST /worklists */
export const worklistCreateSchema = z.object({
  title: z.string().trim().min(3, 'title: at least 3 characters.').max(200),
  methodCode: z.string().trim().min(1, 'methodCode is required.').max(100),
  instrumentId: id.optional(),
  plannedDate: isoDate,
  notes: z.string().trim().max(2000).optional(),
}).strict();

/** PUT /worklists/:id. The method of a worklist never changes. */
export const worklistUpdateSchema = z.object({
  title: z.string().trim().min(3, 'title: at least 3 characters.').max(200).optional(),
  instrumentId: id.nullable().optional(),
  plannedDate: isoDate.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  reason: optionalReason,
  expectedVersion: version,
}).strict().refine(b => b.title !== undefined || b.instrumentId !== undefined || b.plannedDate !== undefined || b.notes !== undefined,
  { message: 'Nothing to change: give a title, instrumentId, plannedDate or notes.' });

/** POST /worklists/:id/items */
export const itemAddSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  sampleId: id.optional(),
  resultId: id.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  assigneeId: id.optional(),
  reason: optionalReason,
}).strict().superRefine((b, ctx) => {
  if (b.kind === 'Sample') {
    if (!b.sampleId) ctx.addIssue({ code: 'custom', path: ['sampleId'], message: 'A Sample item needs sampleId.' });
    if (!b.resultId) ctx.addIssue({ code: 'custom', path: ['resultId'], message: 'A Sample item needs resultId.' });
    if (!b.assigneeId) ctx.addIssue({ code: 'custom', path: ['assigneeId'], message: 'A Sample item needs the analyst who runs it (assigneeId).' });
  } else {
    if (b.sampleId || b.resultId) ctx.addIssue({ code: 'custom', path: ['sampleId'], message: `A ${b.kind} item names no sample or result.` });
    if (!b.label) ctx.addIssue({ code: 'custom', path: ['label'], message: `A ${b.kind} item needs a label.` });
  }
});

/** PUT /worklists/:id/items/:itemId: reassign a Sample item, or relabel / assign another item. */
export const itemUpdateSchema = z.object({
  assigneeId: id.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  reason: optionalReason,
  expectedVersion: version,
}).strict().refine(b => b.assigneeId !== undefined || b.label !== undefined, { message: 'Nothing to change: give assigneeId or label.' });

/** POST /worklists/:id/items/:itemId/remove */
export const itemRemoveSchema = z.object({ reason: optionalReason, expectedVersion: version }).strict();

/** POST /worklists/:id/reorder: every Active item once, in the new run order. */
export const reorderSchema = z.object({
  itemIds: z.array(id).min(1).max(1000).refine(a => new Set(a).size === a.length, 'An item appears more than once.'),
  reason: optionalReason,
}).strict();

export const releaseSchema = z.object({ expectedVersion: version }).strict();
export const completeSchema = z.object({ reason: optionalReason, expectedVersion: version }).strict();
export const cancelSchema = z.object({ reason: requiredReason, expectedVersion: version }).strict();

/** PUT /worklists/:id/grid: the cells of the run (one result each) as the result workbench sends them. Each cell is saved on its own. */
export const gridSaveSchema = z.object({
  cells: z.array(resultsBatchItemSchema, 'cells must be a list.').min(1, 'Nothing to save: cells is empty.').max(RESULTS_BATCH_MAX, `At most ${RESULTS_BATCH_MAX} cells per save.`)
    .superRefine((cells, ctx) => {
      const seen = new Set<string>();
      cells.forEach((c, i) => {
        if (seen.has(c.resultId)) ctx.addIssue({ code: 'custom', path: [i, 'resultId'], message: `Result ${c.resultId} appears more than once in one save.` });
        seen.add(c.resultId);
      });
    }),
}).strict();

/** GET /worklists */
export const listQuerySchema = z.object({
  status: z.enum(WORKLIST_STATUSES).optional(),
  methodCode: z.string().trim().min(1).max(100).optional(),
  instrumentId: id.optional(),
  assigneeId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();

/** GET /worklists/workload */
export const workloadQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

/** GET /worklists/candidates */
export const candidatesQuerySchema = z.object({ methodCode: z.string().trim().min(1, 'methodCode is required.').max(100) }).strict();

export const emptyBody = z.object({}).strict();
