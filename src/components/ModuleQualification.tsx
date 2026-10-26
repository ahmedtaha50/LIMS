// Module qualification screen (roadmap M37, r2-validation): which functional modules QA has declared Qualified or NotQualified for GxP use.
// A NotQualified module refuses writes on the server (403 MODULE_NOT_QUALIFIED) while its data stays readable; the screen says so in words,
// not only in a colour. QA declares a status with an e-signature (MODULE_QUALIFICATION) bound to the record version. The server decides
// everything again: this screen only offers the call.
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission, type PermissionCode } from '../lib/permissions';

export type ScopeStatus = 'Undeclared' | 'Qualified' | 'NotQualified';
export interface ScopeRow {
  module: string; title: string; segments: string[]; status: ScopeStatus; declared: boolean; writesAllowed: boolean;
  reason: string | null; evidenceRef: string | null; updatedBy: string | null; updatedAt: string | null; version: number;
}

const TONE: Record<ScopeStatus, Tone> = { Undeclared: 'neutral', Qualified: 'success', NotQualified: 'danger' };
const MEANING: Record<ScopeStatus, string> = {
  Undeclared: 'Not declared: changes are allowed',
  Qualified: 'Qualified: changes are allowed',
  NotQualified: 'Read-only: changes are refused',
};
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '-');
const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';

/** The register as a table. Pure, so it can be rendered without a browser. */
export function ScopeTable({ rows, canDeclare, loading = false, onDeclare }: { rows: ScopeRow[]; canDeclare: boolean; loading?: boolean; onDeclare?: (row: ScopeRow) => void }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <caption className="sr-only">Qualification status of the functional modules</caption>
        <thead className="bg-slate-50 text-start">
          <tr>
            <th scope="col" className="px-3 py-2">Module</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Basis</th>
            <th scope="col" className="px-3 py-2">Declared</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={5} className="px-3 py-4 text-slate-700">Loading...</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-slate-700">No module is in the register.</td></tr>}
          {rows.map(r => (
            <tr key={r.module} data-module={r.module} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2"><div className="font-medium text-slate-900">{r.title}</div><div className="text-xs text-slate-700 font-mono">{r.module}</div></td>
              <td className="px-3 py-2"><Badge tone={TONE[r.status]}>{r.status}</Badge><div className="text-xs text-slate-700 mt-1">{MEANING[r.status]}</div></td>
              <td className="px-3 py-2 text-slate-800">{r.reason ?? '-'}{r.evidenceRef && <div className="text-xs text-slate-700">Evidence: {r.evidenceRef}</div>}</td>
              <td className="px-3 py-2 text-slate-800">{r.declared ? `${day(r.updatedAt)} (version ${r.version})` : '-'}</td>
              <td className="px-3 py-2 text-end">
                {canDeclare && <Button size="sm" onClick={() => onDeclare?.(r)}>Declare...</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ModuleQualification({ token, user }: { token: string; user: SelfUser }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<{ row: ScopeRow; status: 'Qualified' | 'NotQualified'; evidenceRef: string } | null>(null);
  const [signing, setSigning] = useState<{ row: ScopeRow; status: 'Qualified' | 'NotQualified'; evidenceRef: string } | null>(null);

  const refresh = useCallback(async () => {
    try { setRows(await apiFetch<ScopeRow[]>('/validation/modules')); } catch (err) { toast.error(errorMessage(err, 'The module qualification could not be loaded.')); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions))
      .catch(e => { setPermissions([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);

  const canDeclare = hasPermission(permissions, 'validation.scope' as PermissionCode);

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const body = {
      status: signing.status, reason: reason ?? '', expectedVersion: signing.row.version, password,
      ...(signing.evidenceRef.trim() ? { evidenceRef: signing.evidenceRef.trim() } : {}), ...(totpCode ? { totpCode } : {}),
    };
    await apiFetch(`/validation/modules/${encodeURIComponent(signing.row.module)}/status`, { body, replay: 'never' });
    toast.success(`${signing.row.title} declared ${signing.status}, signed (audit logged)`);
    setSigning(null);
    setDraft(null);
    await refresh();
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><ShieldCheck className="w-5 h-5" aria-hidden="true" /> Module qualification</h1>
      <p className="text-sm text-slate-700">
        QA declares which modules are qualified for GxP use. Changes to a module declared NotQualified are refused by the server and recorded as a
        security event; its records stay readable. The core (sign-in, samples, results, signatures, audit trail, backup) cannot be switched off.
        A module nobody has declared behaves as before.
      </p>
      <ScopeTable rows={rows} canDeclare={canDeclare} loading={loading} onDeclare={row => setDraft({ row, status: row.status === 'NotQualified' ? 'Qualified' : 'NotQualified', evidenceRef: row.evidenceRef ?? '' })} />

      <Modal open={!!draft && !signing} title={draft ? `Declare ${draft.row.title}` : ''} onClose={() => setDraft(null)}
        description="The declaration is signed by QA and bound to the version of this record."
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" onClick={() => draft && setSigning(draft)}>Sign...</Button></>}>
        {draft && (
          <div className="space-y-3">
            <Field label="Status" required>{p => (
              <select {...p} className={`${input} w-full`} value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as 'Qualified' | 'NotQualified' })}>
                <option value="Qualified">Qualified: changes are allowed</option>
                <option value="NotQualified">NotQualified: changes are refused</option>
              </select>
            )}</Field>
            <Field label="Evidence" hint="The qualification record this declaration rests on, for example OQ-10 or a document number.">{p => (
              <input {...p} className={`${input} w-full`} maxLength={500} value={draft.evidenceRef} onChange={e => setDraft({ ...draft, evidenceRef: e.target.value })} />
            )}</Field>
          </div>
        )}
      </Modal>

      {signing && (
        <ElectronicSignatureModal
          user={{ ...user, email: user.email ?? undefined }}
          token={token}
          meaningCode="MODULE_QUALIFICATION"
          action={`declare ${signing.status}`}
          entityName={signing.row.title}
          recordVersion={signing.row.version + 1}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
