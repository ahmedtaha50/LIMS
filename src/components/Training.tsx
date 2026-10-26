// Training matrix (roadmap M05 certification, M28 curricula, assignments and qualification; r2-docs-training).
// The server decides everything (src/server/routes/training.ts): who is assigned what, what is Overdue, who is qualified for which
// method, and the software-trained flag, which only the LIMS curriculum sets. This screen shows that and offers the signed steps:
// read and understood to the trainee, on-the-job certification to a trainer who is not the trainee. Every failure is a toast.
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, GraduationCap, ShieldAlert } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

export interface AssignmentRow {
  id: string; userId: string; userName: string; curriculumId: string; curriculumTitle: string; documentId: string | null; documentVersionId: string | null;
  documentTitle: string | null; revision: number | null; trainingMethod: 'READ_AND_UNDERSTOOD' | 'OJT' | string; dueDate: string; status: string; overdue: boolean;
  completedAt: string | null; completedBy: string | null; trainerId: string | null; version: number;
}
export interface QualificationRow { methodCode: string; status: 'Qualified' | 'NotQualified' | 'Override' | string; overdue: string[]; overrideId: string | null; overrideUntil: string | null }
interface CurriculumRow {
  id: string; code: string; title: string; methodCode: string | null; roles: string[]; mandatory: boolean; dueDays: number; trainingMethod: string;
  isSoftware: boolean; version: number; documents: Array<{ id: string; code: string; title: string }>;
}
interface MatrixUser { id: string; name: string; role: string; hasCompletedSoftwareTraining: boolean }

const METHOD_LABEL: Record<string, string> = { READ_AND_UNDERSTOOD: 'Read and understood', OJT: 'On-the-job' };
const OPEN = ['Assigned', 'Overdue'];
const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-50';
const primary = 'px-3 py-1 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 transition-colors';

/** Assignments with their due dates; an open one past its due date is flagged Overdue. Signed steps only for whom the server allows. */
export function AssignmentTable({ assignments, me, canCertify, onAcknowledge, onCertify }: {
  assignments: readonly AssignmentRow[]; me: string; canCertify: boolean; onAcknowledge: (a: AssignmentRow) => void; onCertify: (a: AssignmentRow) => void;
}) {
  if (assignments.length === 0) return <p className="text-sm text-slate-500 p-4">No training assigned.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Trainee</th><th className="p-2">Curriculum</th><th className="p-2">Document</th><th className="p-2">Method</th><th className="p-2">Due</th><th className="p-2">Status</th><th className="p-2" /></tr>
      </thead>
      <tbody>
        {assignments.map(a => {
          const open = OPEN.includes(a.status);
          return (
            <tr key={a.id} className="border-t border-slate-100">
              <td className="p-2">{a.userName}</td>
              <td className="p-2">{a.curriculumTitle}</td>
              <td className="p-2">{a.documentTitle ? `${a.documentTitle} rev ${a.revision}` : ''}</td>
              <td className="p-2">{METHOD_LABEL[a.trainingMethod] ?? a.trainingMethod}</td>
              <td className="p-2">{a.dueDate}{a.overdue && <span className="ms-2 px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-700" aria-label="overdue">Overdue</span>}</td>
              <td className="p-2">{a.status === 'Overdue' ? 'Assigned' : a.status}{a.completedAt ? ` ${a.completedAt.slice(0, 10)}` : ''}</td>
              <td className="p-2 text-end">
                {open && a.trainingMethod === 'READ_AND_UNDERSTOOD' && a.userId === me && <button type="button" className={primary} onClick={() => onAcknowledge(a)}>Sign read and understood</button>}
                {open && a.trainingMethod === 'OJT' && canCertify && a.userId !== me && <button type="button" className={primary} onClick={() => onCertify(a)}>Certify OJT</button>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Per method: qualified, not qualified (overdue training), or allowed by a QA override until its end date. */
export function QualificationTable({ rows }: { rows: readonly QualificationRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">No method is gated by a mandatory curriculum.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Method</th><th className="p-2">Qualification</th></tr></thead>
      <tbody>
        {rows.map(q => (
          <tr key={q.methodCode} className="border-t border-slate-100">
            <td className="p-2 font-mono">{q.methodCode}</td>
            <td className="p-2">
              {q.status === 'Qualified' && <span className="text-emerald-700 font-semibold">Qualified</span>}
              {q.status === 'NotQualified' && <span className="text-red-700 font-semibold">Not qualified ({q.overdue.length} overdue)</span>}
              {q.status === 'Override' && <span className="text-amber-800 font-semibold">QA override until {q.overrideUntil}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type OverrideDraft = { userId: string; methodCode: string; validUntil: string };
type Signing = { kind: 'certify'; user: MatrixUser } | { kind: 'acknowledge' | 'ojt'; assignment: AssignmentRow } | { kind: 'override'; draft: OverrideDraft };

export function Training({ token, user }: { token: string; user: any }) {
  const [users, setUsers] = useState<MatrixUser[]>([]);
  const [curricula, setCurricula] = useState<CurriculumRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [qualifications, setQualifications] = useState<QualificationRow[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [filterMine, setFilterMine] = useState(false);
  const [override, setOverride] = useState<OverrideDraft | null>(null);
  const [newCurriculum, setNewCurriculum] = useState<{ code: string; title: string; methodCode: string; trainingMethod: string; dueDays: string; roles: string; documentIds: string } | null>(null);
  const { toast } = useToast();
  const me = user?.id ?? '';
  const canCertify = permissions.includes('training.certify');
  const canManage = permissions.includes('training.manage');
  const canOverride = permissions.includes('training.override');
  const lims = curricula.find(c => c.isSoftware);

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);
  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ users: MatrixUser[]; curricula: CurriculumRow[]; assignments: AssignmentRow[] }>('/training');
      setUsers(data.users ?? []);
      setCurricula(data.curricula ?? []);
      setAssignments(data.assignments ?? []);
      setQualifications(await apiFetch<QualificationRow[]>(`/training/qualifications?userId=${encodeURIComponent(me)}`));
    } catch (err) { fail(err, 'The training matrix could not be loaded.'); }
    setLoading(false);
  }, [fail, me]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
  }, [fail]);

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, ...(totpCode ? { totpCode } : {}) };
    if (signing.kind === 'certify') {
      const r = await apiFetch<{ hasCompletedSoftwareTraining: boolean }>(`/training/${signing.user.id}/certify`, { body: { moduleName: lims?.title ?? 'LIMS Core Software', ...cred } });
      setSigning(null);
      await load();
      if (r.hasCompletedSoftwareTraining) toast.success(`${signing.user.name} certified (audit logged)`);
      else toast.error(`${signing.user.name}: certification recorded, but signing stays disabled while LIMS training is overdue.`);
      return;
    }
    if (signing.kind === 'override') {
      const d = signing.draft;
      // The reason is the signature's own (QUALIFICATION_OVERRIDE requires one): the dialog asks for it.
      await apiFetch('/training/qualifications/override', { body: { ...d, reason: reason ?? '', ...cred } });
      setSigning(null);
      setOverride(null);
      await load();
      toast.success(`Qualification override for ${d.methodCode} signed, valid until ${d.validUntil} (audit logged)`);
      return;
    }
    const a = signing.assignment;
    await apiFetch(`/training/assignments/${a.id}/${signing.kind === 'ojt' ? 'certify' : 'acknowledge'}`, { body: { ...cred, expectedVersion: a.version, ...(reason ? { reason } : {}) } });
    setSigning(null);
    await load();
    toast.success(`${a.curriculumTitle}: training of ${a.userName} completed (audit logged)`);
  };

  const createCurriculum = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCurriculum) return;
    const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      code: newCurriculum.code, title: newCurriculum.title, trainingMethod: newCurriculum.trainingMethod, dueDays: Number(newCurriculum.dueDays || 30),
      roles: list(newCurriculum.roles), documentIds: list(newCurriculum.documentIds),
    };
    if (newCurriculum.methodCode.trim()) body.methodCode = newCurriculum.methodCode.trim();
    try {
      await apiFetch('/training/curricula', { body });
      toast.success(`Curriculum ${newCurriculum.code} defined; training assigned (audit logged)`);
      setNewCurriculum(null);
      await load();
    } catch (err) { fail(err, 'The curriculum could not be defined.'); }
  };

  const shown = filterMine ? assignments.filter(a => a.userId === me) : assignments;
  const meaningCode = !signing ? undefined
    : signing.kind === 'acknowledge' ? 'TRAINING_ACKNOWLEDGEMENT' : signing.kind === 'override' ? 'QUALIFICATION_OVERRIDE' : 'TRAINING_CERTIFICATION';
  const askOverride = (e: React.FormEvent) => {
    e.preventDefault();
    if (!override) return;
    if (!override.userId || !override.methodCode.trim() || !override.validUntil) { toast.error('Choose the analyst, the method and the last day of the override.'); return; }
    setSigning({ kind: 'override', draft: { ...override, methodCode: override.methodCode.trim() } });
  };

  return (
    <div className="p-6 space-y-8">
      <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
        <GraduationCap className="w-6 h-6 text-blue-600" /> Training Matrix & Qualification
      </h2>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-4">
        <ShieldAlert className="w-6 h-6 text-amber-600 shrink-0" />
        <div className="text-sm text-amber-800">
          <h4 className="font-semibold text-amber-900">GxP Compliance Notice (21 CFR Part 11)</h4>
          Electronic signatures are disabled for users who have not completed the <strong>{lims?.title ?? 'LIMS Core Software'}</strong> curriculum, or whose
          training in it is overdue. Certifying any other module records the training only. Signing one's own training as read and understood is always possible.
          Results of a method are entered only by analysts qualified for it (no overdue mandatory training), unless QA has signed an override.
        </div>
      </div>

      <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden" aria-label="Software training">
        <h3 className="px-6 pt-4 font-semibold text-slate-700">LIMS software training</h3>
        {loading ? <p className="p-6 text-sm text-slate-500">Loading...</p> : (
          <table className="w-full text-start">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr><th className="px-6 py-3 font-semibold text-slate-600">Name</th><th className="px-6 py-3 font-semibold text-slate-600">Role</th><th className="px-6 py-3 font-semibold text-slate-600">Signing enabled</th><th className="px-6 py-3" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map(u => (
                <tr key={u.id}>
                  <td className="px-6 py-3 font-medium">{u.name}</td>
                  <td className="px-6 py-3">{u.role}</td>
                  <td className="px-6 py-3">
                    {u.hasCompletedSoftwareTraining
                      ? <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-1 rounded text-xs font-bold border border-emerald-200"><CheckCircle className="w-3 h-3" /> TRAINED</span>
                      : <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-1 rounded text-xs font-bold border border-red-200">NOT TRAINED</span>}
                  </td>
                  <td className="px-6 py-3">
                    {!u.hasCompletedSoftwareTraining && canCertify && u.id !== me && (
                      <button type="button" onClick={() => setSigning({ kind: 'certify', user: u })} className={primary}>Certify {lims?.code ?? 'LIMS'} training</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="bg-white rounded-xl shadow-sm border border-slate-200" aria-label="Assignments">
        <div className="px-6 pt-4 flex items-center justify-between">
          <h3 className="font-semibold text-slate-700">Training assignments</h3>
          <label className="text-sm text-slate-600 flex items-center gap-2"><input type="checkbox" checked={filterMine} onChange={e => setFilterMine(e.target.checked)} /> Mine only</label>
        </div>
        <AssignmentTable assignments={shown} me={me} canCertify={canCertify}
          onAcknowledge={a => setSigning({ kind: 'acknowledge', assignment: a })} onCertify={a => setSigning({ kind: 'ojt', assignment: a })} />
      </section>

      <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-6" aria-label="My qualifications">
        <h3 className="font-semibold text-slate-700 mb-2">My method qualifications</h3>
        <QualificationTable rows={qualifications} />
      </section>

      {canOverride && (
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-3" aria-label="Qualification override">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-700">QA qualification override</h3>
            {!override && <button type="button" className={button} onClick={() => setOverride({ userId: '', methodCode: '', validUntil: '' })}>New override</button>}
          </div>
          <p className="text-xs text-slate-500">Lets one analyst enter results of one method while mandatory training is overdue, for at most 30 days. Signed with a reason; every result entered under it is flagged in the audit trail.</p>
          {override && (
            <form onSubmit={askOverride} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
              <label className="text-xs text-slate-600">Analyst
                <select className={`${input} w-full`} value={override.userId} onChange={e => setOverride({ ...override, userId: e.target.value })} required>
                  <option value="">Choose...</option>
                  {users.filter(u => u.id !== me).map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-600">Method code<input className={`${input} w-full`} value={override.methodCode} onChange={e => setOverride({ ...override, methodCode: e.target.value })} required /></label>
              <label className="text-xs text-slate-600">Valid until (inclusive)<input type="date" className={`${input} w-full`} value={override.validUntil} onChange={e => setOverride({ ...override, validUntil: e.target.value })} required /></label>
              <div className="flex gap-2"><button type="submit" className={primary}>Sign override</button><button type="button" className={button} onClick={() => setOverride(null)}>Cancel</button></div>
            </form>
          )}
        </section>
      )}

      <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-3" aria-label="Curricula">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-700">Curricula</h3>
          {canManage && !newCurriculum && <button type="button" className={button} onClick={() => setNewCurriculum({ code: '', title: '', methodCode: '', trainingMethod: 'READ_AND_UNDERSTOOD', dueDays: '30', roles: '', documentIds: '' })}>New curriculum</button>}
        </div>
        {newCurriculum && (
          <form onSubmit={createCurriculum} className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <label className="text-xs text-slate-600">Code<input className={`${input} w-full`} value={newCurriculum.code} onChange={e => setNewCurriculum({ ...newCurriculum, code: e.target.value })} required /></label>
            <label className="text-xs text-slate-600">Title<input className={`${input} w-full`} value={newCurriculum.title} onChange={e => setNewCurriculum({ ...newCurriculum, title: e.target.value })} required /></label>
            <label className="text-xs text-slate-600">Method code (gates result entry)<input className={`${input} w-full`} value={newCurriculum.methodCode} onChange={e => setNewCurriculum({ ...newCurriculum, methodCode: e.target.value })} /></label>
            <label className="text-xs text-slate-600">Training method
              <select className={`${input} w-full`} value={newCurriculum.trainingMethod} onChange={e => setNewCurriculum({ ...newCurriculum, trainingMethod: e.target.value })}>
                <option value="READ_AND_UNDERSTOOD">Read and understood</option><option value="OJT">On-the-job</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">Due within (days)<input type="number" min={0} max={365} className={`${input} w-full`} value={newCurriculum.dueDays} onChange={e => setNewCurriculum({ ...newCurriculum, dueDays: e.target.value })} /></label>
            <label className="text-xs text-slate-600">Roles (comma separated, empty = all)<input className={`${input} w-full`} value={newCurriculum.roles} onChange={e => setNewCurriculum({ ...newCurriculum, roles: e.target.value })} /></label>
            <label className="text-xs text-slate-600 md:col-span-3">Document ids (comma separated)<input className={`${input} w-full`} value={newCurriculum.documentIds} onChange={e => setNewCurriculum({ ...newCurriculum, documentIds: e.target.value })} /></label>
            <div className="md:col-span-3 flex gap-2"><button type="submit" className={primary}>Define curriculum</button><button type="button" className={button} onClick={() => setNewCurriculum(null)}>Cancel</button></div>
          </form>
        )}
        <ul className="text-sm text-slate-700 space-y-1">
          {curricula.map(c => (
            <li key={c.id}>
              <span className="font-mono">{c.code}</span> {c.title}{c.isSoftware ? ' (LIMS software: enables signing)' : ''}
              {' - '}{METHOD_LABEL[c.trainingMethod] ?? c.trainingMethod}, due within {c.dueDays} days{c.methodCode ? `, gates method ${c.methodCode}` : ''}
              {c.roles.length ? `, roles ${c.roles.join(', ')}` : ', all roles'}{c.documents.length ? `, documents ${c.documents.map(d => d.code).join(', ')}` : ''}
            </li>
          ))}
        </ul>
      </section>

      {signing && (
        <ElectronicSignatureModal
          user={user} token={token} meaningCode={meaningCode}
          action={signing.kind === 'acknowledge' ? 'Training read and understood' : signing.kind === 'override' ? 'Qualification override' : 'Training certification'}
          entityName={signing.kind === 'certify' ? `${signing.user.name}: ${lims?.title ?? 'LIMS Core Software'}`
            : signing.kind === 'override' ? `${users.find(u => u.id === signing.draft.userId)?.name ?? signing.draft.userId}: method ${signing.draft.methodCode} until ${signing.draft.validUntil}`
            : `${signing.assignment.userName}: ${signing.assignment.curriculumTitle}`}
          onClose={() => setSigning(null)} onSign={(password, reason, totpCode) => sign(password, reason, totpCode)}
        />
      )}
    </div>
  );
}
