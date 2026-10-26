// The Certificate of Analysis of one sample (roadmap M25, r2-coa-reports). The server is the authority: GET /coa/:sampleId says whether a
// certificate can be issued and why not, and the screen offers exactly that. Issue, re-issue and void are e-signatures with the route's
// own meaning (COA_AUTHORISATION, COA_VOID); the PDF is made by a job and fetched from the register of generated documents, so the
// browser never composes a certificate. Who may sign (coa.issue) comes from GET /permissions/me; the server checks again.
import React, { useCallback, useEffect, useState } from 'react';
import { FileCheck2, ShieldCheck } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, useSessionState } from '../lib/api';
import { localizedError, t, useLang } from '../i18n';
import { formatNumber } from '../lib/format';

export interface CoaSignatureRow { id: string; meaningCode: string | null; meaning: string; signerName: string; signerRole: string; timestamp: string; reason: string }
export interface CoaDocumentRow {
  id: string; sampleId: string; number: string; issueVersion: number; label: string; status: 'Issued' | 'Superseded' | 'Voided'; version: number;
  issuedBy: string; issuedAt: string; supersedesId: string | null; supersededById: string | null; supersededReason: string | null; voidReason: string | null;
  pdfSha256: string | null; originalRunId: string | null; specRevision: number | null; signatures: CoaSignatureRow[];
}
export interface CoaEligibility {
  sampleId: string; state: string; eligible: boolean; problems: Array<{ check: string; message: string }>;
  current: CoaDocumentRow | null; documents: CoaDocumentRow[];
}

const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50';
/** 2026-10-04 12:00:00 UTC, as the certificate prints it. */
export const utcText = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

/** What may be done now: issue, or re-issue and void the current certificate. Nothing to sign without coa.issue or while blocked. */
export function CoaActions({ info, canIssue, busy, onIssue, onReissue, onVoid }: {
  info: CoaEligibility; canIssue: boolean; busy: boolean; onIssue: () => void; onReissue: (d: CoaDocumentRow) => void; onVoid: (d: CoaDocumentRow) => void;
}) {
  const blocked = info.problems.length > 0;
  return (
    <div className="space-y-2">
      {blocked && (
        <ul className="text-sm text-red-700 list-disc ps-5" aria-label={t('coa.blocks')}>
          {info.problems.map(p => <li key={`${p.check}:${p.message}`}>{p.message}</li>)}
        </ul>
      )}
      {!canIssue && <p className="text-xs text-slate-500">{t('coa.qualityOnly')}</p>}
      {canIssue && !blocked && (
        <div className="flex gap-2">
          {info.current
            ? <>
                <button type="button" className={primary} disabled={busy} onClick={() => onReissue(info.current!)}>{t('coa.reissue')}</button>
                <button type="button" className={button} disabled={busy} onClick={() => onVoid(info.current!)}>{t('coa.void')}</button>
              </>
            : <button type="button" className={primary} disabled={busy} onClick={onIssue}>{t('coa.issue')}</button>}
        </div>
      )}
      {canIssue && blocked && info.current && (
        <button type="button" className={button} disabled={busy} onClick={() => onVoid(info.current!)}>{t('coa.void')}</button>
      )}
    </div>
  );
}

/** Every issue of the sample's certificate, newest first, with its state, signatures, and a controlled copy for the reader. */
export function CoaDocumentTable({ documents, onCopy, onVerify }: { documents: CoaDocumentRow[]; onCopy: (d: CoaDocumentRow) => void; onVerify: (d: CoaDocumentRow) => void }) {
  if (documents.length === 0) return <p className="text-sm text-slate-500">{t('coa.none')}</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-start text-slate-500"><th className="py-1">{t('coa.col.certificate')}</th><th>{t('coa.col.state')}</th><th>{t('coa.col.authorisation')}</th><th></th></tr></thead>
      <tbody>
        {documents.map(d => (
          <tr key={d.id} className="border-t border-slate-100 align-top">
            <td className="py-2 font-mono"><bdi dir="ltr">{d.label}</bdi>{d.specRevision !== null && <div className="text-xs text-slate-500 font-sans">{t('coa.specRevision', { n: formatNumber(d.specRevision) })}</div>}</td>
            <td>
              <span className={d.status === 'Issued' ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>{d.status}</span>
              {d.supersededReason && <div className="text-xs text-slate-500">{t('coa.superseded', { reason: d.supersededReason })}</div>}
              {d.voidReason && <div className="text-xs text-slate-500">{t('coa.voided', { reason: d.voidReason })}</div>}
            </td>
            <td>
              {d.signatures.map(s => (
                <div key={s.id} className="text-xs">
                  <strong>{s.signerName}</strong> ({s.signerRole}), <bdi dir="ltr">{utcText(s.timestamp)}</bdi>
                  <div className="text-slate-500">{s.meaning}</div>
                </div>
              ))}
            </td>
            <td className="space-x-1 whitespace-nowrap">
              <button type="button" className={button} disabled={!d.pdfSha256} onClick={() => onCopy(d)}>{t('coa.copy')}</button>
              <button type="button" className={button} disabled={!d.originalRunId} onClick={() => onVerify(d)}>{t('coa.verify')}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Signing = { kind: 'issue' } | { kind: 'reissue' | 'void'; doc: CoaDocumentRow };

const resultOf = (r: unknown): any => { if (typeof r !== 'string') return r ?? {}; try { return JSON.parse(r); } catch { return {}; } };

/** Waits for a rendering job (GET /reports/status/:jobId, owner only) and answers its result, or throws its error. */
async function waitForJob(jobId: string, timeoutMs = 60_000): Promise<{ documentId: string; runId: string }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await apiFetch<{ status: string; result?: unknown; error?: string }>(`/reports/status/${encodeURIComponent(jobId)}`);
    if (s.status === 'completed') return resultOf(s.result);
    if (s.status === 'failed') throw new Error(s.error || t('coa.jobFailed'));
    if (Date.now() > end) throw new Error(t('coa.jobPending'));
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function saveRun(runId: string) {
  const blob = await apiFetch<Blob>(`/reports/runs/${encodeURIComponent(runId)}/pdf`, { parse: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${runId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CoaPanel({ sampleId, token }: { sampleId: string; token?: string }) {
  const { lang } = useLang();
  const { toast } = useToast();
  const session = useSessionState();
  const [info, setInfo] = useState<CoaEligibility | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState<Signing | null>(null);

  const load = useCallback(async () => {
    try { setInfo(await apiFetch<CoaEligibility>(`/coa/${encodeURIComponent(sampleId)}`)); }
    catch (err) { toast.error(localizedError(err, 'coa.loadFailed')); }
  }, [sampleId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => toast.error(localizedError(err, 'coa.permsFailed')));
  }, [toast]);

  // A refused signature throws: the dialog shows the server's message and stays open. Once signed, the dialog closes and the
  // original PDF is awaited separately, so a slow or failed rendering is reported as such and not as a failed signature.
  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, ...(totpCode ? { totpCode } : {}) };
    let jobId: string | null = null;
    if (signing.kind === 'void') {
      await apiFetch(`/coa/documents/${signing.doc.id}/void`, { body: { ...cred, reason: reason ?? '', expectedVersion: signing.doc.version } });
      toast.success(t('coa.voidedToast', { label: signing.doc.label }));
    } else {
      const out = signing.kind === 'issue'
        ? await apiFetch<{ document: CoaDocumentRow; jobId: string }>(`/coa/${encodeURIComponent(sampleId)}`, { body: { ...cred, ...(reason ? { reason } : {}) } })
        : await apiFetch<{ document: CoaDocumentRow; jobId: string }>(`/coa/documents/${signing.doc.id}/reissue`, { body: { ...cred, reason: reason ?? '', expectedVersion: signing.doc.version } });
      toast.success(t('coa.issuedToast', { label: out.document.label }));
      jobId = out.jobId;
    }
    setSigning(null);
    await load();
    if (jobId) {
      setBusy(true);
      try { await waitForJob(jobId); toast.success(t('coa.originalReady')); }
      catch (err) { toast.error(localizedError(err, 'coa.originalFailed')); }
      finally { setBusy(false); await load(); }
    }
  };

  const copy = async (d: CoaDocumentRow) => {
    setBusy(true);
    try {
      const { jobId, purpose } = await apiFetch<{ jobId: string; purpose: 'Original' | 'Copy' }>(`/coa/documents/${d.id}/copies`, { body: {} });
      // No original yet: the server queued the original (for the issuer, whose job it is) instead of a copy. Nothing to download now.
      if (purpose === 'Original') {
        toast.error(t('coa.originalMissing', { label: d.label }));
        await load();
        return;
      }
      const { runId } = await waitForJob(jobId);
      await saveRun(runId);
      toast.success(t('coa.copySaved', { label: d.label }));
    } catch (err) { toast.error(localizedError(err, 'coa.copyFailed')); }
    finally { setBusy(false); }
  };

  const verify = async (d: CoaDocumentRow) => {
    try {
      const v = await apiFetch<{ valid: boolean; checks: Record<string, unknown> }>(`/reports/runs/${d.originalRunId}/verify`);
      if (v.valid) toast.success(t('coa.verified', { label: d.label }));
      else toast.error(t('coa.verifyFailed', { label: d.label, checks: Object.entries(v.checks).filter(([, ok]) => ok !== true && ok !== 'valid' && ok !== null).map(([k]) => k).join(', ') }));
    } catch (err) { toast.error(localizedError(err, 'coa.verifyError')); }
  };

  if (!info) return null;
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-3" aria-label={t('coa.title')}>
      <h3 className="font-semibold flex items-center gap-2"><FileCheck2 className="w-4 h-4" aria-hidden="true" /> {t('coa.title')}</h3>
      <CoaActions info={info} canIssue={permissions.includes('coa.issue')} busy={busy}
        onIssue={() => setSigning({ kind: 'issue' })} onReissue={doc => setSigning({ kind: 'reissue', doc })} onVoid={doc => setSigning({ kind: 'void', doc })} />
      <CoaDocumentTable documents={info.documents} onCopy={copy} onVerify={verify} />
      {signing && (
        <ElectronicSignatureModal
          user={session.user ? { ...session.user, email: session.user.email ?? undefined } : undefined}
          token={token}
          meaningCode={signing.kind === 'void' ? 'COA_VOID' : 'COA_AUTHORISATION'}
          action={signing.kind === 'issue' ? 'issue the certificate' : signing.kind === 'reissue' ? 're-issue the certificate' : 'void the certificate'}
          entityName={signing.kind === 'issue' ? sampleId : signing.doc.label}
          recordVersion={signing.kind === 'issue' ? 1 : signing.doc.version}
          requiresReason={signing.kind !== 'issue'}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
      <p className="text-xs text-slate-500 flex items-center gap-1"><ShieldCheck className="w-3 h-3" aria-hidden="true" /> {t('coa.footer')}</p>
      {lang !== 'en' && <p className="text-xs text-slate-500">{t('coa.pdfEnglish')}</p>}
    </section>
  );
}
