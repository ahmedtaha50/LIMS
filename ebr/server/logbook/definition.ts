import { z } from 'zod';

/**
 * What a logbook type defines: the kinds of entry, the fields of each, and what an entry does to the status of the object.
 * This is data that users write (E21), so it is validated as strictly as any input.
 */
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'a key is lowercase letters, digits and _ (starting with a letter)');
export const Field = z.discriminatedUnion('type', [
  z.strictObject({ key, label: z.string().min(1).max(80), type: z.literal('text'), required: z.boolean().default(false), maxLength: z.number().int().min(1).max(2000).default(500) }),
  z.strictObject({ key, label: z.string().min(1).max(80), type: z.literal('number'), required: z.boolean().default(false), unit: z.string().max(20).default(''), min: z.number().optional(), max: z.number().optional(), decimals: z.number().int().min(0).max(6).default(2) }),
  z.strictObject({ key, label: z.string().min(1).max(80), type: z.literal('datetime'), required: z.boolean().default(false) }),
  z.strictObject({ key, label: z.string().min(1).max(80), type: z.literal('choice'), required: z.boolean().default(false), choices: z.array(z.string().min(1).max(80)).min(2).max(50) }),
  z.strictObject({ key, label: z.string().min(1).max(80), type: z.literal('boolean'), required: z.boolean().default(false) }),
]);
export type Field = z.infer<typeof Field>;

export const STATUSES = ['clean', 'dirty', 'in_use', 'on_hold', 'out_of_service'] as const;
export const EntryKind = z.strictObject({
  key, label: z.string().min(1).max(80),
  fields: z.array(Field).max(40),
  /** the status the object has after this entry (for objects whose status matters: equipment, rooms) */
  setsStatus: z.enum(STATUSES).optional(),
  /** a datetime field of this entry that sets the next calibration due date */
  setsCalibrationDue: key.optional(),
});
export type EntryKind = z.infer<typeof EntryKind>;

export const Definition = z.strictObject({
  entryKinds: z.array(EntryKind).min(1).max(30),
  /** whether this type tracks status (clean/dirty/...); a temperature log does not */
  tracksStatus: z.boolean().default(false),
}).superRefine((d, ctx) => {
  const kinds = new Set<string>();
  d.entryKinds.forEach((k, i) => {
    if (kinds.has(k.key)) ctx.addIssue({ code: 'custom', path: ['entryKinds', i, 'key'], message: `two entry kinds are called ${k.key}` });
    kinds.add(k.key);
    const fields = new Set<string>();
    k.fields.forEach((f, j) => {
      if (fields.has(f.key)) ctx.addIssue({ code: 'custom', path: ['entryKinds', i, 'fields', j, 'key'], message: `two fields of ${k.key} are called ${f.key}` });
      fields.add(f.key);
      if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: 'custom', path: ['entryKinds', i, 'fields', j], message: `${f.key}: min is above max` });
    });
    if (k.setsCalibrationDue && k.fields.find(f => f.key === k.setsCalibrationDue)?.type !== 'datetime') ctx.addIssue({ code: 'custom', path: ['entryKinds', i, 'setsCalibrationDue'], message: `setsCalibrationDue must name a datetime field of ${k.key}` });
    if (k.setsStatus && !d.tracksStatus) ctx.addIssue({ code: 'custom', path: ['entryKinds', i, 'setsStatus'], message: 'an entry kind sets a status, but the type does not track status' });
  });
});
export type Definition = z.infer<typeof Definition>;

export type Flag = { field: string; message: string };
/**
 * Validates the values of an entry against the version of its type (E21#4): unknown fields are refused, a missing required
 * field is refused, a number outside its limits is accepted but FLAGGED, and then a comment is required.
 */
export function checkValues(kind: EntryKind, values: Record<string, unknown>, comment: string | null | undefined): { values: Record<string, unknown>; flags: Flag[]; errors: string[] } {
  const errors: string[] = [], flags: Flag[] = [], out: Record<string, unknown> = {};
  for (const k of Object.keys(values)) if (!kind.fields.some(f => f.key === k)) errors.push(`${k}: not a field of ${kind.label}`);
  for (const f of kind.fields) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') { if (f.required) errors.push(`${f.label}: required`); continue; }
    switch (f.type) {
      case 'text': if (typeof v !== 'string' || v.length > f.maxLength) errors.push(`${f.label}: text of at most ${f.maxLength} characters`); else out[f.key] = v; break;
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${f.label}: a number`); break; }
        out[f.key] = v;
        if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) flags.push({ field: f.key, message: `${f.label} ${v}${f.unit ? ' ' + f.unit : ''} is outside ${f.min ?? '-∞'} to ${f.max ?? '∞'}${f.unit ? ' ' + f.unit : ''}` });
        break;
      }
      case 'datetime': if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) errors.push(`${f.label}: a date and time (ISO 8601)`); else out[f.key] = new Date(v).toISOString(); break;
      case 'choice': if (typeof v !== 'string' || !f.choices.includes(v)) errors.push(`${f.label}: one of ${f.choices.join(', ')}`); else out[f.key] = v; break;
      case 'boolean': if (typeof v !== 'boolean') errors.push(`${f.label}: yes or no`); else out[f.key] = v; break;
    }
  }
  if (flags.length && !(comment && comment.trim().length >= 3)) errors.push('A value is outside its limits: a comment is required.');
  return { values: out, flags, errors };
}
