import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react';

/** UI primitives. Every control is at least 44 x 44 px (WCAG 2.5.5 target size) and has a visible label. */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' };
export function Button({ variant = 'primary', className = '', ...p }: ButtonProps) {
  const look = {
    primary: 'bg-sky-800 text-white hover:bg-sky-900 disabled:bg-slate-400',
    secondary: 'bg-white text-slate-900 border border-slate-400 hover:bg-slate-100',
    danger: 'bg-red-700 text-white hover:bg-red-800',
  }[variant];
  return <button type="button" {...p} className={`min-h-11 min-w-11 rounded-lg px-4 text-base font-semibold ${look} ${className}`} />;
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string };
export function TextField({ label, hint, id, className = '', ...p }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fid} className="text-sm font-semibold text-slate-700">{label}</label>
      <input id={fid} {...p} className={`min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base ${className}`} aria-describedby={hint ? `${fid}-hint` : undefined} />
      {hint ? <p id={`${fid}-hint`} className="text-sm text-slate-600">{hint}</p> : null}
    </div>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info'; children: ReactNode }) {
  const look = kind === 'error' ? 'border-red-700 bg-red-50 text-red-900' : 'border-sky-700 bg-sky-50 text-sky-900';
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border-s-4 p-3 text-base ${look}`}>{children}</div>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label={title}>
      <h2 className="mb-3 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}
