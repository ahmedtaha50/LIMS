/**
 * The event catalog (roadmap M23). An event type exists only here: its version, the strict schema of its payload, who is notified
 * (a permission of the matrix, or '*' for every active user) and the text of the notification. A payload names records; it never
 * holds a result value, a limit or a person's credentials, and a key that is not in the schema is refused (strict), so nothing can
 * be added to a payload by accident. Changing what a type carries is a new version, so a subscriber can tell the two apart.
 */
import { z } from 'zod';
import type { PermissionCode } from '../../lib/permissions';

const id = z.string().min(1).max(128);

export interface EventDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;
  version: number;
  description: string;
  payload: S;
  /** Who gets a notification: the holders of this permission, or '*' for every active user. */
  audience: PermissionCode | '*';
  title: string;
  message: (p: z.infer<S>) => string;
  /** Where the notification leads in the client (src/lib/router.ts), or null. */
  href: (p: z.infer<S>) => string | null;
}

const define = <S extends z.ZodTypeAny>(d: EventDefinition<S>) => d;
const seg = (s: string) => encodeURIComponent(s);

export const EVENT_CATALOG = {
  'result.oos_detected': define({
    type: 'result.oos_detected', version: 1,
    description: 'A result was recorded out of specification and an OOS investigation was opened for it (the value is not in the event).',
    payload: z.object({ sampleId: id, resultId: id, parameter: z.string().min(1).max(200), investigationId: id }).strict(),
    audience: 'oos.view',
    title: 'OOS detected',
    message: p => `Sample ${p.sampleId}: ${p.parameter} is out of specification (investigation ${p.investigationId}).`,
    href: p => `#/samples/${seg(p.sampleId)}`,
  }),
  'batch.released': define({
    type: 'batch.released', version: 1,
    description: 'A batch was released by QA with an e-signature (the event commits with the signature; it names the release record).',
    payload: z.object({ batch: id, releaseId: id }).strict(),
    audience: 'trace.view',
    title: 'Batch released',
    message: p => `Batch ${p.batch} was released.`,
    href: () => '#/traceability',
  }),
  'instrument.calibration_due': define({
    type: 'instrument.calibration_due', version: 1,
    description: 'An instrument is due for calibration within the warning window, or overdue.',
    payload: z.object({ instrumentId: id, name: z.string().min(1).max(200), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), overdue: z.boolean() }).strict(),
    audience: 'instrument.view',
    title: 'Calibration due',
    message: p => p.overdue
      ? `${p.name} (${p.instrumentId}) is overdue for calibration since ${p.dueDate}.`
      : `${p.name} (${p.instrumentId}) is due for calibration on ${p.dueDate}.`,
    href: () => '#/instruments',
  }),
  'instrument.import_failed': define({
    type: 'instrument.import_failed', version: 1,
    description: 'An instrument file was captured but could not be read (or its instrument is not usable); the raw file is kept and moved to the error folder. The problem names the line, never a result.',
    payload: z.object({ fileId: id, fileName: z.string().min(1).max(255), instrumentId: id, problem: z.string().min(1).max(1000) }).strict(),
    audience: 'result.enter',
    title: 'Instrument file not imported',
    message: p => `${p.fileName} (${p.instrumentId}) could not be imported: ${p.problem}`,
    href: () => '#/imports',
  }),
  'reagent.expiry_alert': define({
    type: 'reagent.expiry_alert', version: 1,
    description: 'A reagent lot or prepared solution reaches 30 or 7 days before the last day it may be used (expiry or in-use expiry), or has expired (threshold 0).',
    payload: z.object({
      materialId: id, kind: z.enum(['lot', 'solution']), name: z.string().min(1).max(200), lotNumber: z.string().min(1).max(100).nullable(),
      useUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), threshold: z.union([z.literal(30), z.literal(7), z.literal(0)]), daysRemaining: z.number().int().min(0),
    }).strict(),
    audience: 'reagent.view',
    title: 'Reagent expiry',
    message: p => p.threshold === 0
      ? `${p.name} (${p.materialId}${p.lotNumber ? `, lot ${p.lotNumber}` : ''}) expired: it could be used until ${p.useUntil}.`
      : `${p.name} (${p.materialId}${p.lotNumber ? `, lot ${p.lotNumber}` : ''}) may be used until ${p.useUntil} (${p.daysRemaining} day(s) left).`,
    href: () => '#/reagents',
  }),
  'sample.tat_alert': define({
    type: 'sample.tat_alert', version: 1,
    description: 'A sample that is not finished is due within 24 hours (due_soon) or is past its turnaround due date (overdue).',
    payload: z.object({ sampleId: id, priority: z.enum(['Routine', 'Urgent', 'Critical']), dueAt: z.string().min(1).max(40), kind: z.enum(['due_soon', 'overdue']) }).strict(),
    audience: 'sample.view',
    title: 'Sample turnaround',
    message: p => p.kind === 'overdue'
      ? `Sample ${p.sampleId} (${p.priority}) is past its due date ${p.dueAt.slice(0, 16).replace('T', ' ')} UTC.`
      : `Sample ${p.sampleId} (${p.priority}) is due ${p.dueAt.slice(0, 16).replace('T', ' ')} UTC.`,
    href: p => `#/samples/${seg(p.sampleId)}`,
  }),
  'periodic.review_due': define({
    type: 'periodic.review_due', version: 1,
    description: 'A periodic review is due within 7 days, is due today, or is overdue (repeated weekly while overdue). Threshold 7, 0, or -7, -14, ... days.',
    payload: z.object({
      reviewId: id, kind: z.enum(['user_access', 'instrument', 'specification', 'method', 'document', 'module', 'system']), subjectId: id, title: z.string().min(1).max(200),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), threshold: z.number().int().min(-3650).max(7), daysRemaining: z.number().int(), overdue: z.boolean(),
    }).strict(),
    audience: 'periodic.view',
    title: 'Periodic review due',
    message: p => p.overdue
      ? `Periodic review "${p.title}" is overdue since ${p.dueDate}.`
      : `Periodic review "${p.title}" is due on ${p.dueDate}.`,
    href: () => '#/periodic-reviews',
  }),
  'archive.verification_failed': define({
    type: 'archive.verification_failed', version: 1,
    description: 'An archived bundle no longer matches its manifest (a file was altered, removed or added). The problem names files, never record content.',
    payload: z.object({ bundleId: id, subject: z.string().min(1).max(300), problemCount: z.number().int().min(0) }).strict(),
    audience: 'archive.view',
    title: 'Archive verification failed',
    message: p => `Archive bundle ${p.bundleId} (${p.subject}) failed its integrity check (${p.problemCount} problem(s)).`,
    href: () => '#/periodic-reviews',
  }),
  'system.alert': define({
    type: 'system.alert', version: 1,
    description: 'An Administrator sent a system-wide alert.',
    payload: z.object({ message: z.string().min(1).max(500) }).strict(),
    audience: '*',
    title: 'System alert',
    message: p => p.message,
    href: () => null,
  }),
} as const;

export type EventType = keyof typeof EVENT_CATALOG;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_CATALOG)[T]['payload']>;
export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export const isEventType = (v: unknown): v is EventType => typeof v === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CATALOG, v);

export function eventDefinition(type: string): EventDefinition {
  if (!isEventType(type)) throw new Error(`Unknown event type "${type}": add it to src/server/events/catalog.ts first.`);
  return EVENT_CATALOG[type] as unknown as EventDefinition;
}

/** What GET /event-subscriptions shows of the catalog. */
export const catalogView = () => EVENT_TYPES.map(t => {
  const d = EVENT_CATALOG[t];
  return { type: d.type, version: d.version, description: d.description, audience: d.audience };
});
