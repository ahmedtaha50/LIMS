// Audit-trail review screen (roadmap M35, r2-audit-tamper): review by exception and the signed review (AUDIT_REVIEW), the release
// requirement, the anchor check and the clock guard. The server is the authority on every step: it computes the exceptions, the
// coverage and the anomalies, and checks the permission and the segregation of duties again on every call. What the user may do
// (audit.review, audit.review.settings, audit.verify, clock.acknowledge) comes from GET /permissions/me.
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Anchor, CheckCircle2, Clock, FileSearch, Settings } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50';

export type ExceptionKind = 'EDIT_AFTER_SUBMIT' | 'SIGNATURE_FAILED' | 'ROLE_OR_SETTING_CHANGE' | 'SAME_USER_CREATED_AND_APPROVED';
export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  EDIT_AFTER_SUBMIT: 'Edited after submission',
  SIGNATURE_FAILED: 'Failed signature',
  ROLE_OR_SETTING_CHANGE: 'Role or setting change',
  SAME_USER_CREATED_AND_APPROVED: 'Created and approved by the same person',
};

export interface AuditException {
  kind: ExceptionKind; sequence: number; entity: string; entityId: string; userId: string; actorName: string | null; action: string;
  field: string; oldValue: string; newValue: string; reason: string; timestamp: string; detail: string;
}
export interface ScopeSummary {
  scope: { kind: 'batch'; batch: string } | { kind: 'range' };
  fromSequence: number | null; toSequence: number | null; rowCount: number; authors: string[]; exceptionCount: number;
  exceptions: AuditException[]; truncated: boolean;
}
export interface Coverage { covered: boolean; uncoveredRows: number }
export interface ReviewRow { id: string; scope: string; scopeId: string | null; fromSequence: number; toSequence: number; rowsReviewed: number; exceptionCount: number; comment: string; reviewerId: string; reviewedAt: string }
export interface AnchorVerification {
  isValid: boolean; anchorsChecked: number; headSequence: number;
  latest: { sequence: number; anchoredAt: string; file: string } | null;
  failures: Array<{ file: string; sequence: number | null; reason: string }>;
}
export interface ClockAnomalyRow {
  id: string; detectedAt: string; watermark: string; behindMs: number; source: string;
  acknowledgedBy: string | null; acknowledgedAt: string | null; ackReason: string | null; version: number;
}

const short = (value: string) => (value.length > 60 ? `${value.slice(0, 60)}…` : value);

export function ExceptionTable({ exceptions }: { exceptions: AuditException[] }) {
  if (exceptions.length === 0) return <p className="text-sm text-slate-500">No exceptions in this scope. Every entry still needs to be read before signing.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-start text-xs text-slate-500"><th className="py-1">Entry</th><th>Exception</th><th>Record</th><th>By</th><th>Change</th><th>Reason</th></tr></thead>
      <tbody>
        {exceptions.map(e => (
          <tr key={`${e.sequence}-${e.kind}`} className="border-t border-slate-100 align-top">
            <td className="py-1 font-mono">#{e.sequence}</td>
            <td><span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="w-3 h-3" />{EXCEPTION_LABEL[e.kind] ?? e.kind}</span><div className="text-xs text-slate-500">{e.detail}</div></td>
            <td>{e.entity} {e.entityId}</td>
            <td>{e.actorName ?? e.userId}</td>
            <td>{e.action}{e.field ? ` ${e.field}` : ''}{e.oldValue || e.newValue ? `: ${short(e.oldValue)} → ${short(e.newValue)}` : ''}</td>
            <td>{e.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CoverageBadge({ coverage, required }: { coverage: Coverage; required: boolean }) {
  if (coverage.covered) return <span className="inline-flex items-center gap-1 text-sm text-emerald-700"><CheckCircle2 className="w-4 h-4" /> Covered by a signed review</span>;
  return (
    <span className="inline-flex items-center gap-1 text-sm text-amber-700">
      <AlertTriangle className="w-4 h-4" /> {coverage.uncoveredRows} entries not reviewed{required ? ': this blocks release' : ''}
    </span>
  );
}

export function AnchorStatus({ verification }: { verification: AnchorVerification | null }) {
  if (!verification) return <p className="text-sm text-slate-500">Not verified yet.</p>;
  if (verification.isValid) {
    return (
      <p className="text-sm text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" />
        All anchors match the database ({verification.anchorsChecked} checked{verification.latest ? `, latest at entry #${verification.latest.sequence}` : ''}).
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
      <p className="font-semibold flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> The audit trail does not match its anchors. Inform QA.</p>
      <ul className="mt-1 list-disc ps-5">{verification.failures.map(f => <li key={`${f.file}-${f.reason}`}><span className="font-mono">{f.file}</span>: {f.reason}{f.sequence !== null ? ` (entry #${f.sequence})` : ''}</li>)}</ul>
    </div>
  );
}

export function AnomalyTable({ anomalies, canAcknowledge, onAcknowledge }: { anomalies: ClockAnomalyRow[]; canAcknowledge: boolean; onAcknowledge: (a: ClockAnomalyRow) => void }) {
  const open = anomalies.filter(a => !a.acknowledgedAt);
  return (
    <div className="space-y-2">
      {open.length > 0 && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800" role="alert">
          Signing is blocked: the system clock was found behind records already written. {canAcknowledge ? 'Check the clock, then acknowledge.' : 'An Administrator must check the clock and acknowledge.'}
        </p>
      )}
      {anomalies.length === 0 ? <p className="text-sm text-slate-500">No clock anomaly has been found.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-start text-xs text-slate-500"><th className="py-1">Found</th><th>Behind</th><th>Where</th><th>Status</th><th /></tr></thead>
          <tbody>
            {anomalies.map(a => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-1">{formatDateTime(a.detectedAt)}</td>
                <td>{Math.round(a.behindMs / 60_000)} min behind</td>
                <td>{a.source}</td>
                <td>{a.acknowledgedAt ? `Checked by ${a.acknowledgedBy} on ${formatDateTime(a.acknowledgedAt)}: ${a.ackReason ?? ''}` : 'Open'}</td>
                <td>{!a.acknowledgedAt && canAcknowledge && <button type="button" className={primary} onClick={() => onAcknowledge(a)}>Acknowledge</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export type ReviewScopeBody = { scope: 'batch'; batch: string; throughSequence: number } | { scope: 'range'; fromSequence: number; toSequence: number };

/** What the signed review names: the scope shown on the screen and its last entry (not what the inputs hold now); null with no rows. */
export function reviewScopeBody(summary: ScopeSummary): ReviewScopeBody | null {
  if (summary.rowCount === 0 || summary.fromSequence === null || summary.toSequence === null) return null;
  return summary.scope.kind === 'batch'
    ? { scope: 'batch', batch: summary.scope.batch, throughSequence: summary.toSequence }
    : { scope: 'range', fromSequence: summary.fromSequence, toSequence: summary.toSequence };
}

type Signing =
  | { kind: 'review'; scope: ReviewScopeBody; comment: string }
  | { kind: 'settings'; on: boolean; version: number }
  | { kind: 'ack'; anomaly: ClockAnomalyRow };

export function AuditReview({ token, user }: { token?: string; user: any }) {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [tab, setTab] = useState<'review' | 'anchors' | 'clock'>('review');
  const [mode, setMode] = useState<'batch' | 'range'>('batch');
  const [batch, setBatch] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [summary, setSummary] = useState<ScopeSummary | null>(null);
  const [reviews, setReviews] = useState<{ reviews: ReviewRow[]; requiredForRelease: boolean; coverage: Coverage | null } | null>(null);
  const [comment, setComment] = useState('');
  const [settings, setSettings] = useState<{ requiredForRelease: boolean; version: number } | null>(null);
  const [anchors, setAnchors] = useState<{ directory: string | null; secondPath: boolean; anchors: Array<{ id: string; sequence: number; anchoredAt: string; fileName: string }> } | null>(null);
  const [verification, setVerification] = useState<AnchorVerification | null>(null);
  const [clock, setClock] = useState<{ anomalies: ClockAnomalyRow[]; signingBlocked: boolean } | null>(null);
  const [signing, setSigning] = useState<Signing | null>(null);

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);
  const can = (code: string) => permissions.includes(code);

  const loadSettings = useCallback(() => apiFetch<{ requiredForRelease: boolean; version: number }>('/audit/review-settings').then(setSettings).catch(err => fail(err, 'The review setting could not be loaded.')), [fail]);
  const loadAnchors = useCallback(() => apiFetch<any>('/audit/anchors').then(setAnchors).catch(err => fail(err, 'The anchors could not be loaded.')), [fail]);
  const loadClock = useCallback(() => apiFetch<any>('/audit/clock').then(setClock).catch(err => fail(err, 'The clock guard could not be loaded.')), [fail]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
    loadSettings();
    loadClock();
  }, [fail, loadSettings, loadClock]);
  useEffect(() => { if (tab === 'anchors') loadAnchors(); if (tab === 'clock') loadClock(); }, [tab, loadAnchors, loadClock]);

  const scopeQuery = () => (mode === 'batch' ? `batch=${encodeURIComponent(batch.trim())}` : `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
  const show = async () => {
    if (mode === 'batch' ? !batch.trim() : !range.from || !range.to) { toast.error(mode === 'batch' ? 'Enter a batch.' : 'Enter the first and last entry number.'); return; }
    try {
      setSummary(await apiFetch<ScopeSummary>(`/audit/exceptions?${scopeQuery()}`));
      setReviews(mode === 'batch' ? await apiFetch<any>(`/audit/reviews?batch=${encodeURIComponent(batch.trim())}`) : null);
    } catch (err) { setSummary(null); fail(err, 'The audit trail could not be read.'); }
  };

  const startReview = () => {
    const scope = summary ? reviewScopeBody(summary) : null;
    if (!summary || !scope) { toast.error('Show a scope with entries before signing its review.'); return; }
    if (summary.exceptionCount > 0 && comment.trim().length < 10) { toast.error('This scope has exceptions: say in the comment (at least 10 characters) how each was assessed.'); return; }
    setSigning({ kind: 'review', comment: comment.trim(), scope });
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, ...(totpCode ? { totpCode } : {}) };
    // When a call throws, the dialog shows the server's message and stays open so the signer can correct the entry.
    if (signing.kind === 'review') {
      await apiFetch('/audit/reviews', { body: { ...signing.scope, ...(signing.comment ? { comment: signing.comment } : {}), ...(reason ? { reason } : {}), ...cred } });
      toast.success('Audit trail review signed (audit logged)');
      setComment('');
      setSigning(null);
      await show();
    } else if (signing.kind === 'settings') {
      await apiFetch('/audit/review-settings', { method: 'PUT', body: { requiredForRelease: signing.on, expectedVersion: signing.version, reason: reason ?? '', ...cred } });
      toast.success(`Review before release ${signing.on ? 'required' : 'no longer required'} (audit logged)`);
      setSigning(null);
      await loadSettings();
    } else {
      await apiFetch(`/audit/clock-anomalies/${encodeURIComponent(signing.anomaly.id)}/acknowledge`, { body: { expectedVersion: signing.anomaly.version, reason: reason ?? '', ...cred } });
      toast.success('Clock anomaly acknowledged; signing is allowed again (audit logged)');
      setSigning(null);
      await loadClock();
    }
  };

  const run = async (what: string, call: () => Promise<unknown>) => {
    try { await call(); toast.success(what); } catch (err) { fail(err, `${what} failed.`); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><FileSearch className="w-5 h-5" /> Audit trail review</h1>
        <div className="flex gap-2" role="tablist">
          {(['review', 'anchors', 'clock'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? primary : button} onClick={() => setTab(t)}>
              {t === 'review' ? 'Review' : t === 'anchors' ? 'Anchors' : `Clock${clock?.signingBlocked ? ' (blocked)' : ''}`}
            </button>
          ))}
        </div>
      </div>

      {tab === 'review' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 bg-white border border-slate-200 rounded-xl p-3">
            <select className={input} value={mode} onChange={e => setMode(e.target.value as 'batch' | 'range')} aria-label="Scope">
              <option value="batch">A batch</option><option value="range">A range of entries</option>
            </select>
            {mode === 'batch'
              ? <input className={input} placeholder="Batch" value={batch} onChange={e => setBatch(e.target.value)} aria-label="Batch" />
              : <><input className={`${input} w-28`} placeholder="From #" inputMode="numeric" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} aria-label="First entry" />
                <input className={`${input} w-28`} placeholder="To #" inputMode="numeric" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} aria-label="Last entry" /></>}
            <button type="button" className={primary} onClick={show}>Show</button>
            {settings && (
              <span className="ms-auto flex items-center gap-2 text-sm text-slate-600"><Settings className="w-4 h-4" />
                Review required before release: <strong>{settings.requiredForRelease ? 'yes' : 'no'}</strong>
                {can('audit.review.settings') && <button type="button" className={button} onClick={() => setSigning({ kind: 'settings', on: !settings.requiredForRelease, version: settings.version })}>{settings.requiredForRelease ? 'Stop requiring' : 'Require'}</button>}
              </span>
            )}
          </div>

          {summary && (
            <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-4 text-sm text-slate-700">
                <span>{summary.rowCount} entries{summary.fromSequence !== null ? ` (#${summary.fromSequence} to #${summary.toSequence})` : ''}</span>
                <span>{summary.exceptionCount} exception(s){summary.truncated ? ', list shortened' : ''}</span>
                {reviews?.coverage && <CoverageBadge coverage={reviews.coverage} required={reviews.requiredForRelease} />}
              </div>
              <ExceptionTable exceptions={summary.exceptions} />
              {can('audit.review') && summary.rowCount > 0 && (
                <div className="space-y-2">
                  <textarea className={`${input} w-full`} rows={2} placeholder="Comment: how the exceptions were assessed" value={comment} onChange={e => setComment(e.target.value)} aria-label="Review comment" />
                  <button type="button" className={primary} onClick={startReview}>Sign the review</button>
                </div>
              )}
              {reviews && reviews.reviews.length > 0 && (
                <ul className="text-xs text-slate-600 space-y-1">
                  {reviews.reviews.map(r => <li key={r.id}>{r.id}: entries #{r.fromSequence} to #{r.toSequence} reviewed by {r.reviewerId} on {formatDateTime(r.reviewedAt)} ({r.exceptionCount} exception(s)){r.comment ? `: ${r.comment}` : ''}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'anchors' && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
          <p className="text-sm text-slate-600 flex items-center gap-1"><Anchor className="w-4 h-4" />
            {anchors?.directory ? <>Anchors are written to <span className="font-mono">{anchors.directory}</span>{anchors.secondPath ? '' : ' (the same disk as the database: set AUDIT_ANCHOR_DIR or BACKUP_MIRROR_DIR for a second path)'}.</> : 'No folder for anchors is configured (AUDIT_ANCHOR_DIR or BACKUP_MIRROR_DIR).'}
          </p>
          {can('audit.verify') && (
            <div className="flex gap-2">
              <button type="button" className={button} onClick={() => run('Anchor written', async () => { await apiFetch('/audit/anchors', { body: {} }); await loadAnchors(); })}>Write an anchor now</button>
              <button type="button" className={primary} onClick={() => run('Anchors verified', async () => setVerification(await apiFetch<AnchorVerification>('/audit/anchors/verify', { body: {} })))}>Verify the anchors</button>
            </div>
          )}
          <AnchorStatus verification={verification} />
          <ul className="text-xs text-slate-600">{anchors?.anchors.map(a => <li key={a.id}><span className="font-mono">{a.fileName}</span>: entry #{a.sequence}, {formatDateTime(a.anchoredAt)}</li>)}</ul>
        </div>
      )}

      {tab === 'clock' && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
          <p className="text-sm text-slate-600 flex items-center gap-1"><Clock className="w-4 h-4" /> The clock is checked before every signature and every 5 minutes.</p>
          <AnomalyTable anomalies={clock?.anomalies ?? []} canAcknowledge={can('clock.acknowledge')} onAcknowledge={a => setSigning({ kind: 'ack', anomaly: a })} />
        </div>
      )}

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode={signing.kind === 'review' ? 'AUDIT_REVIEW' : signing.kind === 'settings' ? 'AUDIT_REVIEW_SETTING' : 'CLOCK_ANOMALY_ACK'}
          action={signing.kind === 'review' ? 'audit trail review' : signing.kind === 'settings' ? 'review-before-release setting' : 'clock anomaly acknowledgement'}
          entityName={signing.kind === 'review' ? (signing.scope.scope === 'batch' ? `batch ${signing.scope.batch} (entries to #${signing.scope.throughSequence})` : `entries #${signing.scope.fromSequence} to #${signing.scope.toSequence}`) : signing.kind === 'settings' ? 'Audit review settings' : signing.anomaly.id}
          recordVersion={signing.kind === 'settings' ? signing.version : signing.kind === 'ack' ? signing.anomaly.version : 1}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
