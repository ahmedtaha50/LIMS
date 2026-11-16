import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type Item = { id: string; kind: string; text: string; acknowledgedBy: string | null; note: string | null };
type ReviewView = { review: { status: string; version: number } | null; items: Item[]; disposition: { decision: string; decidedBy: string; decidedAt: string } | null };
type Summary = { id: string; batchNumber: string; productName: string; status: string; openExceptions: number };
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Not done.');

function Signed({ label, note, noteRequired, onSubmit, danger }: { label: string; note?: string; noteRequired?: boolean; danger?: boolean; onSubmit: (password: string, note: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={label} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); void onSubmit(String(f.get('password') ?? ''), String(f.get('note') ?? '')).catch(x => setError(err(x))); }}>
      {note ? <TextField label={note} name="note" required={!!noteRequired} /> : null}
      <TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit" variant={danger ? 'danger' : 'primary'}>{label}</Button>
    </form>
  );
}

/** Review by exception (E14) and disposition (E15): QA reads what deviated, signs each item, then releases or rejects. */
function ReviewBatch({ b, onBack }: { b: Summary; onBack: () => void }) {
  const [v, setV] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<ReviewView>('GET', `/api/batches/${b.id}/review`).then(setV).catch(x => setError(err(x)));
  useEffect(() => { void load(); }, [b.id]);
  if (!v) return error ? <Alert>{error}</Alert> : <p role="status">Loading…</p>;
  const left = v.items.filter(i => !i.acknowledgedBy).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={onBack}>Back</Button><h2 className="text-xl font-bold">{b.batchNumber} · {b.productName}</h2></div>
      {!v.review ? <Button onClick={() => void api('POST', `/api/batches/${b.id}/review`).then(load).catch(x => setError(err(x)))}>Start the review</Button> : null}
      {v.review ? <Card title={`Review by exception · ${v.review.status} · ${v.items.length - left} of ${v.items.length} reviewed`}>
        {v.items.length === 0 ? <p className="text-base">Nothing deviated: no item to review.</p> : null}
        <ul className="flex flex-col gap-2">{v.items.map(i => (
          <li key={i.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
            <p className="text-base"><b>{i.kind.replace('_', ' ')}</b>: {i.text}</p>
            {i.acknowledgedBy ? <p className="text-sm">Reviewed by {i.acknowledgedBy}{i.note ? `: ${i.note}` : ''}</p>
              : <Signed label={`Reviewed (${i.id})`} note="Assessment" onSubmit={async (password, note) => { await api('POST', `/api/batches/${b.id}/review/items/${i.id}`, { password, ...(note ? { note } : {}) }); await load(); }} />}
          </li>))}</ul>
        {v.review.status === 'open' && left === 0 ? <div className="mt-3"><Signed label="Complete the review" onSubmit={async (password) => { await api('POST', `/api/batches/${b.id}/review/complete`, { version: v.review!.version, password }); await load(); }} /></div> : null}
      </Card> : null}
      {v.review?.status === 'complete' && !v.disposition ? <Card title="Disposition"><div className="grid gap-2 md:grid-cols-2">
        <Signed label="Release the batch" note="Comment" onSubmit={async (password, note) => { await api('POST', `/api/batches/${b.id}/release`, { password, ...(note ? { comment: note } : {}) }); await load(); }} />
        <Signed label="Reject the batch" note="Reason *" noteRequired danger onSubmit={async (password, note) => { await api('POST', `/api/batches/${b.id}/reject`, { password, comment: note }); await load(); }} />
      </div></Card> : null}
      {v.disposition ? <Alert kind="info">{v.disposition.decision.toUpperCase()} by {v.disposition.decidedBy}, {new Date(v.disposition.decidedAt).toLocaleString()}.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <a className="inline-flex min-h-11 items-center text-base text-sky-800 underline" href={`/api/batches/${b.id}/certified-copy`}>Certified copy (PDF)</a>
    </div>
  );
}

function Review() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [open, setOpen] = useState<Summary | null>(null);
  useEffect(() => { if (!open) void api<Summary[]>('GET', '/api/batches').then(l => setList(l.filter(b => ['completed', 'in_review', 'released', 'rejected'].includes(b.status)))); }, [open]);
  if (open) return <ReviewBatch b={open} onBack={() => setOpen(null)} />;
  if (!list) return <p role="status">Loading…</p>;
  return (
    <Card title="Batches to review and release">
      {list.length === 0 ? <p className="text-base">No completed batch.</p> : <ul className="grid gap-3 md:grid-cols-2" aria-label="Batches for review">{list.map(b => (
        <li key={b.id}><button type="button" onClick={() => setOpen(b)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-300 bg-white p-3 text-left hover:bg-slate-50">
          <span className="text-base font-bold">{b.batchNumber} · {b.productName}</span><span className="text-sm text-slate-700">{b.status.replace('_', ' ')}</span></button></li>))}</ul>}
    </Card>
  );
}
export const screen: Screen = { id: 'review', title: 'Review & release', order: 40, permission: 'review.perform', Component: Review };
