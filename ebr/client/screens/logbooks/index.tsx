import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, Card } from '../../ui/index.js';
import type { Screen } from '../registry.js';
import { EntryForm, type KindDef } from './EntryForm.js';
import { StatusBadge } from './StatusBadge.js';

type Summary = { id: string; objectKind: string; objectCode: string; name: string; location: string; typeName: string; status: string; derived: { status: string; reasons: string[] }; entryCount: number; lastEntryAt: string | null };
type Entry = { id: string; kindLabel: string; kind: string; typeVersion: number; values: Record<string, unknown>; flags: Array<{ message: string }>; comment: string | null; recordedAt: string; meaning: string; signedBy: string; correctsEntryId: string | null; correctionReason: string | null; correctedBy: string | null };
type Detail = Summary & { definition: { entryKinds: KindDef[] } | null; entries: Entry[]; derived: { status: string; reasons: string[]; calibrationDue: string | null } };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function LogbookView({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<{ kind: 'view' } | { kind: 'new' } | { kind: 'correct'; entry: Entry }>({ kind: 'view' });
  const load = () => api<Detail>('GET', `/api/logbooks/${id}`).then(setD).catch(e => setError(e instanceof ApiError ? e.message : 'Not loaded.'));
  useEffect(() => { void load(); }, [id]);
  if (error) return <Alert>{error}</Alert>;
  if (!d) return <p role="status">Loading…</p>;
  const done = () => { setMode({ kind: 'view' }); void load(); };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={onBack}>Back to logbooks</Button>
        <h2 className="text-xl font-bold">{d.objectCode} · {d.name}</h2><StatusBadge status={d.derived.status} /></div>
      {d.derived.reasons.length ? <Alert kind="info">{d.derived.reasons.join('; ')}</Alert> : null}
      <p className="text-base text-slate-700">{d.typeName}{d.location ? ` · ${d.location}` : ''}{d.derived.calibrationDue ? ` · calibration due ${d.derived.calibrationDue.slice(0, 10)}` : ''}</p>
      {d.status !== 'active' ? <Alert kind="info">This logbook is retired: it can be read, not written.</Alert> : null}
      {mode.kind === 'view' && d.status === 'active' && d.definition ? <div><Button onClick={() => setMode({ kind: 'new' })}>New entry</Button></div> : null}
      {mode.kind === 'new' && d.definition ? <EntryForm logbookId={d.id} kinds={d.definition.entryKinds} onSaved={done} onCancel={() => setMode({ kind: 'view' })} /> : null}
      {mode.kind === 'correct' && d.definition ? <EntryForm logbookId={d.id} kinds={d.definition.entryKinds} correcting={mode.entry} onSaved={done} onCancel={() => setMode({ kind: 'view' })} /> : null}
      <ol className="flex flex-col gap-3" aria-label="Entries">
        {[...d.entries].reverse().map(e => (
          <li key={e.id} className={`rounded-xl border bg-white p-3 ${e.correctedBy ? 'border-slate-300 opacity-75' : 'border-slate-300'}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-base font-bold">#{e.id} {e.kindLabel}{e.correctedBy ? <span className="ml-2 text-sm font-semibold text-amber-800">corrected by #{e.correctedBy}</span> : null}</p>
              <p className="text-sm text-slate-600">{when(e.recordedAt)} · {e.signedBy} · {e.meaning}</p>
            </div>
            {e.correctsEntryId ? <p className="text-sm text-amber-900">Corrects #{e.correctsEntryId}: {e.correctionReason}</p> : null}
            <dl className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">{Object.entries(e.values).map(([k, v]) => <div key={k} className="flex gap-2 text-base"><dt className="font-semibold">{k}:</dt><dd>{String(v)}</dd></div>)}</dl>
            {e.flags.length ? <p className="mt-1 text-base font-semibold text-red-800">Outside limits: {e.flags.map(f => f.message).join('; ')}</p> : null}
            {e.comment ? <p className="mt-1 text-base">Comment: {e.comment}</p> : null}
            {!e.correctedBy && d.status === 'active' && mode.kind === 'view' ? <Button variant="secondary" className="mt-2" onClick={() => setMode({ kind: 'correct', entry: e })}>Correct</Button> : null}
          </li>
        ))}
      </ol>
      <a className="inline-flex min-h-11 items-center text-base text-sky-800 underline" href={`/api/logbooks/${d.id}/export`}>Export as PDF</a>
    </div>
  );
}

function Logbooks() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (!open) api<Summary[]>('GET', '/api/logbooks?status=active').then(setList).catch(e => setError(e instanceof ApiError ? e.message : 'Not loaded.')); }, [open]);
  if (open) return <LogbookView id={open} onBack={() => setOpen(null)} />;
  if (error) return <Alert>{error}</Alert>;
  if (!list) return <p role="status">Loading…</p>;
  return (
    <Card title="Logbooks">
      {list.length === 0 ? <p className="text-base">No logbook yet. A supervisor creates them.</p> : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Logbooks list">
          {list.map(l => (
            <li key={l.id}>
              <button type="button" onClick={() => setOpen(l.id)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-300 bg-white p-3 text-left hover:bg-slate-50">
                <span className="flex w-full flex-wrap items-center justify-between gap-2"><span className="text-base font-bold">{l.objectCode} · {l.name}</span><StatusBadge status={l.derived.status} /></span>
                <span className="text-sm text-slate-700">{l.typeName}{l.location ? ` · ${l.location}` : ''} · {l.entryCount} entries</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
export const screen: Screen = { id: 'logbooks', title: 'Logbooks', order: 10, permission: 'logbook.read', Component: Logbooks };
