// API clients screen (roadmap M22, r2-api-v1): the machine principals of /api/v1. An Administrator creates a client (name, scopes, expiry,
// optionally the instrument it speaks for) and revokes it, each with an e-signature (ADMIN_AUTHORISATION). The token is shown ONCE, in a
// dialog, right after creation; the server keeps only its hash. The server decides everything again: this screen only offers the calls.
import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, ShieldOff } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';

export interface ApiClientRow {
  id: string; name: string; description: string; userId: string; tokenPrefix: string; scopes: string[]; instrumentId: string | null;
  status: 'Active' | 'Expired' | 'Revoked'; expiresAt: string; createdBy: string; createdAt: string; lastUsedAt: string | null;
  revokedAt: string | null; revokedBy: string | null; revokedReason: string | null; version: number;
}
interface ScopeInfo { scope: string; description: string }

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const STATUS_TONE: Record<ApiClientRow['status'], string> = {
  Active: 'bg-emerald-50 text-emerald-800 border-emerald-200', Expired: 'bg-amber-50 text-amber-800 border-amber-200', Revoked: 'bg-slate-100 text-slate-700 border-slate-300',
};
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '-');

type Draft = { name: string; description: string; scopes: string[]; expiresInDays: number; instrumentId: string };
const EMPTY: Draft = { name: '', description: '', scopes: [], expiresInDays: 90, instrumentId: '' };

/** What is wrong with a draft before it goes to the signature dialog (the server checks the same and more). */
export function draftProblem(d: Draft): string | null {
  if (d.name.trim().length < 3) return 'The name needs at least 3 characters.';
  if (d.scopes.length === 0) return 'Choose at least one scope.';
  if (!Number.isInteger(d.expiresInDays) || d.expiresInDays < 1 || d.expiresInDays > 365) return 'A token is valid for 1 to 365 days.';
  return null;
}

export function ApiClients({ token, user }: { token: string; user: SelfUser }) {
  const { toast } = useToast();
  const [clients, setClients] = useState<ApiClientRow[]>([]);
  const [scopes, setScopes] = useState<ScopeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [signing, setSigning] = useState<{ kind: 'create'; draft: Draft } | { kind: 'revoke'; client: ApiClientRow } | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ clients: ApiClientRow[]; scopes: ScopeInfo[] }>('/api-clients');
      setClients(r.clients);
      setScopes(r.scopes);
    } catch (err) {
      toast.error(errorMessage(err, 'The API clients could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void refresh(); }, [refresh]);

  const startCreate = () => {
    if (!draft) return;
    const problem = draftProblem(draft);
    if (problem) { toast.error(problem); return; }
    setSigning({ kind: 'create', draft });
  };

  // When the call throws, the dialog shows the server's message and stays open so the signer can correct the entry.
  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, reason: reason ?? '', ...(totpCode ? { totpCode } : {}) };
    if (signing.kind === 'create') {
      const d = signing.draft;
      const body = {
        name: d.name.trim(), scopes: d.scopes, expiresInDays: d.expiresInDays, ...cred,
        ...(d.description.trim() ? { description: d.description.trim() } : {}), ...(d.instrumentId.trim() ? { instrumentId: d.instrumentId.trim() } : {}),
      };
      const r = await apiFetch<{ client: ApiClientRow; token: string }>('/api-clients', { body, replay: 'never' });
      setIssued({ name: r.client.name, token: r.token });
      setDraft(null);
      toast.success(`API client ${r.client.name} created, signed (audit logged)`);
    } else {
      const r = await apiFetch<ApiClientRow>(`/api-clients/${encodeURIComponent(signing.client.id)}/revoke`, { body: { expectedVersion: signing.client.version, ...cred }, replay: 'never' });
      toast.success(`API client ${r.name} revoked, signed (audit logged)`);
    }
    setSigning(null);
    await refresh();
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); toast.success('Token copied to the clipboard.'); } catch {
      toast.error('The clipboard is not available here: select the token and copy it by hand.');
    }
  };

  const toggleScope = (scope: string) => setDraft(d => (d ? { ...d, scopes: d.scopes.includes(scope) ? d.scopes.filter(s => s !== scope) : [...d.scopes, scope] } : d));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><KeyRound className="w-5 h-5" aria-hidden="true" /> API clients</h1>
        <div className="flex gap-2">
          <a className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50" href="/api/v1/docs/" target="_blank" rel="noreferrer">API reference</a>
          <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}><Plus className="w-4 h-4" aria-hidden="true" /> New API client</Button>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        Instruments and connected systems call <code>/api/v1</code> with a token of their own. Everything a client writes is recorded under its own
        service account. A token never signs: reviews, approvals and release stay with a person.
      </p>

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <caption className="sr-only">API clients</caption>
          <thead className="bg-slate-50 text-start">
            <tr>
              <th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Token</th><th scope="col" className="px-3 py-2">Scopes</th>
              <th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Expires</th><th scope="col" className="px-3 py-2">Last used</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-3 py-4 text-slate-600">Loading...</td></tr>}
            {!loading && clients.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-slate-600">No API client yet.</td></tr>}
            {clients.map(c => (
              <tr key={c.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2"><div className="font-medium text-slate-800">{c.name}</div>{c.description && <div className="text-xs text-slate-600">{c.description}</div>}{c.instrumentId && <div className="text-xs text-slate-600">Instrument {c.instrumentId}</div>}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.tokenPrefix}_...</td>
                <td className="px-3 py-2 font-mono text-xs">{c.scopes.join(', ')}</td>
                <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 text-xs border rounded ${STATUS_TONE[c.status]}`}>{c.status}</span>{c.revokedReason && <div className="text-xs text-slate-600 mt-1">{c.revokedReason}</div>}</td>
                <td className="px-3 py-2">{day(c.expiresAt)}</td>
                <td className="px-3 py-2">{day(c.lastUsedAt)}</td>
                <td className="px-3 py-2 text-end">
                  {c.status !== 'Revoked' && <Button size="sm" onClick={() => setSigning({ kind: 'revoke', client: c })}><ShieldOff className="w-4 h-4" aria-hidden="true" /> Revoke</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!draft && !signing} title="New API client" onClose={() => setDraft(null)} size="lg"
        description="The token is shown once, after you sign. Choose only the scopes the system needs."
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" onClick={startCreate}>Sign and create</Button></>}>
        {draft && (
          <div className="space-y-3">
            <Field label="Name" required hint="For example the instrument or the system: HPLC-02 bridge">{p => <input {...p} className={`${input} w-full`} value={draft.name} maxLength={100} onChange={e => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Description">{p => <input {...p} className={`${input} w-full`} value={draft.description} maxLength={500} onChange={e => setDraft({ ...draft, description: e.target.value })} />}</Field>
            <Field label="Instrument id" hint="Optional: results from this client are then always recorded on this instrument (its calibration is checked).">{p => <input {...p} className={`${input} w-full`} value={draft.instrumentId} maxLength={64} onChange={e => setDraft({ ...draft, instrumentId: e.target.value })} />}</Field>
            <Field label="Valid for (days)" required hint="1 to 365 days.">{p => <input {...p} type="number" min={1} max={365} className={`${input} w-32`} value={draft.expiresInDays} onChange={e => setDraft({ ...draft, expiresInDays: Number(e.target.value) })} />}</Field>
            <fieldset>
              <legend className="text-sm font-medium text-slate-700">Scopes</legend>
              {scopes.map(s => (
                <label key={s.scope} className="flex items-start gap-2 mt-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={draft.scopes.includes(s.scope)} onChange={() => toggleScope(s.scope)} />
                  <span><code className="font-mono">{s.scope}</code><span className="block text-xs text-slate-600">{s.description}</span></span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </Modal>

      <Modal open={!!issued} title="Copy the token now" onClose={() => setIssued(null)} role="alertdialog"
        description="This is the only time the token is shown. Store it in the connected system's credential store; if it is lost, revoke the client and create a new one."
        footer={<><Button onClick={copy}><Copy className="w-4 h-4" aria-hidden="true" /> Copy</Button><Button variant="primary" onClick={() => setIssued(null)}>I have stored it</Button></>}>
        {issued && (
          <div className="space-y-2">
            <p className="text-sm text-slate-700">Token of <strong>{issued.name}</strong>:</p>
            <input readOnly aria-label="API token" className={`${input} w-full font-mono`} value={issued.token} onFocus={e => e.currentTarget.select()} />
          </div>
        )}
      </Modal>

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode="ADMIN_AUTHORISATION"
          action={signing.kind === 'create' ? 'create API client' : 'revoke API client'}
          entityName={signing.kind === 'create' ? signing.draft.name : signing.client.name}
          recordVersion={signing.kind === 'create' ? 1 : signing.client.version}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
