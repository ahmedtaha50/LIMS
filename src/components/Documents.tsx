// Controlled documents screen (roadmap M28, r2-docs-training): the register, the versions of a document and their signed steps.
// The server is the authority on every step (src/server/documents.ts); `availableSteps` only decides which buttons to show, from the
// version's state, who the user is and what GET /permissions/me grants. Every signed step goes through the e-signature dialog with
// the step's own meaning code; every refusal is shown as the server worded it.
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Download, FilePlus2, Printer, ShieldCheck, Upload } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

export type DocStatus = 'Draft' | 'InReview' | 'Approved' | 'Effective' | 'Superseded' | 'Obsolete';
export interface VersionRow {
  id: string; documentId: string; revision: number; title: string; changeSummary: string; status: DocStatus | string;
  fileName: string | null; mediaType: string | null; bytes: number | null; fileSha256: string | null;
  authorId: string; reviewerId: string | null; approverId: string | null; effectiveBy: string | null; effectiveAt: string | null; version: number;
}
export interface DocumentRow {
  id: string; code: string; title: string; docType: string; reviewPeriodMonths: number; version: number;
  effective: VersionRow | null; open: VersionRow | null; reviewDue: string | null; reviewOverdue: boolean;
}
interface SignatureRow { id: string; entityId: string; meaningCode: string; meaning: string; signerName: string; signerRole: string; timestamp: string; recordVersion: number; reason: string }
interface Detail { document: DocumentRow; versions: VersionRow[]; signatures: SignatureRow[] }
interface PrintRow { id: string; copyNumber: number; purpose: string; recipient: string | null; printedByName: string | null; printedAt: string }

export const STATUS_LABEL: Record<string, string> = {
  Draft: 'Draft', InReview: 'In review', Approved: 'Approved', Effective: 'Effective', Superseded: 'Superseded', Obsolete: 'Obsolete',
};
const STATUS_STYLE: Record<string, string> = {
  Draft: 'bg-slate-100 text-slate-700', InReview: 'bg-amber-50 text-amber-800', Approved: 'bg-blue-50 text-blue-700',
  Effective: 'bg-emerald-50 text-emerald-700', Superseded: 'bg-slate-100 text-slate-500', Obsolete: 'bg-red-50 text-red-700',
};
export const StatusBadge = ({ status }: { status: string }) =>
  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_STYLE[status] ?? 'bg-slate-100'}`}>{STATUS_LABEL[status] ?? status}</span>;

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50';

export type Step = 'edit' | 'upload' | 'submit' | 'review' | 'approve' | 'return' | 'effective' | 'print' | 'obsolete';
const SIGNED: Partial<Record<Step, string>> = {
  submit: 'DOCUMENT_AUTHORSHIP', review: 'DOCUMENT_REVIEW', approve: 'DOCUMENT_APPROVAL', effective: 'DOCUMENT_EFFECTIVE', obsolete: 'DOCUMENT_OBSOLETE',
};
const STEP_LABEL: Record<Step, string> = {
  edit: 'Save', upload: 'Upload file', submit: 'Submit for review', review: 'Sign review', approve: 'Sign approval', return: 'Return to Draft',
  effective: 'Make effective', print: 'Print controlled copy', obsolete: 'Withdraw (obsolete)',
};

/**
 * The steps this user is offered for a version. The rules mirror the server's: only the author changes and submits a Draft; review and
 * approval by people independent of the author (and approval of the reviewer); effectivity by QA, never the author.
 */
export function availableSteps(v: VersionRow, me: { id: string; role: string }, perms: { author: boolean; review: boolean; approve: boolean }): Step[] {
  const isAuthor = v.authorId === me.id;
  switch (v.status) {
    case 'Draft': return perms.author && isAuthor ? ['edit', 'upload', 'submit'] : [];
    case 'InReview': {
      if (isAuthor) return [];
      const steps: Step[] = [];
      if (perms.review && !v.reviewerId) steps.push('review');
      if (perms.approve && v.reviewerId && v.reviewerId !== me.id) steps.push('approve');
      if (perms.review) steps.push('return');
      return steps;
    }
    case 'Approved': {
      if (isAuthor) return [];
      const steps: Step[] = [];
      if (perms.approve && me.role === 'QA') steps.push('effective');
      if (perms.review) steps.push('return');
      return steps;
    }
    case 'Effective': return me.role === 'QA' || me.role === 'Admin' ? ['print', 'obsolete'] : ['print'];
    default: return [];
  }
}

/** The register (rendered on its own by tests/api/docs-training-ui.test.ts). */
export function DocumentTable({ documents, selected, onSelect }: { documents: readonly DocumentRow[]; selected?: string; onSelect: (id: string) => void }) {
  if (documents.length === 0) return <p className="text-sm text-slate-500 p-4">No controlled documents yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Code</th><th className="p-2">Title</th><th className="p-2">Effective</th><th className="p-2">In progress</th><th className="p-2">Periodic review</th></tr>
      </thead>
      <tbody>
        {documents.map(d => (
          <tr key={d.id} className={`border-t border-slate-100 cursor-pointer ${selected === d.id ? 'bg-blue-50' : 'hover:bg-slate-50'}`} onClick={() => onSelect(d.id)}>
            <td className="p-2 font-mono"><button type="button" className="hover:underline" onClick={() => onSelect(d.id)}>{d.code}</button></td>
            <td className="p-2">{d.title}<span className="ms-2 text-xs text-slate-400">{d.docType}</span></td>
            <td className="p-2">{d.effective ? `Rev ${d.effective.revision}` : <span className="text-slate-400">none effective</span>}</td>
            <td className="p-2">{d.open ? <>Rev {d.open.revision} <StatusBadge status={d.open.status} /></> : ''}</td>
            <td className="p-2">{d.reviewDue ?? ''}{d.reviewOverdue && <span className="ms-2 px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-700">Review overdue</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Signing = { step: Step; version: VersionRow };

export function Documents({ token, user, documentId }: { token?: string; user: any; documentId?: string }) {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [selected, setSelected] = useState<string | undefined>(documentId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [creating, setCreating] = useState<{ code: string; title: string; docType: string } | null>(null);
  const [draft, setDraft] = useState<{ title: string; changeSummary: string }>({ title: '', changeSummary: '' });
  const [file, setFile] = useState<File | null>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [print, setPrint] = useState({ purpose: '', recipient: '' });
  const [prints, setPrints] = useState<PrintRow[]>([]);
  const [footer, setFooter] = useState<string | null>(null);
  const me = { id: user?.id ?? '', role: user?.role ?? '' };
  const perms = { author: permissions.includes('doc.author'), review: permissions.includes('doc.review'), approve: permissions.includes('doc.approve') };

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);
  const loadDocs = useCallback(async () => {
    try { setDocs(await apiFetch<DocumentRow[]>('/documents')); } catch (err) { fail(err, 'The document register could not be loaded.'); }
  }, [fail]);
  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await apiFetch<Detail>(`/documents/${encodeURIComponent(id)}`);
      setDetail(d);
      const open = d.versions.find(v => v.status === 'Draft');
      setDraft({ title: open?.title ?? '', changeSummary: open?.changeSummary ?? '' });
      const eff = d.versions.find(v => v.status === 'Effective');
      setPrints(eff ? await apiFetch<PrintRow[]>(`/document-versions/${eff.id}/prints`) : []);
    } catch (err) { setDetail(null); fail(err, `Document ${id} could not be loaded.`); }
  }, [fail]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
  }, [fail]);
  useEffect(() => { loadDocs(); }, [loadDocs]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);

  const refresh = async () => { await loadDocs(); if (selected) await loadDetail(selected); };
  const run = async (what: string, call: () => Promise<unknown>) => {
    try { await call(); await refresh(); toast.success(`${what} (audit logged)`); return true; } catch (err) { fail(err, `${what} failed.`); return false; }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creating) return;
    try {
      const r = await apiFetch<{ document: { id: string; code: string } }>('/documents', { body: creating });
      toast.success(`${r.document.code} created as a Draft (audit logged)`);
      setCreating(null);
      await loadDocs();
      setSelected(r.document.id);
    } catch (err) { fail(err, 'The document could not be created.'); }
  };

  const act = async (step: Step, v: VersionRow) => {
    if (SIGNED[step]) { setSigning({ step, version: v }); return; }
    if (step === 'edit') {
      const body: Record<string, unknown> = { expectedVersion: v.version };
      if (draft.title !== v.title) body.title = draft.title;
      if (draft.changeSummary !== v.changeSummary) body.changeSummary = draft.changeSummary;
      if (Object.keys(body).length === 1) { toast.error('There is nothing to change.'); return; }
      await run(`Revision ${v.revision} saved`, () => apiFetch(`/document-versions/${v.id}`, { method: 'PUT', body }));
    } else if (step === 'upload') {
      if (!file) { toast.error('Choose the file to attach first.'); return; }
      const q = new URLSearchParams({ fileName: file.name, expectedVersion: String(v.version) });
      await run(`${file.name} attached`, () => apiFetch(`/document-versions/${v.id}/file?${q}`, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } }));
      setFile(null);
    } else if (step === 'return') {
      if (returnReason.trim().length < 5) { toast.error('Give the reason for returning the version (at least 5 characters).'); return; }
      await run(`Revision ${v.revision} returned to Draft`, () => apiFetch(`/document-versions/${v.id}/return`, { body: { reason: returnReason.trim(), expectedVersion: v.version } }));
      setReturnReason('');
    } else if (step === 'print') {
      if (print.purpose.trim().length < 3) { toast.error('Say what the controlled copy is for.'); return; }
      try {
        const r = await apiFetch<{ footer: string; print: { copyNumber: number } }>(`/document-versions/${v.id}/print`, {
          body: { purpose: print.purpose.trim(), ...(print.recipient.trim() ? { recipient: print.recipient.trim() } : {}) },
        });
        setFooter(r.footer);
        toast.success(`Controlled copy ${r.print.copyNumber} logged; print the file with the footer shown.`);
        setPrint({ purpose: '', recipient: '' });
        await refresh();
      } catch (err) { fail(err, 'The controlled copy could not be issued.'); }
    }
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const { step, version } = signing;
    const body: Record<string, unknown> = { password, expectedVersion: version.version, ...(reason ? { reason } : {}), ...(totpCode ? { totpCode } : {}) };
    // The dialog shows the server's message when the signature is refused; on success the screen reloads before it reports.
    await apiFetch(`/document-versions/${version.id}/${step}`, { body });
    setSigning(null);
    await refresh();
    toast.success(`${STEP_LABEL[step]}: revision ${version.revision} signed (audit logged)`);
  };

  const download = async (v: VersionRow) => {
    try {
      const blob = await apiFetch<Blob>(`/document-versions/${v.id}/content`, { parse: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = v.fileName ?? 'document';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { fail(err, 'The file could not be downloaded.'); }
  };

  const revise = (d: DocumentRow) => run(`Revision drafted for ${d.code}`, () => apiFetch(`/documents/${d.id}/revise`, { body: {} }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><BookOpen className="w-6 h-6 text-blue-600" /> Controlled Documents</h2>
        {perms.author && <button type="button" className={primary} onClick={() => setCreating({ code: '', title: '', docType: 'SOP' })}><FilePlus2 className="w-4 h-4 inline me-1" />New document</button>}
      </div>

      {creating && (
        <form onSubmit={create} className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <label className="text-xs text-slate-600">Code<input className={`${input} w-full`} value={creating.code} onChange={e => setCreating({ ...creating, code: e.target.value })} required /></label>
          <label className="text-xs text-slate-600 md:col-span-2">Title<input className={`${input} w-full`} value={creating.title} onChange={e => setCreating({ ...creating, title: e.target.value })} required /></label>
          <label className="text-xs text-slate-600">Type
            <select className={`${input} w-full`} value={creating.docType} onChange={e => setCreating({ ...creating, docType: e.target.value })}>
              {['SOP', 'Method', 'Policy', 'Form', 'Specification', 'Other'].map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <div className="md:col-span-4 flex gap-2"><button type="submit" className={primary}>Create Draft</button><button type="button" className={button} onClick={() => setCreating(null)}>Cancel</button></div>
        </form>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden"><DocumentTable documents={docs} selected={selected} onSelect={setSelected} /></div>

      {detail && (
        <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-4" aria-label={`Document ${detail.document.code}`}>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">{detail.document.code}: {detail.document.title}</h3>
            {perms.author && !detail.versions.some(v => ['Draft', 'InReview', 'Approved'].includes(v.status)) && detail.versions.some(v => v.status === 'Effective') &&
              <button type="button" className={button} onClick={() => revise(detail.document)}>Draft new revision</button>}
          </div>
          {detail.versions.map(v => {
            const steps = availableSteps(v, me, perms);
            const sigs = detail.signatures.filter(s => s.entityId === v.id);
            return (
              <div key={v.id} className="border border-slate-100 rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">Rev {v.revision}</span><StatusBadge status={v.status} /><span>{v.title}</span>
                  {v.fileName && <button type="button" className={button} onClick={() => download(v)}><Download className="w-4 h-4 inline me-1" />{v.fileName}</button>}
                  {v.fileSha256 && <span className="font-mono text-xs text-slate-400">sha256 {v.fileSha256.slice(0, 16)}...</span>}
                </div>
                {v.status === 'Draft' && steps.includes('edit') && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label className="text-xs text-slate-600">Title<input className={`${input} w-full`} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
                    <label className="text-xs text-slate-600">Change summary<input className={`${input} w-full`} value={draft.changeSummary} onChange={e => setDraft({ ...draft, changeSummary: e.target.value })} /></label>
                    <label className="text-xs text-slate-600">File (PDF, Word, Excel or text)<input type="file" accept=".pdf,.docx,.xlsx,.txt" className="block text-sm" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
                  </div>
                )}
                {steps.includes('return') && (
                  <label className="text-xs text-slate-600 block">Reason for returning to Draft<input className={`${input} w-full`} value={returnReason} onChange={e => setReturnReason(e.target.value)} /></label>
                )}
                {steps.includes('print') && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label className="text-xs text-slate-600">Purpose of the copy<input className={`${input} w-full`} value={print.purpose} onChange={e => setPrint({ ...print, purpose: e.target.value })} /></label>
                    <label className="text-xs text-slate-600">Recipient (optional)<input className={`${input} w-full`} value={print.recipient} onChange={e => setPrint({ ...print, recipient: e.target.value })} /></label>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {steps.map(s => (
                    <button key={s} type="button" className={SIGNED[s] ? primary : button} onClick={() => act(s, v)}>
                      {SIGNED[s] ? <ShieldCheck className="w-4 h-4 inline me-1" /> : s === 'upload' ? <Upload className="w-4 h-4 inline me-1" /> : s === 'print' ? <Printer className="w-4 h-4 inline me-1" /> : null}
                      {STEP_LABEL[s]}{SIGNED[s] ? ' (sign)' : ''}
                    </button>
                  ))}
                </div>
                {sigs.length > 0 && (
                  <ul className="text-xs text-slate-600 space-y-0.5">
                    {sigs.map(s => <li key={s.id}>{s.meaningCode}: {s.signerName} ({s.signerRole}), {formatDateTime(s.timestamp)}, record version {s.recordVersion}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
          {footer && <p className="text-xs font-mono bg-amber-50 border border-amber-200 rounded p-2" aria-label="controlled copy footer">{footer}</p>}
          {prints.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-slate-500 uppercase mb-1">Print log (effective revision)</h4>
              <ul className="text-xs text-slate-600">{prints.map(p => <li key={p.id}>Copy {p.copyNumber}: {p.purpose}{p.recipient ? ` for ${p.recipient}` : ''}, {p.printedByName}, {formatDateTime(p.printedAt)}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      {signing && (
        <ElectronicSignatureModal
          user={user} token={token} meaningCode={SIGNED[signing.step]} action={STEP_LABEL[signing.step]}
          entityName={`${detail?.document.code ?? ''} revision ${signing.version.revision}`} recordVersion={signing.version.version}
          onClose={() => setSigning(null)} onSign={(password, reason, totpCode) => sign(password, reason, totpCode)}
        />
      )}
    </div>
  );
}
