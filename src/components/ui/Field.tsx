import React, { useId } from 'react';
import { ApiError } from '../../lib/api';

/**
 * A labelled form control (roadmap M24). The label, the hint and the error are tied to the control (for / id, aria-describedby,
 * aria-invalid), so a screen reader reads them with the field and the error is not shown by colour alone.
 *
 *   <Field label="Batch number" error={errors.batch}>{p => <input {...p} value={batch} onChange={...} />}</Field>
 *
 * Server validation errors carry `details: [{ path, message }]`; fieldErrors(err) turns them into { path: message } for the
 * form ({ error, fields }: the error sentence goes to a toast, the field messages under their fields).
 */
export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
  required?: boolean;
}

export interface FieldProps {
  label: React.ReactNode;
  children: (props: FieldControlProps) => React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  id?: string;
  className?: string;
}

export function Field({ label, children, hint, error, required, id, className = '' }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto.replace(/:/g, '')}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={controlId} className="text-sm font-medium text-slate-700">
        {label}{required && <span aria-hidden="true" className="text-red-700"> *</span>}
      </label>
      {children({ id: controlId, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, required })}
      {hint && <p id={hintId} className="text-xs text-slate-600">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

/** { path: message } from a server validation error; {} for anything else. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as Array<{ path?: unknown; message?: unknown }>) {
    if (d && typeof d.path === 'string' && d.path && typeof d.message === 'string' && !(d.path in out)) out[d.path] = d.message;
  }
  return out;
}

/** The input styling shared by forms. */
export const inputClass = 'ui-control w-full px-3 py-2 border border-slate-400 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 aria-[invalid=true]:border-red-600';
