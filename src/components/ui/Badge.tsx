import React from 'react';

/** A status label (roadmap M24). The state is always written out: colour is a second cue, never the only one (WCAG 1.4.1). */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-800 border-slate-300',
  info: 'bg-blue-50 text-blue-900 border-blue-200',
  success: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-300',
  danger: 'bg-red-50 text-red-900 border-red-200',
};

/** The tone of a record state word used across the application. Unknown words are neutral. */
export function stateTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'Approved': case 'Active': case 'Released': case 'Closed': case 'Pass': return 'success';
    case 'Pending Review': case 'Pending QA': case 'Draft': case 'Quarantine Hold': case 'Alert': return 'warning';
    case 'Rejected': case 'Failed': case 'Out of Service': case 'Action': case 'OOS': return 'danger';
    case 'Logged': case 'Testing': case 'Open': return 'info';
    default: return 'neutral';
  }
}

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}>{children}</span>;
}
