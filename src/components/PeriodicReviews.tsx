// Periodic review, retention and archive screen (roadmap M42, r3-periodic-archive). Four parts: the reviews that are due or open, the plans,
// retention policies and legal holds, and the batch archive bundles. QA signs (PERIODIC_REVIEW, RETENTION_POLICY, LEGAL_HOLD, ARCHIVE_DECISION)
// with an e-signature bound to the record version; the server decides everything again, this screen only offers the calls. Every refusal is
// shown (toast.error), none is swallowed. Nothing on this screen deletes a record: archiving makes records read-only, retention only flags.
import React, { useCallback, useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission, type PermissionCode } from '../lib/permissions';

export interface DueItem { id: string; kind: string; subjectId: string; title: string; dueDate: string; opened: boolean; daysRemaining: number; overdue: boolean }
export interface DueReviews { today: string; horizonDays: number; overdue: number; items: DueItem[] }
interface Plan { id: string; kind: string; subjectId: string; title: string; intervalMonths: number; nextDueDate: string; checklist: string[]; status: string; version: number }
interface ReviewRow { id: string; kind: string; title: string; dueDate: string; status: string; conclusion: string | null; version: number }
interface ReviewDetail { review: ReviewRow & { evidence: Record<string, any>; evidenceSha256: string; checklist: Array<{ item: string; answer: string; comment?: string }>; findings: Array<{ text: string; severity: string }>; summary: string | null }; plan: Plan }
interface Policy { recordClass: string; title: string; retentionYears: number | null; indefinite: boolean; basis: string | null; version: number }
interface Hold { id: string; recordClass: string; scopeRef: string | null; reason: string; status: string; version: number }
interface Bundle { id: string; subjectLabel: string; status: string; fileCount: number; manifestSha256: string; builtAt: string; lastVerifiedAt: string | null; lastVerifiedOk: boolean | null; version: number }

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '-');
const KINDS = ['user_access', 'instrument', 'specification', 'method', 'document', 'module', 'system'];

/** The due list as a table. Pure, so the dashboard card and the tests can render it. */
export function DueReviewsTable({ data, onOpen }: { data: DueReviews | null; onOpen?: (item: DueItem) => void }) {
  if (!data) return <p className="text-sm text-slate-700">Loading...</p>;
  if (data.items.length === 0) return <p className="text-sm text-slate-700">No periodic review is due within {data.horizonDays} days.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Periodic reviews that are due or overdue</caption>
      <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-3 py-2">Review</th><th scope="col" className="px-3 py-2">Due</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {data.items.map(i => (
          <tr key={i.id} className="border-t border-slate-100">
            <td className="px-3 py-2"><div className="font-medium text-slate-900">{i.title}</div><div className="text-xs text-slate-700">{i.kind.replace('_', ' ')}{i.subjectId !== '*' ? ` ${i.subjectId}` : ''}</div></td>
            <td className="px-3 py-2">{i.dueDate}</td>
            <td className="px-3 py-2"><Badge tone={i.overdue ? 'danger' : i.daysRemaining <= 7 ? 'warning' : 'neutral'}>{i.overdue ? `Overdue by ${-i.daysRemaining} day(s)` : `Due in ${i.daysRemaining} day(s)`}</Badge></td>
            <td className="px-3 py-2 text-right">{onOpen && <Button size="sm" onClick={() => onOpen(i)}>{i.opened ? 'Review' : 'Open review'}</Button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A card for the QA dashboard: the reviews due within 30 days or overdue (GET /periodic-reviews/due, also in GET /dashboard). */
export function DueReviewsCard({ data }: { data: DueReviews | null | undefined }) {
  return (
    <section aria-labelledby="due-reviews-title" className="bg-white border border-slate-200 rounded-xl p-4">
      <h2 id="due-reviews-title" className="font-semibold text-slate-800 mb-2">Periodic reviews {data && data.overdue > 0 && <Badge tone="danger">{data.overdue} overdue</Badge>}</h2>
      <DueReviewsTable data={data ?? null} />
    </section>
  );
}

type Part = 'reviews' | 'plans' | 'retention' | 'archive';
interface Signing { meaningCode: string; action: string; entityName: string; recordVersion: number; run: (password: string, reason?: string, totpCode?: string) => Promise<void> }

export function PeriodicReviews({ token, user }: { token: string; user: SelfUser }) {
  const { toast } = useToast();
  const [part, setPart] = useState<Part>('reviews');
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [due, setDue] = useState<DueReviews | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [answers, setAnswers] = useState<Record<string, { answer: string; comment: string }>>({});
  const [findings, setFindings] = useState<Array<{ text: string; severity: string }>>([]);
  const [conclusion, setConclusion] = useState('Satisfactory');
  const [summary, setSummary] = useState('');
  const [signing, setSigning] = useState<Signing | null>(null);
  const [newPlan, setNewPlan] = useState({ kind: 'user_access', subjectId: '*', title: '', intervalMonths: 12, firstDueDate: '' });
  const [batchId, setBatchId] = useState('');
  const [holdClass, setHoldClass] = useState('');
  const [editing, setEditing] = useState<{ recordClass: string; years: string; basis: string } | null>(null);

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);
  const can = (code: string) => hasPermission(permissions, code as PermissionCode);

  const refresh = useCallback(async () => {
    try {
      const [d, r, p, pol, h, b] = await Promise.all([
        apiFetch<DueReviews>('/periodic-reviews/due'), apiFetch<ReviewRow[]>('/periodic-reviews'), apiFetch<Plan[]>('/periodic-reviews/plans'),
        apiFetch<Policy[]>('/retention/policies'), apiFetch<Hold[]>('/retention/holds'), apiFetch<Bundle[]>('/archive/bundles'),
      ]);
      setDue(d); setReviews(r); setPlans(p); setPolicies(pol); setHolds(h); setBundles(b);
    } catch (err) { fail(err, 'The periodic review data could not be loaded.'); }
  }, [fail]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions))
      .catch(e => { setPermissions([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);

  const load = async (id: string) => {
    try {
      const d = await apiFetch<ReviewDetail>(`/periodic-reviews/${encodeURIComponent(id)}`);
      setDetail(d);
      setAnswers(Object.fromEntries(d.plan.checklist.map(item => { const a = d.review.checklist.find(x => x.item === item); return [item, { answer: a?.answer ?? 'Yes', comment: a?.comment ?? '' }]; })));
      setFindings(d.review.findings);
      setSummary(d.review.summary ?? '');
      setConclusion(d.review.conclusion ?? 'Satisfactory');
    } catch (err) { fail(err, 'The review could not be loaded.'); }
  };
  const openItem = async (item: DueItem) => {
    try {
      if (item.opened) return await load(item.id);
      const created = await apiFetch<{ id: string }>(`/periodic-reviews/plans/${encodeURIComponent(item.id)}/open`, { method: 'POST', body: {} });
      toast.success('Review opened; the evidence was recorded.');
      await refresh();
      await load(created.id);
    } catch (err) { fail(err, 'The review could not be opened.'); }
  };
  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); toast.success(label); await refresh(); } catch (err) { fail(err, `${label} failed.`); }
  };

  const checklistBody = () => (Object.entries(answers) as Array<[string, { answer: string; comment: string }]>).map(([item, a]) => ({ item, answer: a.answer, ...(a.comment.trim() ? { comment: a.comment.trim() } : {}) }));
  const signReview = () => {
    if (!detail) return;
    if (summary.trim().length < 5) { toast.error('Write the summary of the review before you sign.'); return; }
    setSigning({
      meaningCode: 'PERIODIC_REVIEW', action: `conclude ${conclusion}`, entityName: detail.review.title, recordVersion: detail.review.version + 1,
      run: async (password, reason, totpCode) => {
        await apiFetch(`/periodic-reviews/${encodeURIComponent(detail.review.id)}/complete`, {
          replay: 'never',
          body: { conclusion, summary: summary.trim(), checklist: checklistBody(), findings, expectedVersion: detail.review.version, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) },
        });
        toast.success('Review concluded and signed (audit logged).');
        setDetail(null); await refresh();
      },
    });
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => { if (signing) { await signing.run(password, reason, totpCode); setSigning(null); } };
  const canManage = can('periodic.manage');
  const tab = (p: Part, label: string) => (
    <button type="button" role="tab" aria-selected={part === p} onClick={() => setPart(p)} className={`px-4 py-2 text-sm font-medium border-b-2 ${part === p ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-700 hover:text-slate-900'}`}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><Archive className="w-5 h-5" aria-hidden="true" /> Periodic review and archive</h1>
      <p className="text-sm text-slate-700">
        Scheduled reviews of user access, instruments, specifications, methods, documents, qualified modules and the whole system, each concluded by QA with an
        e-signature. Archiving a finished batch makes its records read-only and produces a bundle that can be checked against its SHA-256 manifest. Nothing here deletes a record.
      </p>
      <div role="tablist" aria-label="Sections" className="flex gap-1 border-b border-slate-200">{tab('reviews', 'Reviews')}{tab('plans', 'Plans')}{tab('retention', 'Retention and legal hold')}{tab('archive', 'Archive')}</div>

      {part === 'reviews' && (
        <div className="space-y-4">
          <DueReviewsTable data={due} onOpen={canManage ? openItem : undefined} />
          <h2 className="font-semibold text-slate-800">All reviews</h2>
          <table className="w-full text-sm">
            <caption className="sr-only">Periodic reviews</caption>
            <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-3 py-2">Review</th><th scope="col" className="px-3 py-2">Due</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Conclusion</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {reviews.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-700">No review has been opened yet.</td></tr>}
              {reviews.map(r => (
                <tr key={r.id} className="border-t border-slate-100"><td className="px-3 py-2">{r.title}</td><td className="px-3 py-2">{r.dueDate}</td>
                  <td className="px-3 py-2"><Badge tone={r.status === 'Completed' ? 'success' : r.status === 'Open' ? 'warning' : 'neutral'}>{r.status}</Badge></td>
                  <td className="px-3 py-2">{r.conclusion ?? '-'}</td><td className="px-3 py-2 text-right"><Button size="sm" onClick={() => load(r.id)}>Open</Button></td></tr>
              ))}
            </tbody>
          </table>
          {detail && (
            <section aria-label="Review" className="border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="font-semibold text-slate-800">{detail.review.title} <Badge tone="neutral">{detail.review.status}</Badge></h2>
              <p className="text-xs text-slate-700">Evidence fixed when the review was opened. SHA-256 <span className="font-mono">{detail.review.evidenceSha256}</span></p>
              {detail.review.kind === 'user_access' && Array.isArray(detail.review.evidence.users) ? (
                <div className="overflow-x-auto"><table className="w-full text-xs">
                  <caption className="sr-only">Users, roles, last sign-in and training</caption>
                  <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-2 py-1">User</th><th scope="col" className="px-2 py-1">Role</th><th scope="col" className="px-2 py-1">Active</th><th scope="col" className="px-2 py-1">Last sign-in</th><th scope="col" className="px-2 py-1">Training</th><th scope="col" className="px-2 py-1">MFA</th></tr></thead>
                  <tbody>{detail.review.evidence.users.map((u: any) => (
                    <tr key={u.id} className="border-t border-slate-100"><td className="px-2 py-1">{u.name}</td><td className="px-2 py-1">{u.role}</td><td className="px-2 py-1">{u.active ? 'Yes' : 'No'}</td>
                      <td className="px-2 py-1">{day(u.lastLoginAt)}{u.dormant ? ' (dormant)' : ''}</td><td className="px-2 py-1">{u.softwareTrainingCompleted ? 'Done' : 'Missing'}{u.overdueTrainingAssignments ? `, ${u.overdueTrainingAssignments} overdue` : ''}</td><td className="px-2 py-1">{u.mfaEnabled ? 'Yes' : 'No'}</td></tr>
                  ))}</tbody></table></div>
              ) : (
                <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-auto max-h-64" aria-label="Evidence">{JSON.stringify(detail.review.evidence, null, 2)}</pre>
              )}
              {detail.review.status === 'Open' && canManage && (
                <div className="space-y-3">
                  {detail.plan.checklist.map(item => (
                    <div key={item} className="grid gap-2 md:grid-cols-[1fr_8rem_1fr] items-start">
                      <span className="text-sm text-slate-800">{item}</span>
                      <Field label={<span className="sr-only">Answer: {item}</span>}>{p => (
                        <select {...p} className={input} value={answers[item]?.answer ?? 'Yes'} onChange={e => setAnswers({ ...answers, [item]: { ...(answers[item] ?? { comment: '' }), answer: e.target.value } })}>
                          <option>Yes</option><option>No</option><option value="NotApplicable">Not applicable</option>
                        </select>)}</Field>
                      <Field label={<span className="sr-only">Comment: {item}</span>}>{p => (
                        <input {...p} className={input} placeholder="Comment (needed for No)" maxLength={1000} value={answers[item]?.comment ?? ''} onChange={e => setAnswers({ ...answers, [item]: { ...(answers[item] ?? { answer: 'Yes' }), comment: e.target.value } })} />)}</Field>
                    </div>
                  ))}
                  <div className="space-y-2">
                    {findings.map((f, i) => <p key={i} className="text-sm"><Badge tone={f.severity === 'Critical' || f.severity === 'Major' ? 'danger' : 'warning'}>{f.severity}</Badge> {f.text}</p>)}
                    <FindingForm onAdd={f => setFindings([...findings, f])} />
                  </div>
                  <Field label="Conclusion" required>{p => (
                    <select {...p} className={input} value={conclusion} onChange={e => setConclusion(e.target.value)}>
                      <option value="Satisfactory">Satisfactory</option><option value="SatisfactoryWithActions">Satisfactory with actions</option><option value="Unsatisfactory">Unsatisfactory</option>
                    </select>)}</Field>
                  <Field label="Summary" required>{p => <textarea {...p} className={`${input} w-full`} rows={3} maxLength={4000} value={summary} onChange={e => setSummary(e.target.value)} />}</Field>
                  <div className="flex gap-2">
                    <Button onClick={() => act('Draft saved.', () => apiFetch(`/periodic-reviews/${encodeURIComponent(detail.review.id)}`, { method: 'PUT', body: { checklist: checklistBody(), findings, summary, reason: 'Draft saved by the reviewer', expectedVersion: detail.review.version } }).then(() => load(detail.review.id)))}>Save draft</Button>
                    {can('periodic.sign') && <Button variant="primary" onClick={signReview}>Conclude and sign...</Button>}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {part === 'plans' && (
        <div className="space-y-4">
          {canManage && (
            <form className="grid gap-3 md:grid-cols-5 items-end" onSubmit={e => { e.preventDefault(); void act('Plan created.', () => apiFetch('/periodic-reviews/plans', { body: { ...newPlan, intervalMonths: Number(newPlan.intervalMonths) } })); }}>
              <Field label="Kind">{p => <select {...p} className={input} value={newPlan.kind} onChange={e => setNewPlan({ ...newPlan, kind: e.target.value, subjectId: e.target.value === 'user_access' || e.target.value === 'system' ? '*' : '' })}>{KINDS.map(k => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>}</Field>
              <Field label="Subject id" hint="* for user access and system">{p => <input {...p} className={input} required value={newPlan.subjectId} onChange={e => setNewPlan({ ...newPlan, subjectId: e.target.value })} />}</Field>
              <Field label="Title">{p => <input {...p} className={input} required minLength={3} value={newPlan.title} onChange={e => setNewPlan({ ...newPlan, title: e.target.value })} />}</Field>
              <Field label="Every (months)">{p => <input {...p} className={input} type="number" min={1} max={120} value={newPlan.intervalMonths} onChange={e => setNewPlan({ ...newPlan, intervalMonths: Number(e.target.value) })} />}</Field>
              <Field label="First due">{p => <input {...p} className={input} type="date" required value={newPlan.firstDueDate} onChange={e => setNewPlan({ ...newPlan, firstDueDate: e.target.value })} />}</Field>
              <Button type="submit" variant="primary">Create plan</Button>
            </form>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">Review plans</caption>
            <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-3 py-2">Plan</th><th scope="col" className="px-3 py-2">Every</th><th scope="col" className="px-3 py-2">Next due</th><th scope="col" className="px-3 py-2">Status</th></tr></thead>
            <tbody>
              {plans.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-slate-700">No plan has been created.</td></tr>}
              {plans.map(p => <tr key={p.id} className="border-t border-slate-100"><td className="px-3 py-2">{p.title}<div className="text-xs text-slate-700">{p.kind.replace('_', ' ')} {p.subjectId}</div></td><td className="px-3 py-2">{p.intervalMonths} months</td><td className="px-3 py-2">{p.nextDueDate}</td><td className="px-3 py-2">{p.status}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}

      {part === 'retention' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">A record class without a number is kept indefinitely. The number is a decision of the organisation; QA signs it. A legal hold stops any record of its class from being flagged for disposal review.</p>
          <table className="w-full text-sm">
            <caption className="sr-only">Retention per record class</caption>
            <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-3 py-2">Record class</th><th scope="col" className="px-3 py-2">Retention</th><th scope="col" className="px-3 py-2">Basis</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{policies.map(p => (
              <tr key={p.recordClass} className="border-t border-slate-100"><td className="px-3 py-2">{p.title}</td><td className="px-3 py-2">{p.indefinite ? 'Kept indefinitely' : `${p.retentionYears} years`}</td><td className="px-3 py-2">{p.basis ?? '-'}</td>
                <td className="px-3 py-2 text-right">{can('retention.manage') && <Button size="sm" onClick={() => setEditing({ recordClass: p.recordClass, years: p.retentionYears?.toString() ?? '', basis: p.basis ?? '' })}>Set...</Button>}</td></tr>))}</tbody>
          </table>
          {editing && (() => {
            const p = policies.find(x => x.recordClass === editing.recordClass)!;
            const submit = () => {
              const n = editing.years.trim() === '' ? null : Number(editing.years);
              if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) { toast.error('Years must be a whole number from 1 to 100, or empty to keep indefinitely.'); return; }
              if (editing.basis.trim().length < 5) { toast.error('A basis of at least 5 characters is required.'); return; }
              setSigning({ meaningCode: 'RETENTION_POLICY', action: 'set retention', entityName: p.title, recordVersion: p.version + 1, run: async (password, reason, totpCode) => {
                await apiFetch(`/retention/policies/${encodeURIComponent(p.recordClass)}`, { method: 'PUT', replay: 'never', body: { retentionYears: n, basis: editing.basis.trim(), expectedVersion: p.version, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) } });
                toast.success('Retention policy signed (audit logged).'); setEditing(null); await refresh();
              } });
            };
            return (
              <div className="flex gap-2 items-end border border-slate-200 rounded-lg p-3">
                <Field label={`Years for ${p.title}`} hint="Empty keeps the class indefinitely.">{f => <input {...f} className={input} inputMode="numeric" value={editing.years} onChange={e => setEditing({ ...editing, years: e.target.value })} />}</Field>
                <Field label="Basis" required>{f => <input {...f} className={`${input} w-96`} maxLength={1000} value={editing.basis} onChange={e => setEditing({ ...editing, basis: e.target.value })} />}</Field>
                <Button variant="primary" onClick={submit}>Sign...</Button><Button onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            );
          })()}
          <h2 className="font-semibold text-slate-800">Legal holds</h2>
          {can('retention.manage') && (
            <div className="flex gap-2 items-end">
              <Field label="Place a hold on">{p => <select {...p} className={input} value={holdClass} onChange={e => setHoldClass(e.target.value)}><option value="">Choose a record class</option>{policies.map(x => <option key={x.recordClass} value={x.recordClass}>{x.title}</option>)}</select>}</Field>
              <Button disabled={!holdClass} onClick={() => setSigning({ meaningCode: 'LEGAL_HOLD', action: 'place hold', entityName: holdClass, recordVersion: 1, run: async (password, reason, totpCode) => {
                await apiFetch('/retention/holds', { replay: 'never', body: { recordClass: holdClass, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) } });
                toast.success('Legal hold placed, signed (audit logged).'); setHoldClass(''); await refresh();
              } })}>Place hold...</Button>
            </div>
          )}
          <ul className="text-sm space-y-1">
            {holds.length === 0 && <li className="text-slate-700">No legal hold has been placed.</li>}
            {holds.map(h => <li key={h.id} className="flex items-center gap-2"><Badge tone={h.status === 'Active' ? 'danger' : 'neutral'}>{h.status}</Badge> {h.recordClass}{h.scopeRef ? ` / ${h.scopeRef}` : ''}: {h.reason}
              {h.status === 'Active' && can('retention.manage') && <Button size="sm" onClick={() => setSigning({ meaningCode: 'LEGAL_HOLD', action: 'release hold', entityName: h.recordClass, recordVersion: h.version + 1, run: async (password, reason, totpCode) => {
                await apiFetch(`/retention/holds/${encodeURIComponent(h.id)}/release`, { replay: 'never', body: { expectedVersion: h.version, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) } });
                toast.success('Legal hold released, signed (audit logged).'); await refresh();
              } })}>Release...</Button>}</li>)}
          </ul>
        </div>
      )}

      {part === 'archive' && (
        <div className="space-y-4">
          {can('archive.manage') && (
            <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); void act('Bundle queued; it appears in the list when it is built.', () => apiFetch('/archive/bundles', { body: { batchId: batchId.trim() } })); }}>
              <Field label="Batch (product batch id)" hint="Only a Released or Rejected batch with finished samples can be archived.">{p => <input {...p} className={input} required value={batchId} onChange={e => setBatchId(e.target.value)} />}</Field>
              <Button type="submit" variant="primary">Build bundle</Button>
            </form>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">Archive bundles</caption>
            <thead className="text-left bg-slate-50"><tr><th scope="col" className="px-3 py-2">Batch</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Files</th><th scope="col" className="px-3 py-2">Last check</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {bundles.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-700">No bundle has been built.</td></tr>}
              {bundles.map(b => (
                <tr key={b.id} className="border-t border-slate-100 align-top"><td className="px-3 py-2">{b.subjectLabel}<div className="text-xs font-mono text-slate-700">{b.manifestSha256.slice(0, 16)}...</div></td>
                  <td className="px-3 py-2"><Badge tone={b.status === 'Archived' ? 'success' : 'warning'}>{b.status === 'Archived' ? 'Archived: records are read-only' : 'Built: waiting for the QA decision'}</Badge></td>
                  <td className="px-3 py-2">{b.fileCount}</td>
                  <td className="px-3 py-2">{b.lastVerifiedAt ? `${day(b.lastVerifiedAt)} ${b.lastVerifiedOk ? 'matches the manifest' : 'DOES NOT MATCH the manifest'}` : 'Not checked'}</td>
                  <td className="px-3 py-2 text-right space-x-1">
                    {can('archive.manage') && <Button size="sm" onClick={() => act('Bundle checked.', async () => {
                      const r = await apiFetch<{ ok: boolean; problems: string[] }>(`/archive/bundles/${encodeURIComponent(b.id)}/verify`, { method: 'POST', body: {} });
                      if (!r.ok) throw new Error(`The bundle does not match its manifest: ${r.problems.slice(0, 3).join('; ')}`);
                    })}>Verify</Button>}
                    {can('archive.manage') && <Button size="sm" onClick={() => act('Restore check passed: the bundle equals the records.', async () => {
                      const r = await apiFetch<{ ok: boolean; problems: string[] }>(`/archive/bundles/${encodeURIComponent(b.id)}/restore-check`, { method: 'POST', body: {} });
                      if (!r.ok) throw new Error(`Restore check failed: ${r.problems.slice(0, 3).join('; ')}`);
                    })}>Restore check</Button>}
                    {can('archive.manage') && b.status === 'Built' && <Button size="sm" variant="primary" onClick={() => setSigning({ meaningCode: 'ARCHIVE_DECISION', action: 'archive', entityName: b.subjectLabel, recordVersion: b.version + 1, run: async (password, reason, totpCode) => {
                      await apiFetch(`/archive/bundles/${encodeURIComponent(b.id)}/decision`, { replay: 'never', body: { expectedVersion: b.version, reason: reason ?? '', password, ...(totpCode ? { totpCode } : {}) } });
                      toast.success('Archive decision signed; the records are now read-only (audit logged).'); await refresh();
                    } })}>Decide...</Button>}
                  </td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {signing && (
        <ElectronicSignatureModal user={{ ...user, email: user.email ?? undefined }} token={token} meaningCode={signing.meaningCode} action={signing.action}
          entityName={signing.entityName} recordVersion={signing.recordVersion} onClose={() => setSigning(null)} onSign={sign} />
      )}
    </div>
  );
}

function FindingForm({ onAdd }: { onAdd: (f: { text: string; severity: string }) => void }) {
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState('Observation');
  const { toast } = useToast();
  return (
    <div className="flex gap-2 items-end">
      <Field label="Finding">{p => <input {...p} className={`${input} w-80`} maxLength={2000} value={text} onChange={e => setText(e.target.value)} />}</Field>
      <Field label="Severity">{p => <select {...p} className={input} value={severity} onChange={e => setSeverity(e.target.value)}><option>Observation</option><option>Minor</option><option>Major</option><option>Critical</option></select>}</Field>
      <Button onClick={() => { if (text.trim().length < 3) { toast.error('Describe the finding (at least 3 characters).'); return; } onAdd({ text: text.trim(), severity }); setText(''); }}>Add finding</Button>
    </div>
  );
}
