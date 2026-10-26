import { z } from 'zod';
import { OOS_PHASES } from '../constants/oos';
import { OOS_RESULT_CHANGE_CODES } from '../constants/results';
import { signatureFields } from './signatures';

/**
 * The decisions QA signs on closure (roadmap M26, FDA OOS guidance): the OOS is confirmed, the investigation could not conclude, or the
 * original result was invalidated by an assignable laboratory cause. Shared by the server and the screen. The older word list of
 * src/lib/constants/oos.ts (OOS_DECISIONS) is a subset.
 */
export const OOS_CLOSURE_DECISIONS = ['Confirmed OOS', 'Inconclusive', 'Invalidated'] as const;
export type OosClosureDecision = (typeof OOS_CLOSURE_DECISIONS)[number];

export const OOS_TASK_STATUSES = ['Open', 'Done', 'Not applicable'] as const;
export const OOS_TASK_PHASES = ['Phase I', 'Phase II'] as const;
export const OOS_RETEST_BASES = ['Assignable cause', 'Phase II protocol'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.');
const version = z.number('expectedVersion must be a number').int().min(1);
const id = z.string().min(1).max(100);

/**
 * POST /oos: open an investigation by hand (an OOS result opens one by itself). The parameter comes from the result and the date
 * raised is the server's; `parameter` and `dateRaised` are still accepted because older screens send them, and are not used.
 */
export const oosOpenSchema = z.object({
  sampleId: z.string('sampleId is required.').min(1, 'sampleId is required.').max(100),
  resultId: z.string('resultId is required.').min(1, 'resultId is required.').max(100),
  parameter: z.string().max(200).optional(),
  dateRaised: z.string().max(40).optional(),
}).strict();

/** PUT /oos/:id: the investigation's findings and its phase (forward only). The status moves only with the closure signature. */
export const oosUpdateSchema = z.object({
  rootCause: z.string().max(4000).nullable().optional(),
  conclusion: z.string().max(4000).nullable().optional(),
  assignedTo: z.string().max(100).nullable().optional(),
  phase: z.enum(OOS_PHASES, { error: `phase must be one of ${OOS_PHASES.join(', ')}.` }).optional(),
  expectedVersion: version,
}).strict();

/** POST /oos/:id/close: signed by QA (meaning OOS_CLOSURE, chosen by the server). The decision is required. */
export const closeOosSchema = z.object({
  rootCause: z.string().trim().min(5, 'Root cause is required (minimum 5 characters)').max(4000),
  conclusion: z.string().trim().min(5, 'Conclusion / CAPA plan is required (minimum 5 characters)').max(4000),
  decision: z.enum(OOS_CLOSURE_DECISIONS, { error: `decision is required: one of ${OOS_CLOSURE_DECISIONS.join(', ')}.` }),
  password: z.string().min(1, 'Password required for electronic signature').max(1024),
  totpCode: signatureFields.totpCode,
  expectedVersion: z.number().int().optional(),
}).strict();

const credentials = {
  password: z.string().min(1, 'Password required for electronic signature').max(1024),
  totpCode: signatureFields.totpCode,
};

/** POST /oos/:id/tasks: apply a checklist template, or add one task by hand. */
export const oosTaskCreateSchema = z.object({
  templateId: id.optional(),
  title: z.string().trim().min(3, 'title: at least 3 characters.').max(300).optional(),
  phase: z.enum(OOS_TASK_PHASES).optional(),
  ownerId: id.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
}).strict().refine(b => (b.templateId === undefined) !== (b.title === undefined), 'Send either templateId (apply a checklist) or title (one task).');

/** PUT /oos/:id/tasks/:taskId: owner and due date of an open task, or its completion (Done or Not applicable) with the finding. */
export const oosTaskUpdateSchema = z.object({
  status: z.enum(['Done', 'Not applicable'], { error: 'status must be Done or Not applicable.' }).optional(),
  finding: z.string().trim().min(5, 'finding: at least 5 characters.').max(4000).optional(),
  ownerId: id.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  expectedVersion: version,
}).strict();

/** PUT /oos/:id/assignable-cause: the investigator's Phase I finding of a laboratory cause. */
export const oosAssignableCauseSchema = z.object({
  category: z.enum(OOS_RESULT_CHANGE_CODES, { error: `category must be one of ${OOS_RESULT_CHANGE_CODES.join(', ')}.` }),
  description: z.string().trim().min(10, 'description: at least 10 characters, with the evidence.').max(4000),
  expectedVersion: version,
}).strict();

/** POST /oos/:id/assignable-cause/confirm: QA's signature (OOS_INVALIDATION, reason required) invalidating the original result. */
export const oosConfirmCauseSchema = z.object({
  ...credentials,
  reason: z.string().trim().min(5, 'reason: at least 5 characters.').max(2000),
  expectedVersion: version,
}).strict();

/** POST /oos/:id/retest-plan: QA's signature (OOS_RETEST_AUTHORISATION) on the retest plan, before any retest. */
export const oosRetestPlanSchema = z.object({
  justification: z.string().trim().min(10, 'justification: at least 10 characters.').max(4000),
  maxRetests: z.number('maxRetests must be a number').int().min(1).max(10),
  ...credentials,
  reason: z.string().max(2000).optional(),
  expectedVersion: version,
}).strict();

/** POST /oos/:id/retests: one retest under the plan. The value is evaluated against the limit of the original result. */
export const oosRetestSchema = z.object({
  value: z.string().trim().min(1, 'value is required.').max(200),
  instrumentId: id.optional(),
  reason: z.string().trim().min(3, 'reason is required.').max(2000),
}).strict();

/** POST /oos/settings: signed (OOS_SETTING_CHANGE, reason required). */
export const oosSettingsSchema = z.object({
  retestAnalystMustDiffer: z.boolean(),
  maxRetests: z.number().int().min(1).max(10),
  phase1DueDays: z.number().int().min(1).max(365),
  phase2DueDays: z.number().int().min(1).max(365),
  ...credentials,
  reason: z.string().trim().min(5, 'reason: at least 5 characters.').max(2000),
  expectedVersion: version,
}).strict();

/** POST /oos/checklist-templates: a new version of a checklist (the previous version of the code is deactivated). */
export const oosChecklistTemplateSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,40}$/, 'code: capitals, digits and dashes.'),
  phase: z.enum(OOS_TASK_PHASES),
  title: z.string().trim().min(3).max(200),
  items: z.array(z.object({
    key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'item key: lower case, digits and dashes.'),
    text: z.string().trim().min(3).max(500),
  }).strict()).min(1).max(50)
    .refine(items => new Set(items.map(i => i.key)).size === items.length, 'item keys must be unique.'),
}).strict();

/** What the closure rule reads of an investigation (the server's row and the screen's detail both have it). */
export interface OosClosureState {
  assignedTo?: string | null;
  assignableCauseBy?: string | null;
  invalidatedAt?: string | Date | null;
  phase?: string | null;
  phase2StartedAt?: string | Date | null;
  /** The analysts who entered an OOS value of the result. */
  originalAnalystIds?: readonly string[];
  /** Everyone who has been the investigator (assignee), from the audit trail: handing the investigation over does not end the conflict. */
  investigatorIds?: readonly string[];
  tasks: ReadonlyArray<{ status: string }>;
  retests: ReadonlyArray<{ seq: number; isOos: boolean }>;
}

export type OosClosureProblemCode = 'SOD_VIOLATION' | 'TASKS_OPEN' | 'ASSIGNABLE_CAUSE_REQUIRED' | 'RETEST_REQUIRED' | 'RETEST_OOS' | 'PHASE_II_REQUIRED';

/** Phase II has been reached (a row moved before 0210 has no start time but says Phase II). */
export const phase2Reached = (s: Pick<OosClosureState, 'phase' | 'phase2StartedAt'>): boolean => !!s.phase2StartedAt || s.phase === 'Phase II';

/**
 * The people who may not sign the closure: the investigator (the assignee now and every earlier one), the author of the assignable cause
 * and the original analysts.
 */
export const closureExcluded = (s: OosClosureState): string[] =>
  [s.assignedTo, ...(s.investigatorIds ?? []), s.assignableCauseBy, ...(s.originalAnalystIds ?? [])].filter((x): x is string => !!x);

/**
 * Why `signerId` may not close the investigation with `decision` now (empty when the closure may be signed). One rule for the server,
 * which refuses with the first problem's code before the signature is asked for and again inside the signing transaction, and for the
 * screen, which shows the reasons before the dialog opens.
 *   - the signer is not the investigator (now or before), the author of the assignable cause or the analyst of the original result;
 *   - every task is Done or Not applicable;
 *   - Invalidated: the assignable cause was confirmed by QA (the original result is invalidated), at least one retest is recorded, and
 *     no retest is OOS: a failing retest is not outweighed by a passing one (no testing into compliance); the investigation goes on to
 *     Phase II instead;
 *   - Confirmed OOS, Inconclusive: Phase II (the full-scale investigation) was reached.
 */
export function oosClosureProblems(s: OosClosureState, decision: OosClosureDecision, signerId: string): Array<{ code: OosClosureProblemCode; message: string }> {
  const out: Array<{ code: OosClosureProblemCode; message: string }> = [];
  if (closureExcluded(s).includes(signerId)) {
    out.push({ code: 'SOD_VIOLATION', message: 'You are or were the investigator, or you recorded the assignable cause or entered the original result: another member of the quality unit must close this investigation.' });
  }
  const open = s.tasks.filter(t => t.status === 'Open').length;
  if (open > 0) out.push({ code: 'TASKS_OPEN', message: `${open} task(s) of the investigation are still open: complete them or mark them Not applicable.` });
  if (decision === 'Invalidated') {
    if (!s.invalidatedAt) out.push({ code: 'ASSIGNABLE_CAUSE_REQUIRED', message: 'Invalidated needs an assignable cause confirmed by QA (signed invalidation of the original result).' });
    else if (s.retests.length === 0) out.push({ code: 'RETEST_REQUIRED', message: 'Invalidated needs a retest recorded under the approved retest plan.' });
    else {
      const failing = s.retests.filter(r => r.isOos).map(r => r.seq);
      if (failing.length) {
        out.push({ code: 'RETEST_OOS', message: `Retest ${failing.join(', ')} is OOS: the result is not invalidated by a passing retest. Continue in Phase II and decide Confirmed OOS or Inconclusive.` });
      }
    }
  } else if (!phase2Reached(s)) {
    out.push({ code: 'PHASE_II_REQUIRED', message: `${decision} needs the Phase II (full-scale) investigation: move the investigation to Phase II first.` });
  }
  return out;
}
