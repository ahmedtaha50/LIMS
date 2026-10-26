/**
 * The review of a sample's raw data (roadmap M20, r2-raw-data): the server items of the review checklist (evaluated by the server,
 * never ticked here), the history of every result with the coded reason of each version, the QA signature a reintegration needs, and
 * the reviewer's manual attestations. Approval is refused by the server while a server item fails; this screen shows why.
 */
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, MinusCircle, XCircle } from 'lucide-react';
import { apiFetch, errorMessage } from '../lib/api';
import { VERSION_CODE_LABELS, type VersionCode } from '../server/services/result-hooks/codes';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { useToast } from './ui/Toast';

export interface ChecklistItem { code: string; label: string; status: 'pass' | 'fail' | 'na'; detail: string }
export interface ResultVersionRow {
  id: string; resultId: string; parameter: string; resultVersion: number; value: string | null; previousValue: string | null; isOos: boolean;
  changeCode: string; reason: string; enteredBy: string | null; enteredAt: string;
  reintegrationSignature: { id: string; signerId: string; signerName: string | null; timestamp: string } | null;
}
interface ChecklistView {
  sampleState: string; sampleVersion: number; items: ChecklistItem[]; ready: boolean;
  attestations: Array<{ code: string; text: string }>;
  latest: { id: string; recordedBy: string; recordedAt: string; attestations: string[]; serverItemsPassed: boolean; comment: string | null } | null;
}

const STATUS = {
  pass: { icon: CheckCircle2, text: 'Met', cls: 'text-emerald-700' },
  fail: { icon: XCircle, text: 'Not met', cls: 'text-red-700' },
  na: { icon: MinusCircle, text: 'Not applicable', cls: 'text-slate-500' },
} as const;

export function ChecklistItems({ items }: { items: ChecklistItem[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {items.map(i => {
        const s = STATUS[i.status];
        const Icon = s.icon;
        return (
          <li key={i.code} data-status={i.status} className="py-2 flex gap-3 items-start">
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.cls}`} aria-hidden="true" />
            <div className="text-sm">
              <div className="font-medium text-slate-900">{i.label} <span className={`text-xs font-semibold ${s.cls}`}>{s.text}</span></div>
              <div className="text-slate-600">{i.detail}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const codeLabel = (c: string) => VERSION_CODE_LABELS[c as VersionCode] ?? c;

/** Every version, oldest first per result. A reintegration shows its QA signature, or offers it to someone who may sign and did not make it. */
export function VersionTable({ versions, canSign, me, onSign }: {
  versions: ResultVersionRow[]; canSign: boolean; me: string; onSign: (v: ResultVersionRow) => void;
}) {
  if (versions.length === 0) return <p className="text-sm text-slate-500 italic">No result has been entered yet.</p>;
  return (
    <table className="w-full text-sm text-start">
      <thead className="text-slate-500 border-b border-slate-200">
        <tr><th className="py-2 pe-3">Result</th><th className="py-2 pe-3">Version</th><th className="py-2 pe-3">Value</th><th className="py-2 pe-3">Reason</th><th className="py-2 pe-3">By</th><th className="py-2">QA</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {versions.map(v => (
          <tr key={v.id}>
            <td className="py-2 pe-3 font-medium text-slate-900">{v.parameter}</td>
            <td className="py-2 pe-3 text-slate-600">v{v.resultVersion}</td>
            <td className="py-2 pe-3 font-mono">{v.previousValue !== null ? `${v.previousValue} → ${v.value}` : v.value}{v.isOos && <span className="ms-1 text-xs font-bold text-red-700">OOS</span>}</td>
            <td className="py-2 pe-3"><span className="font-semibold text-slate-800">{codeLabel(v.changeCode)}</span><div className="text-xs text-slate-600">{v.reason}</div></td>
            <td className="py-2 pe-3 text-xs text-slate-600">{v.enteredBy ?? '-'}<div>{formatDateTime(v.enteredAt)}</div></td>
            <td className="py-2 text-xs">
              {v.changeCode !== 'REINTEGRATION' ? null
                : v.reintegrationSignature ? <span className="text-emerald-700">Signed by {v.reintegrationSignature.signerName ?? v.reintegrationSignature.signerId}</span>
                  : (
                    <div className="flex flex-col gap-1">
                      <span className="text-amber-700 font-semibold">QA signature required</span>
                      {canSign && v.enteredBy !== me && (
                        <button type="button" onClick={() => onSign(v)} className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 w-fit">Sign reintegration</button>
                      )}
                    </div>
                  )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `refreshKey`: changes whenever the sample or a result changes (the sample screen passes their versions), so the checklist reloads. */
export function ReviewChecklist({ sampleId, user, token, refreshKey, onChanged }: {
  sampleId: string; user: { id: string; role: string } & Record<string, any>; token: string; refreshKey?: string; onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [view, setView] = useState<ChecklistView | null>(null);
  const [versions, setVersions] = useState<ResultVersionRow[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [signing, setSigning] = useState<ResultVersionRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, v] = await Promise.all([
        apiFetch<ChecklistView>(`/samples/${encodeURIComponent(sampleId)}/review-checklist`),
        apiFetch<{ versions: ResultVersionRow[] }>(`/samples/${encodeURIComponent(sampleId)}/result-versions`),
      ]);
      setView(c); setVersions(v.versions);
    } catch (e) { toast.error(errorMessage(e, 'The review checklist could not be loaded.')); }
  }, [sampleId, refreshKey]);
  useEffect(() => { load(); }, [load]);

  const record = async () => {
    if (!view) return;
    if (chosen.length === 0) { toast.error('Tick at least one attestation before recording the checklist.'); return; }
    try {
      await apiFetch(`/samples/${encodeURIComponent(sampleId)}/review-checklist`, {
        method: 'POST', body: { attestations: chosen, ...(comment.trim() ? { comment: comment.trim() } : {}), expectedVersion: view.sampleVersion },
      });
      toast.success(view.ready ? 'Review checklist recorded.' : 'Review checklist recorded. Server items are still not met: approval stays blocked.');
      setChosen([]); setComment('');
      await load();
      onChanged?.();
    } catch (e) { toast.error(errorMessage(e, 'The review checklist was not recorded.')); }
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    // The modal shows a thrown error; the toast confirms success.
    await apiFetch(`/result-versions/${encodeURIComponent(signing.id)}/sign`, { method: 'POST', body: { password, reason, ...(totpCode ? { totpCode } : {}) }, replay: 'never' });
    toast.success(`Reintegration of ${signing.parameter} (v${signing.resultVersion}) approved.`);
    setSigning(null);
    await load();
    onChanged?.();
  };

  if (!view) return null;
  const failed = view.items.filter(i => i.status === 'fail').length;
  const reviewer = ['Reviewer', 'QA', 'Admin'].includes(user.role);
  return (
    <section aria-labelledby="review-heading" className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 mt-6">
      <h3 id="review-heading" className="text-sm font-semibold text-slate-800 flex items-center gap-2"><ClipboardCheck className="w-4 h-4" /> Review checklist</h3>
      <p className={`text-sm mt-1 mb-2 ${failed ? 'text-red-700' : 'text-emerald-700'}`}>
        {failed ? `${failed} server item(s) not met: approval is blocked until they are.` : 'Every server item is met.'}
      </p>
      <ChecklistItems items={view.items} />

      <h4 className="text-sm font-semibold text-slate-800 mt-4 mb-2">Result history</h4>
      <VersionTable versions={versions} canSign={['QA', 'Admin'].includes(user.role)} me={user.id} onSign={setSigning} />

      <h4 className="text-sm font-semibold text-slate-800 mt-4 mb-2">Reviewer attestations</h4>
      {view.latest && (
        <p className="text-xs text-slate-600 mb-2">
          Last recorded by {view.latest.recordedBy} on {formatDateTime(view.latest.recordedAt)}: {view.latest.attestations.join(', ')}
          {view.latest.serverItemsPassed ? '' : ' (server items were not all met then)'}.
        </p>
      )}
      {reviewer && view.sampleState === 'Pending Review' ? (
        <div className="flex flex-col gap-2">
          {view.attestations.map(a => (
            <label key={a.code} className="text-sm text-slate-700 flex gap-2 items-start">
              <input type="checkbox" className="mt-1" checked={chosen.includes(a.code)}
                onChange={e => setChosen(c => e.target.checked ? [...c, a.code] : c.filter(x => x !== a.code))} />
              {a.text}
            </label>
          ))}
          <textarea value={comment} onChange={e => setComment(e.target.value)} aria-label="Review comment" placeholder="Comment (optional)"
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm" rows={2} maxLength={2000} />
          <button type="button" onClick={record} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 w-fit">Record checklist</button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">Attestations are recorded by a reviewer while the sample is Pending Review.</p>
      )}

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode="REINTEGRATION_APPROVAL"
          action="reintegration approval"
          entityName={`${signing.parameter} v${signing.resultVersion} (${signing.id})`}
          recordVersion={signing.resultVersion}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </section>
  );
}
