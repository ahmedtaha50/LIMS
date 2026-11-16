import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, TextField } from '../../ui/index.js';

export type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'datetime' | 'choice' | 'boolean'; required?: boolean; unit?: string; min?: number; max?: number; choices?: string[] };
export type KindDef = { key: string; label: string; fields: FieldDef[] };

/** The form of an entry is built from the type version: a new type needs no new screen (E21#3). */
export function EntryForm({ logbookId, kinds, correcting, onSaved, onCancel }: { logbookId: string; kinds: KindDef[]; correcting?: { id: string; kind: string; values: Record<string, unknown> }; onSaved: () => void; onCancel: () => void }) {
  const [kindKey, setKindKey] = useState(correcting?.kind ?? kinds[0]?.key ?? '');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const kind = kinds.find(k => k.key === kindKey);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!kind) return;
    const f = new FormData(e.currentTarget);
    const values: Record<string, unknown> = {};
    for (const fd of kind.fields) {
      const raw = f.get(fd.key);
      if (fd.type === 'boolean') { const v = f.get(fd.key); if (v === 'yes') values[fd.key] = true; else if (v === 'no') values[fd.key] = false; continue; }
      if (raw === null || raw === '') continue;
      values[fd.key] = fd.type === 'number' ? Number(raw) : fd.type === 'datetime' ? new Date(String(raw)).toISOString() : String(raw);
    }
    const body: Record<string, unknown> = { kind: kind.key, values, password: String(f.get('password') ?? '') };
    const comment = String(f.get('comment') ?? ''); if (comment) body.comment = comment;
    if (correcting) body.reason = String(f.get('reason') ?? '');
    try {
      await api('POST', correcting ? `/api/logbooks/${logbookId}/entries/${correcting.id}/correct` : `/api/logbooks/${logbookId}/entries`, body);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) { setError(err.message); setDetails(Array.isArray(err.details) ? err.details.map(d => (typeof d === 'string' ? d : `${d.path}: ${d.message}`)) : []); } else setError('The entry was not saved.');
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-slate-300 bg-white p-4" aria-label={correcting ? 'Correct entry' : 'New entry'}>
      <h3 className="text-lg font-bold">{correcting ? `Correct entry #${correcting.id}` : 'New entry'}</h3>
      {!correcting ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="entry-kind" className="text-sm font-semibold text-slate-700">Kind of entry</label>
          <select id="entry-kind" value={kindKey} onChange={e => setKindKey(e.target.value)} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
            {kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
      ) : null}
      {kind?.fields.map(fd => {
        const def = correcting?.values[fd.key];
        const label = `${fd.label}${fd.unit ? ` (${fd.unit})` : ''}${fd.required ? ' *' : ''}`;
        const limits = fd.type === 'number' && (fd.min !== undefined || fd.max !== undefined) ? `Limits: ${fd.min ?? '…'} to ${fd.max ?? '…'}${fd.unit ? ' ' + fd.unit : ''}` : undefined;
        if (fd.type === 'choice') return (
          <div key={fd.key} className="flex flex-col gap-1"><label htmlFor={`f-${fd.key}`} className="text-sm font-semibold text-slate-700">{label}</label>
            <select id={`f-${fd.key}`} name={fd.key} defaultValue={typeof def === 'string' ? def : ''} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
              <option value="">Choose…</option>{fd.choices?.map(c => <option key={c} value={c}>{c}</option>)}
            </select></div>);
        if (fd.type === 'boolean') return (
          <fieldset key={fd.key} className="flex flex-col gap-1"><legend className="text-sm font-semibold text-slate-700">{label}</legend>
            <div className="flex gap-3">{['yes', 'no'].map(v => <label key={v} className="flex min-h-11 min-w-11 items-center gap-2 rounded-lg border border-slate-400 px-3"><input type="radio" name={fd.key} value={v} defaultChecked={def === (v === 'yes')} className="size-5" />{v === 'yes' ? 'Yes' : 'No'}</label>)}</div>
          </fieldset>);
        return <TextField key={fd.key} label={label} name={fd.key} type={fd.type === 'number' ? 'number' : fd.type === 'datetime' ? 'datetime-local' : 'text'} step={fd.type === 'number' ? 'any' : undefined} inputMode={fd.type === 'number' ? 'decimal' : undefined} defaultValue={def === undefined ? undefined : String(def)} {...(limits ? { hint: limits } : {})} />;
      })}
      <TextField label="Comment" name="comment" hint="Required when a value is outside its limits." />
      {correcting ? <TextField label="Reason for the correction *" name="reason" required /> : null}
      <TextField label="Your password (signature) *" name="password" type="password" autoComplete="current-password" required hint="Signing means: I performed this and the values are true." />
      {error ? <Alert>{error}{details.length ? <ul className="mt-1 list-disc pl-5">{details.map(d => <li key={d}>{d}</li>)}</ul> : null}</Alert> : null}
      <div className="flex flex-wrap gap-3"><Button type="submit">Sign and save</Button><Button variant="secondary" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
