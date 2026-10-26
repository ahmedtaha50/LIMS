// Directory sign-on screen (roadmap M41, r3-directory): the LDAPS / StartTLS connection, the QA-approved group to role mapping, and
// the directory and break-glass accounts. The Administrator changes the connection and proposes mappings (password and a reason on
// every change); QA approves or retires a mapping with an e-signature (DIRECTORY_MAPPING) bound to the record version. The server
// decides everything again: this screen only offers the calls and says in words what each state means.
import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission, type PermissionCode } from '../lib/permissions';

export interface DirectorySettingsView {
  enabled: boolean; url: string | null; security: 'ldaps' | 'starttls'; caPem: string | null; bindDn: string | null; hasBindPassword: boolean;
  baseDn: string | null; groupAttribute: string; timeoutMs: number; localAccountsAllowed: boolean; version: number;
}
export interface MappingRow { id: string; groupDn: string; role: string; status: 'Draft' | 'Approved' | 'Retired'; reason: string; createdBy: string; version: number }
export interface AccountRow { userId: string; kind: 'ldap' | 'break-glass'; email: string | null; name: string; role: string; active: boolean; mfaEnabled: boolean; groups: string[]; syncedAt: string | null; version: number }

const MAPPING_TONE: Record<MappingRow['status'], Tone> = { Draft: 'warning', Approved: 'success', Retired: 'neutral' };
const MEANING: Record<MappingRow['status'], string> = {
  Draft: 'Proposed: not used at sign-in until QA approves it',
  Approved: 'Approved: members of the group receive the role at each sign-in',
  Retired: 'Retired: no longer used',
};
const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-full';

export function MappingTable({ rows, canDecide, onDecide }: { rows: MappingRow[]; canDecide: boolean; onDecide?: (row: MappingRow, to: 'Approved' | 'Retired') => void }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <caption className="sr-only">Directory group to role mapping</caption>
        <thead className="bg-slate-50 text-left">
          <tr><th scope="col" className="px-3 py-2">Directory group</th><th scope="col" className="px-3 py-2">Role</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-slate-700">No group is mapped. Nobody can sign in with the directory until QA approves a mapping.</td></tr>}
          {rows.map(r => (
            <tr key={r.id} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2 font-mono text-xs break-all">{r.groupDn}<div className="font-sans text-slate-700 mt-1">{r.reason}</div></td>
              <td className="px-3 py-2">{r.role}</td>
              <td className="px-3 py-2"><Badge tone={MAPPING_TONE[r.status]}>{r.status}</Badge><div className="text-xs text-slate-700 mt-1">{MEANING[r.status]}</div></td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {canDecide && r.status === 'Draft' && <Button size="sm" variant="primary" onClick={() => onDecide?.(r, 'Approved')}>Approve...</Button>}
                {canDecide && r.status !== 'Retired' && <Button size="sm" variant="danger" onClick={() => onDecide?.(r, 'Retired')}>Retire...</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DirectorySettings({ token, user }: { token: string; user: SelfUser }) {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [settings, setSettings] = useState<DirectorySettingsView | null>(null);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [form, setForm] = useState({ enabled: false, url: '', security: 'ldaps' as 'ldaps' | 'starttls', caPem: '', bindDn: '', bindPassword: '', baseDn: '', localAccountsAllowed: true });
  const [auth, setAuth] = useState({ password: '', reason: '' });
  const [proposal, setProposal] = useState({ groupDn: '', role: 'Analyst', reason: '' });
  const [signing, setSigning] = useState<{ row: MappingRow; to: 'Approved' | 'Retired' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [bgEmail, setBgEmail] = useState('');

  const canView = hasPermission(permissions, 'directory.view' as PermissionCode);
  const canManage = hasPermission(permissions, 'directory.manage' as PermissionCode);
  const canApprove = hasPermission(permissions, 'directory.approve' as PermissionCode);

  const refresh = useCallback(async () => {
    try {
      const [s, m, a] = await Promise.all([
        apiFetch<DirectorySettingsView>('/directory/settings'), apiFetch<MappingRow[]>('/directory/mappings'), apiFetch<AccountRow[]>('/directory/accounts'),
      ]);
      setSettings(s); setMappings(m); setAccounts(a);
      setForm(f => ({ ...f, enabled: s.enabled, url: s.url ?? '', security: s.security, caPem: s.caPem ?? '', bindDn: s.bindDn ?? '', baseDn: s.baseDn ?? '', bindPassword: '', localAccountsAllowed: s.localAccountsAllowed }));
    } catch (err) { toast.error(errorMessage(err, 'The directory settings could not be loaded.')); }
  }, [toast]);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions))
      .catch(e => { setPermissions([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);
  useEffect(() => { if (canView) void refresh(); }, [canView, refresh]);

  const authorised = () => {
    if (!auth.password || auth.reason.trim().length < 5) { toast.error('Enter your password and a reason of at least 5 characters to apply a change.'); return false; }
    return true;
  };
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); toast.success(what); setAuth({ password: '', reason: '' }); await refresh(); } catch (err) { toast.error(errorMessage(err)); await refresh(); } finally { setBusy(false); }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings || !authorised()) return;
    void run(form.enabled ? 'Directory sign-on is ON. Every directory sign-in is recorded.' : 'Directory sign-on is OFF. Local sign-in is unchanged.', async () => {
      await apiFetch('/directory/settings', { method: 'PUT', replay: 'never', body: {
        enabled: form.enabled, url: form.url.trim(), security: form.security, bindDn: form.bindDn.trim(), baseDn: form.baseDn.trim(),
        caPem: form.caPem.trim() || null, localAccountsAllowed: form.localAccountsAllowed,
        ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}), reason: auth.reason.trim(), expectedVersion: settings.version, password: auth.password,
      } });
    });
  };

  const testConnection = async () => {
    if (!auth.password) return toast.error('Enter your password to test the connection.');
    try {
      const r = await apiFetch<{ reachable: boolean; reason: string | null }>('/directory/test', { body: { password: auth.password }, replay: 'never' });
      setTest(r.reachable ? 'The directory answered: TLS verified and the service account accepted.' : `The directory cannot be used: ${r.reason}`);
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const propose = (e: React.FormEvent) => {
    e.preventDefault();
    void run('Mapping proposed. QA must approve it before it is used.', async () => {
      await apiFetch('/directory/mappings', { body: { groupDn: proposal.groupDn.trim(), role: proposal.role, reason: proposal.reason.trim() }, replay: 'never' });
      setProposal({ groupDn: '', role: 'Analyst', reason: '' });
    });
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    await apiFetch(`/directory/mappings/${encodeURIComponent(signing.row.id)}/${signing.to === 'Approved' ? 'approve' : 'retire'}`, {
      body: { expectedVersion: signing.row.version, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) }, replay: 'never',
    });
    toast.success(`Mapping ${signing.to === 'Approved' ? 'approved' : 'retired'}, signed (audit logged)`);
    setSigning(null);
    await refresh();
  };

  const toggleBreakGlass = (a: AccountRow, enabled: boolean) => {
    if (!authorised()) return;
    void run(enabled ? 'Break-glass account flagged.' : 'Break-glass flag removed.', async () => {
      await apiFetch(`/directory/accounts/${encodeURIComponent(a.userId)}/break-glass`, { body: { enabled, reason: auth.reason.trim(), expectedVersion: enabled ? 0 : a.version, password: auth.password }, replay: 'never' });
    });
  };

  const flagBreakGlass = async () => {
    const wanted = bgEmail.trim().toLowerCase();
    if (!wanted) return toast.error('Enter the email address of the Administrator.');
    if (!authorised()) return;
    try {
      const list = await apiFetch<Array<{ id: string; email: string | null }>>('/admin/users');
      const hit = list.find(u => u.email?.toLowerCase() === wanted);
      if (!hit) return toast.error('No account has that email address.');
      toggleBreakGlass({ userId: hit.id, version: 0 } as AccountRow, true);
      setBgEmail('');
    } catch (err) { toast.error(errorMessage(err)); }
  };

  if (permissions && !canView) return <div className="p-8 text-center text-slate-700">You do not have access to the directory settings.</div>;

  const authFields = canManage && (
    <fieldset className="border border-slate-200 rounded-lg p-3 flex flex-col md:flex-row gap-3">
      <legend className="px-1 text-sm font-medium text-slate-800">Authorise a change</legend>
      <Field label="Your password" className="md:w-64">{p => <input {...p} type="password" autoComplete="current-password" className={input} value={auth.password} onChange={e => setAuth({ ...auth, password: e.target.value })} />}</Field>
      <Field label="Reason" className="flex-1">{p => <input {...p} className={input} maxLength={1000} value={auth.reason} onChange={e => setAuth({ ...auth, reason: e.target.value })} />}</Field>
    </fieldset>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><KeyRound className="w-5 h-5" aria-hidden="true" /> Directory sign-on</h1>
      <p className="text-sm text-slate-700">
        People sign in with their Windows directory password (LDAPS or StartTLS, server certificate always verified). Their role follows the QA-approved group
        mapping at every sign-in. The second factor, lockouts and sessions are the same as for local accounts. A local break-glass Administrator signs in only
        while the directory cannot be reached.
      </p>
      {authFields}

      <section aria-labelledby="dir-conn" className="space-y-3">
        <h2 id="dir-conn" className="text-lg font-medium text-slate-800">Connection {settings && <Badge tone={settings.enabled ? 'success' : 'neutral'}>{settings.enabled ? 'On' : 'Off'}</Badge>}</h2>
        <form onSubmit={save} className="grid md:grid-cols-2 gap-3">
          <Field label="Security" required>{p => (
            <select {...p} disabled={!canManage} className={input} value={form.security} onChange={e => setForm({ ...form, security: e.target.value as 'ldaps' | 'starttls' })}>
              <option value="ldaps">LDAPS (ldaps://, port 636)</option><option value="starttls">StartTLS (ldap://, port 389, upgraded before any password is sent)</option>
            </select>)}</Field>
          <Field label="Server URL" required hint="For example ldaps://dc01.corp.example:636">{p => <input {...p} disabled={!canManage} className={input} value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} />}</Field>
          <Field label="Service account DN" required>{p => <input {...p} disabled={!canManage} className={input} value={form.bindDn} onChange={e => setForm({ ...form, bindDn: e.target.value })} />}</Field>
          <Field label="Service account password" hint={settings?.hasBindPassword ? 'Stored encrypted. Leave empty to keep it.' : 'Stored encrypted; never shown again.'}>{p => <input {...p} type="password" autoComplete="new-password" disabled={!canManage} className={input} value={form.bindPassword} onChange={e => setForm({ ...form, bindPassword: e.target.value })} />}</Field>
          <Field label="Search base" required hint="For example DC=corp,DC=example">{p => <input {...p} disabled={!canManage} className={input} value={form.baseDn} onChange={e => setForm({ ...form, baseDn: e.target.value })} />}</Field>
          <Field label="CA certificate (PEM)" hint="The certificate authority that issued the directory server certificate. Empty: the operating system store.">{p => <textarea {...p} disabled={!canManage} rows={3} className={`${input} font-mono text-xs`} value={form.caPem} onChange={e => setForm({ ...form, caPem: e.target.value })} />}</Field>
          <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" disabled={!canManage} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Directory sign-on is on</label>
          <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" disabled={!canManage} checked={form.localAccountsAllowed} onChange={e => setForm({ ...form, localAccountsAllowed: e.target.checked })} /> Local accounts may still sign in (break-glass accounts always follow their own rule)</label>
          {canManage && (
            <div className="md:col-span-2 flex gap-2 items-center">
              <Button type="submit" variant="primary" busy={busy}>Save</Button>
              <Button onClick={testConnection}>Test connection</Button>
              {test && <span role="status" className="text-sm text-slate-800">{test}</span>}
            </div>
          )}
        </form>
      </section>

      <section aria-labelledby="dir-map" className="space-y-3">
        <h2 id="dir-map" className="text-lg font-medium text-slate-800">Group to role mapping</h2>
        <p className="text-sm text-slate-700">The Administrator role cannot be given by the directory. A person in several mapped groups receives the least privileged of their roles. A person in no approved group cannot sign in.</p>
        <MappingTable rows={mappings} canDecide={canApprove} onDecide={(row, to) => setSigning({ row, to })} />
        {canManage && (
          <form onSubmit={propose} className="grid md:grid-cols-4 gap-3 items-end">
            <Field label="Directory group DN" required className="md:col-span-2">{p => <input {...p} className={input} placeholder="CN=LIMS-Analysts,OU=Groups,DC=corp,DC=example" value={proposal.groupDn} onChange={e => setProposal({ ...proposal, groupDn: e.target.value })} />}</Field>
            <Field label="LIMS role" required>{p => <select {...p} className={input} value={proposal.role} onChange={e => setProposal({ ...proposal, role: e.target.value })}><option>Analyst</option><option>Reviewer</option><option>QA</option></select>}</Field>
            <Field label="Why" required>{p => <input {...p} className={input} value={proposal.reason} onChange={e => setProposal({ ...proposal, reason: e.target.value })} />}</Field>
            <div><Button type="submit" busy={busy}>Propose mapping</Button></div>
          </form>
        )}
      </section>

      <section aria-labelledby="dir-acct" className="space-y-3">
        <h2 id="dir-acct" className="text-lg font-medium text-slate-800">Directory and break-glass accounts</h2>
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <caption className="sr-only">Accounts that sign in through the directory or are flagged break-glass</caption>
            <thead className="bg-slate-50 text-left"><tr><th scope="col" className="px-3 py-2">Person</th><th scope="col" className="px-3 py-2">Kind</th><th scope="col" className="px-3 py-2">Role</th><th scope="col" className="px-3 py-2">Last directory check</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {accounts.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-slate-700">No directory or break-glass account yet.</td></tr>}
              {accounts.map(a => (
                <tr key={a.userId} className="border-t border-slate-100">
                  <td className="px-3 py-2">{a.name}<div className="text-xs text-slate-700">{a.email}</div></td>
                  <td className="px-3 py-2"><Badge tone={a.kind === 'ldap' ? 'info' : 'warning'}>{a.kind === 'ldap' ? 'Directory' : 'Break-glass'}</Badge>{!a.active && <Badge tone="danger">Deactivated</Badge>}</td>
                  <td className="px-3 py-2">{a.role}</td>
                  <td className="px-3 py-2">{a.syncedAt ? a.syncedAt.slice(0, 16).replace('T', ' ') : '-'}</td>
                  <td className="px-3 py-2 text-right">{canManage && a.kind === 'break-glass' && <Button size="sm" variant="danger" onClick={() => toggleBreakGlass(a, false)}>Remove flag</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canManage && (
          <div className="flex flex-col md:flex-row gap-3 md:items-end">
            <Field label="Flag a local Administrator as break-glass" hint="The account needs an authenticator. It signs in locally only while the directory cannot be reached." className="md:w-96">
              {p => <input {...p} type="email" className={input} placeholder="admin@example.com" value={bgEmail} onChange={e => setBgEmail(e.target.value)} />}
            </Field>
            <div><Button busy={busy} onClick={flagBreakGlass}>Flag as break-glass</Button></div>
          </div>
        )}
      </section>

      {signing && (
        <ElectronicSignatureModal
          user={{ ...user, email: user.email ?? undefined }}
          token={token}
          meaningCode="DIRECTORY_MAPPING"
          action={signing.to === 'Approved' ? 'approve the mapping' : 'retire the mapping'}
          entityName={`${signing.row.groupDn} to ${signing.row.role}`}
          recordVersion={signing.row.version + 1}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
