import { formatDateTime, formatTime } from '../lib/format';
import React, { useState, useEffect } from 'react';
import { Shield, Users, Settings, Lock, AlertCircle, Save, Unlock, Activity, CheckCircle2, XCircle, Bell, UserPlus, KeyRound, Copy, Plug, Power, ShieldOff } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BarChart3 } from 'lucide-react';

type Tab = 'users' | 'settings' | 'integrations' | 'integrity' | 'broadcast' | 'activity';

interface AdminUserRow {
  id: string; uid: string; name: string; email: string | null; role: string; active: boolean;
  mfaEnabled: boolean; mustChangePassword: boolean; locked: boolean; lockedUntil: string | null; version: number;
}

interface AiSettings { provider: string; enabled: boolean; hasApiKey: boolean; model: string; redactIdentifiers: boolean; version: number; updatedAt: string | null; updatedBy: string | null }

const ROLES = ['Admin', 'QA', 'Reviewer', 'Analyst'];

export function AdminPanel({ token, user }: { token: string, user: any }) {
  const [activeTab, setActiveTab] = useState<Tab>('users');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [usersList, setUsersList] = useState<AdminUserRow[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [aiForm, setAiForm] = useState({ enabled: false, apiKey: '', model: '', redactIdentifiers: true });
  const [adminPassword, setAdminPassword] = useState('');
  const [reason, setReason] = useState('');
  const [integrityStatus, setIntegrityStatus] = useState<any>(null);
  const [checkingIntegrity, setCheckingIntegrity] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', email: '', role: 'Analyst' });
  const [issued, setIssued] = useState<{ who: string; password: string } | null>(null);
  const { toast } = useToast();

  /** One place for the Authorization header and for turning a refusal into a message the person can read. */
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The request failed (${res.status}).`);
    return data;
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastMessage.trim()) return toast('Message is required', 'error');
    setIsBroadcasting(true);
    try {
      await call('/api/admin/broadcast', 'POST', { message: broadcastMessage.trim() });
      toast('Alert broadcasted successfully', 'success');
      setBroadcastMessage('');
    } catch (err: any) {
      toast(err.message || 'Failed to broadcast alert', 'error');
    } finally {
      setIsBroadcasting(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchSettings();
    fetchIntegrations();
    checkIntegrity();
  }, []);

  const checkIntegrity = async () => {
    setCheckingIntegrity(true);
    try {
      setIntegrityStatus(await call('/api/audit/verify', 'POST'));
    } catch (e: any) {
      toast(e.message || 'Failed to verify audit trail', 'error');
    } finally {
      setCheckingIntegrity(false);
    }
  };

  const fetchUsers = async () => {
    try { setUsersList(await call('/api/admin/users', 'GET')); } catch (e: any) { toast(e.message || 'Failed to load users', 'error'); }
  };

  const fetchSettings = async () => {
    try { setSettings(await call('/api/admin/settings', 'GET')); } catch (e: any) { toast(e.message || 'Failed to load security policies', 'error'); }
  };

  const fetchIntegrations = async () => {
    try {
      const data = await call('/api/admin/integrations', 'GET');
      setAi(data.ai);
      setAiForm({ enabled: data.ai.enabled, apiKey: '', model: data.ai.model, redactIdentifiers: data.ai.redactIdentifiers });
    } catch (e: any) { toast(e.message || 'Failed to load integrations', 'error'); }
  };

  /** Every change to an account states a reason and is authorised with the administrator's password. */
  const needAuthorisation = (): boolean => {
    if (!adminPassword) { toast('Admin password required to confirm changes', 'error'); return false; }
    if (reason.trim().length < 3) { toast('State the reason for this change (minimum 3 characters)', 'error'); return false; }
    return true;
  };

  const finish = async (message: string) => {
    toast(message, 'success');
    setAdminPassword('');
    setReason('');
    await fetchUsers();
  };

  const changeUser = async (u: AdminUserRow, change: { role?: string; active?: boolean }, success: string) => {
    if (!needAuthorisation()) return;
    try {
      await call(`/api/admin/users/${u.id}`, 'PUT', { ...change, reason: reason.trim(), expectedVersion: u.version, password: adminPassword });
      await finish(success);
    } catch (e: any) {
      toast(e.message, 'error');
      fetchUsers();
    }
  };

  const userAction = async (u: AdminUserRow, action: 'reset-password' | 'unlock' | 'reset-mfa', success: string) => {
    if (!needAuthorisation()) return;
    try {
      const data = await call(`/api/admin/users/${u.id}/${action}`, 'POST', { reason: reason.trim(), expectedVersion: u.version, password: adminPassword });
      if (data.temporaryPassword) setIssued({ who: u.email || u.name, password: data.temporaryPassword });
      await finish(success);
    } catch (e: any) {
      toast(e.message, 'error');
      fetchUsers();
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!needAuthorisation()) return;
    try {
      const data = await call('/api/admin/users', 'POST', { ...newUser, reason: reason.trim(), password: adminPassword });
      setIssued({ who: data.user.email, password: data.temporaryPassword });
      setNewUser({ name: '', email: '', role: 'Analyst' });
      setShowNewUser(false);
      await finish(`User ${data.user.email} created`);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!needAuthorisation()) return;
    try {
      const { id, updatedAt, version, ...policy } = settings;
      await call('/api/admin/settings', 'PUT', { ...policy, reason: reason.trim(), expectedVersion: version, password: adminPassword });
      toast('Security policies updated successfully', 'success');
      setAdminPassword('');
      setReason('');
      fetchSettings();
    } catch (err: any) {
      toast(err.message, 'error');
      fetchSettings();
    }
  };

  const saveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ai || !needAuthorisation()) return;
    try {
      await call('/api/admin/integrations/ai', 'PUT', {
        enabled: aiForm.enabled, redactIdentifiers: aiForm.redactIdentifiers, model: aiForm.model || undefined,
        ...(aiForm.apiKey ? { apiKey: aiForm.apiKey } : {}),
        reason: reason.trim(), expectedVersion: ai.version, password: adminPassword,
      });
      toast(aiForm.enabled ? 'External AI is ON. Requests are recorded in the audit trail.' : 'External AI is OFF. Nothing leaves this computer.', 'success');
      setAdminPassword('');
      setReason('');
      fetchIntegrations();
    } catch (err: any) {
      toast(err.message, 'error');
      fetchIntegrations();
    }
  };

  if (user.role !== 'Admin') {
    return (
      <div className="p-8 text-center text-slate-500">
        <Shield className="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <h2 className="text-xl font-bold text-slate-700">Access Denied</h2>
        <p>You do not have administrative privileges to view this page.</p>
      </div>
    );
  }

  const tabClass = (tab: Tab) => `px-6 py-3 font-semibold text-sm border-b-2 flex items-center gap-2 ${activeTab === tab ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`;

  const authorisationFields = (
    <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-amber-700">
        <AlertCircle className="w-4 h-4" /> Admin authentication and a reason are required to apply changes.
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Reason for the change..."
          className="px-3 py-1.5 border border-slate-300 rounded text-sm w-64 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <input
          type="password"
          placeholder="Enter Admin Password..."
          className="px-3 py-1.5 border border-slate-300 rounded text-sm w-56 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          value={adminPassword}
          onChange={e => setAdminPassword(e.target.value)}
        />
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-8 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <Shield className="w-8 h-8 text-indigo-600" /> System Administration
          </h2>
          <p className="text-slate-500 mt-1">Manage user access and global security policies.</p>
        </div>

        <div className="flex items-center gap-3 bg-white px-4 py-2.5 rounded-xl border border-slate-200 shadow-sm w-fit">
          <div className="text-sm font-bold text-slate-700 flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-slate-500" /> System Health:
          </div>
          {checkingIntegrity ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
              <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div> Scanning...
            </span>
          ) : integrityStatus?.isValid ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5" /> Optimal
            </span>
          ) : integrityStatus ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
              <XCircle className="w-3.5 h-3.5" /> Compromised (Seq #{integrityStatus.compromisedSequence})
            </span>
          ) : (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
              Unknown
            </span>
          )}
        </div>
      </div>

      <div className="flex border-b border-slate-200 mb-6 overflow-x-auto">
        <button className={tabClass('users')} onClick={() => setActiveTab('users')}>
          <Users className="w-4 h-4" /> User Management
        </button>
        <button className={tabClass('settings')} onClick={() => setActiveTab('settings')}>
          <Settings className="w-4 h-4" /> Security Policies
        </button>
        <button className={tabClass('integrations')} onClick={() => setActiveTab('integrations')}>
          <Plug className="w-4 h-4" /> Integrations
        </button>
        <button className={tabClass('integrity')} onClick={() => { setActiveTab('integrity'); checkIntegrity(); }}>
          <Activity className="w-4 h-4" /> System Integrity
        </button>
        <button className={tabClass('broadcast')} onClick={() => setActiveTab('broadcast')}>
          <Bell className="w-4 h-4" /> System Alerts
        </button>
        <button className={tabClass('activity')} onClick={() => setActiveTab('activity')}>
          <BarChart3 className="w-4 h-4" /> Usage Heatmap
        </button>
      </div>

      {issued && (
        <div className="mb-6 bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="font-bold text-amber-900 flex items-center gap-2"><KeyRound className="w-4 h-4" /> Temporary password for {issued.who}</div>
            <div className="font-mono text-lg text-slate-900 mt-1 select-all">{issued.password}</div>
            <p className="text-xs text-amber-800 mt-1">Shown only now. Give it to the user in person; they must change it at the first sign-in. It is not stored in readable form anywhere.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 bg-white border border-amber-300 rounded text-sm font-semibold text-amber-900 flex items-center gap-1.5"
              onClick={() => navigator.clipboard.writeText(issued.password).then(() => toast('Copied', 'success'), () => toast('Could not copy. Select the password and copy it by hand.', 'error'))}
            >
              <Copy className="w-4 h-4" /> Copy
            </button>
            <button type="button" className="px-3 py-1.5 bg-amber-600 text-white rounded text-sm font-semibold" onClick={() => setIssued(null)}>I have handed it over</button>
          </div>
        </div>
      )}

      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-bold text-slate-800">Accounts</h3>
            <button
              type="button"
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-semibold flex items-center gap-1.5"
              onClick={() => setShowNewUser(v => !v)}
            >
              <UserPlus className="w-4 h-4" /> New user
            </button>
          </div>
          {showNewUser && (
            <form onSubmit={createUser} className="p-4 bg-indigo-50 border-b border-indigo-100 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Full name</label>
                <input required className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">E-mail (sign-in name)</label>
                <input required type="email" className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Role</label>
                <select className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm bg-white" value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <button type="submit" className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-semibold">Create with temporary password</button>
            </form>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th>User Name</th>
                  <th>Email / UID</th>
                  <th>Role</th>
                  <th>Account Status</th>
                  <th className="text-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersList.map(u => (
                  <tr key={u.id}>
                    <td className="font-semibold text-slate-800">{u.name}</td>
                    <td>
                      <div className="text-slate-600">{u.email}</div>
                      <div className="text-xs text-slate-400 font-mono">{u.uid}</div>
                    </td>
                    <td>
                      <select
                        className="border border-slate-300 rounded px-2 py-1 text-sm bg-slate-50"
                        value={u.role}
                        disabled={u.id === user.id}
                        title={u.id === user.id ? 'You cannot change your own role' : undefined}
                        onChange={(e) => changeUser(u, { role: e.target.value }, 'User role updated successfully')}
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td className="space-y-1">
                      {!u.active ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700 border border-slate-300">
                          <Power className="w-3.5 h-3.5" /> Deactivated
                        </span>
                      ) : u.locked ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
                          <Lock className="w-3.5 h-3.5" /> Locked{u.lockedUntil ? ` until ${formatTime(u.lockedUntil)}` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                          <Unlock className="w-3.5 h-3.5" /> Active
                        </span>
                      )}
                      <div className="text-xs text-slate-500 flex gap-2">
                        <span>{u.mfaEnabled ? 'MFA on' : 'MFA off'}</span>
                        {u.mustChangePassword && <span className="text-amber-700">Password change pending</span>}
                      </div>
                    </td>
                    <td className="text-end space-x-1 whitespace-nowrap">
                      {u.locked && (
                        <button onClick={() => userAction(u, 'unlock', 'Account unlocked')} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-3 py-1.5 rounded">
                          Unlock
                        </button>
                      )}
                      <button onClick={() => userAction(u, 'reset-password', 'Temporary password issued')} className="text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 px-3 py-1.5 rounded">
                        Reset password
                      </button>
                      {u.mfaEnabled && (
                        <button onClick={() => userAction(u, 'reset-mfa', 'Multi-factor authentication reset')} className="text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 px-3 py-1.5 rounded inline-flex items-center gap-1">
                          <ShieldOff className="w-3 h-3" /> Reset MFA
                        </button>
                      )}
                      {u.id !== user.id && (
                        <button
                          onClick={() => changeUser(u, { active: !u.active }, u.active ? 'Account deactivated' : 'Account reactivated')}
                          className={`text-xs font-semibold px-3 py-1.5 rounded ${u.active ? 'text-red-700 bg-red-50 hover:bg-red-100' : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'}`}
                        >
                          {u.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {authorisationFields}
        </div>
      )}

      {activeTab === 'broadcast' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 max-w-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
              <Bell className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-800">System-Wide Alert</h3>
              <p className="text-sm text-slate-500">Send an immediate real-time alert to all connected users.</p>
            </div>
          </div>
          <form onSubmit={handleBroadcast} className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Alert Message</label>
              <textarea
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 h-24 resize-none"
                placeholder="E.g., System maintenance scheduled in 15 minutes. Please save your work."
                maxLength={500}
                value={broadcastMessage}
                onChange={e => setBroadcastMessage(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={isBroadcasting || !broadcastMessage.trim()}
              className="px-6 py-2 bg-amber-500 text-white font-bold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isBroadcasting ? <Activity className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
              Broadcast Now
            </button>
          </form>
        </div>
      )}

      {activeTab === 'settings' && settings && (
        <form onSubmit={saveSettings} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 max-w-2xl">

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Session Timeout (Minutes)</label>
              <p className="text-xs text-slate-500 mb-2">A session that has been idle this long is locked; the user re-enters their password to continue.</p>
              <input
                type="number"
                min="5"
                max="120"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                value={settings.sessionTimeoutMinutes}
                onChange={e => setSettings({...settings, sessionTimeoutMinutes: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Maximum Session Length (Hours)</label>
              <p className="text-xs text-slate-500 mb-2">A hard limit that activity and re-entering the password do not extend (1 to 12).</p>
              <input
                type="number"
                min="1"
                max="12"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                value={settings.sessionAbsoluteHours}
                onChange={e => setSettings({...settings, sessionAbsoluteHours: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Max Failed Login Attempts</label>
              <p className="text-xs text-slate-500 mb-2">Consecutive failed sign-ins before the account is locked. Signing with the wrong password locks signing only, after 3 attempts.</p>
              <input
                type="number"
                min="1"
                max="10"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                value={settings.maxFailedLogins}
                onChange={e => setSettings({...settings, maxFailedLogins: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Lock Duration (Minutes)</label>
              <p className="text-xs text-slate-500 mb-2">How long a sign-in lock or a signing lock lasts. It ends by itself; an Administrator can also unlock sooner.</p>
              <input
                type="number"
                min="1"
                max="1440"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                value={settings.lockoutMinutes}
                onChange={e => setSettings({...settings, lockoutMinutes: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Password Expiry (Days)</label>
              <p className="text-xs text-slate-500 mb-2">Force users to change their password periodically.</p>
              <input
                type="number"
                min="14"
                max="365"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                value={settings.passwordExpiryDays}
                onChange={e => setSettings({...settings, passwordExpiryDays: parseInt(e.target.value)})}
              />
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="mfaRequired"
                className="w-4 h-4 text-indigo-600 rounded border-slate-300"
                checked={settings.mfaRequired ?? false}
                onChange={e => setSettings({...settings, mfaRequired: e.target.checked})}
              />
              <label htmlFor="mfaRequired" className="text-sm font-medium text-slate-700">Require multi-factor authentication (authenticator app) for every user</label>
            </div>

            <div className="pt-6 border-t border-slate-200">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Password Complexity</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Minimum Password Length</label>
                  <input
                    type="number"
                    min="8"
                    max="64"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                    value={settings.minPasswordLength || 8}
                    onChange={e => setSettings({...settings, minPasswordLength: parseInt(e.target.value)})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Password History</label>
                  <p className="text-xs text-slate-500 mb-2">A new password may not equal one of the last N passwords (0 switches the history off; the current password can never be reused).</p>
                  <input
                    type="number"
                    min="0"
                    max="24"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                    value={settings.passwordHistoryCount}
                    onChange={e => setSettings({...settings, passwordHistoryCount: parseInt(e.target.value)})}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="requireUppercase"
                    className="w-4 h-4 text-indigo-600 rounded border-slate-300"
                    checked={settings.requireUppercase ?? true}
                    onChange={e => setSettings({...settings, requireUppercase: e.target.checked})}
                  />
                  <label htmlFor="requireUppercase" className="text-sm font-medium text-slate-700">Require at least one uppercase letter (A-Z)</label>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="requireNumbers"
                    className="w-4 h-4 text-indigo-600 rounded border-slate-300"
                    checked={settings.requireNumbers ?? true}
                    onChange={e => setSettings({...settings, requireNumbers: e.target.checked})}
                  />
                  <label htmlFor="requireNumbers" className="text-sm font-medium text-slate-700">Require at least one number (0-9)</label>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="requireSymbols"
                    className="w-4 h-4 text-indigo-600 rounded border-slate-300"
                    checked={settings.requireSymbols ?? true}
                    onChange={e => setSettings({...settings, requireSymbols: e.target.checked})}
                  />
                  <label htmlFor="requireSymbols" className="text-sm font-medium text-slate-700">Require at least one special character (!@#$%)</label>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-slate-200 space-y-3">
              <label className="block text-sm font-bold text-slate-700">Authorize Changes</label>
              <input
                type="text"
                required
                minLength={3}
                placeholder="Reason for the change..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
              <input
                type="password"
                required
                placeholder="Enter your password to authorize..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                value={adminPassword}
                onChange={e => setAdminPassword(e.target.value)}
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg transition-colors"
              >
                <Save className="w-4 h-4" /> Save Policies
              </button>
            </div>

          </div>
        </form>
      )}

      {activeTab === 'integrations' && ai && (
        <form onSubmit={saveAi} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 max-w-2xl space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-slate-800">External AI assistance</h3>
              <p className="text-sm text-slate-500 mt-1">
                Voice transcription, OOS root-cause and CAPA drafts and protocol drafts are produced by a service outside this computer ({ai.provider}).
                While this is OFF nothing is sent anywhere and these functions answer that AI is disabled.
              </p>
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-bold border ${ai.enabled ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-emerald-100 text-emerald-800 border-emerald-200'}`}>
              {ai.enabled ? 'ON' : 'OFF'}
            </span>
          </div>

          <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-600 space-y-1">
            <p>When ON: every request is recorded in the audit trail (EXTERNAL_CALL) before it is sent, audio and prompts leave this computer, and every answer is labelled <strong>AI draft - not a GxP record</strong>. Nothing generated is saved without a person reading, editing and signing it.</p>
            {ai.updatedAt && <p>Last changed {formatDateTime(ai.updatedAt)}.</p>}
          </div>

          <div className="flex items-center gap-3">
            <input type="checkbox" id="aiEnabled" className="w-4 h-4 text-indigo-600 rounded border-slate-300" checked={aiForm.enabled} onChange={e => setAiForm({ ...aiForm, enabled: e.target.checked })} />
            <label htmlFor="aiEnabled" className="text-sm font-medium text-slate-700">Allow external AI assistance</label>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 mb-1">API key</label>
            <p className="text-xs text-slate-500 mb-2">{ai.hasApiKey ? 'A key is stored (encrypted). Leave empty to keep it, or type a new one to replace it.' : 'No key is stored. Enter one to enable AI.'} The key is never shown again.</p>
            <input type="password" autoComplete="off" className="w-full px-3 py-2 border border-slate-300 rounded-lg" value={aiForm.apiKey} onChange={e => setAiForm({ ...aiForm, apiKey: e.target.value })} />
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 mb-1">Model</label>
            <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg" value={aiForm.model} onChange={e => setAiForm({ ...aiForm, model: e.target.value })} />
          </div>

          <div className="flex items-center gap-3">
            <input type="checkbox" id="aiRedact" className="w-4 h-4 text-indigo-600 rounded border-slate-300" checked={aiForm.redactIdentifiers} onChange={e => setAiForm({ ...aiForm, redactIdentifiers: e.target.checked })} />
            <label htmlFor="aiRedact" className="text-sm font-medium text-slate-700">Remove sample and result identifiers from what is sent (recommended)</label>
          </div>

          <div className="pt-4 border-t border-slate-200 space-y-3">
            <label className="block text-sm font-bold text-slate-700">Authorize Changes</label>
            <input type="text" required minLength={3} placeholder="Reason for the change..." className="w-full px-3 py-2 border border-slate-300 rounded-lg" value={reason} onChange={e => setReason(e.target.value)} />
            <input type="password" required placeholder="Enter your password to authorize..." className="w-full px-3 py-2 border border-slate-300 rounded-lg" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} />
          </div>

          <div className="flex justify-end">
            <button type="submit" className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg transition-colors">
              <Save className="w-4 h-4" /> Save
            </button>
          </div>
        </form>
      )}

      {activeTab === 'activity' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <div className="mb-6">
            <h3 className="text-lg font-bold text-slate-800">Peak Laboratory Usage Times</h3>
            <p className="text-sm text-slate-500 mt-1">
              Identify high-traffic periods across departments based on cryptographically-signed audit trail events.
              Helps in resource allocation and server capacity planning.
            </p>
          </div>
          <ActivityHeatmap token={token} />
        </div>
      )}

      {activeTab === 'integrity' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 max-w-2xl">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Audit Trail Integrity</h3>
              <p className="text-sm text-slate-500">Cryptographically verifies the blockchain-like hash chain of all system records.</p>
            </div>
            <button
              onClick={checkIntegrity}
              disabled={checkingIntegrity}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-lg text-sm transition-colors flex items-center gap-2"
            >
              <Activity className={`w-4 h-4 ${checkingIntegrity ? 'animate-pulse' : ''}`} />
              {checkingIntegrity ? 'Verifying...' : 'Run Verification'}
            </button>
          </div>

          <div className="p-6 rounded-xl border flex flex-col items-center justify-center text-center bg-slate-50 border-slate-200">
            {checkingIntegrity ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                <p className="font-semibold text-slate-700">Recalculating cryptographic hashes...</p>
              </div>
            ) : integrityStatus ? (
              integrityStatus.isValid ? (
                <div className="flex flex-col items-center gap-3">
                  <CheckCircle2 className="w-16 h-16 text-emerald-500" />
                  <h4 className="text-xl font-bold text-slate-800">System Integrity Verified</h4>
                  <p className="text-sm text-slate-600">All audit trail records are cryptographically secure. No data tampering detected.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <XCircle className="w-16 h-16 text-red-500" />
                  <h4 className="text-xl font-bold text-red-700">Integrity Violation Detected!</h4>
                  <p className="text-sm text-red-600">The cryptographic hash chain is broken at sequence <strong>#{integrityStatus.compromisedSequence}</strong>.</p>
                  <div className="mt-2 text-xs bg-red-100 text-red-800 px-3 py-2 rounded">
                    Immediate QA investigation required (21 CFR Part 11 violation).
                  </div>
                </div>
              )
            ) : (
              <p className="text-slate-500">Click "Run Verification" to scan the audit logs.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
