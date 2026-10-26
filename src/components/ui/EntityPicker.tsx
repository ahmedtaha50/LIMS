import React, { useEffect, useId, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '../../lib/api';

/**
 * Choose a record by typing part of its id or name (roadmap M24), instead of typing a free-text id that nobody checks before the
 * save. Options come from GET /api/lookup/<kind> (samples, results, users, specifications, instruments). A picker is guidance
 * only: the route that receives the id validates it again.
 *
 * WAI-ARIA combobox: the input owns a listbox; Arrow keys move, Enter chooses, Esc closes; the active option is announced
 * through aria-activedescendant. When the server has more matches than it sent, the list says so.
 */
export type LookupKind = 'samples' | 'results' | 'users' | 'specifications' | 'instruments';
export interface LookupItem { id: string; label: string; detail: string }
interface LookupAnswer { items: LookupItem[]; truncated: boolean }

export interface EntityPickerProps {
  kind: LookupKind;
  label: React.ReactNode;
  /** The chosen id ('' for none). */
  value: string;
  onChange: (id: string, item: LookupItem | null) => void;
  /** Extra lookup filters, e.g. { sampleId, oos: 'true' } for results. */
  params?: Record<string, string>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
}

const DEBOUNCE_MS = 250;

export function EntityPicker({ kind, label, value, onChange, params, placeholder = 'Type to search', required, disabled, error, hint }: EntityPickerProps) {
  const uid = useId().replace(/:/g, '');
  const inputId = `ep${uid}`;
  const listId = `${inputId}-list`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LookupItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);
  const paramKey = JSON.stringify(params ?? {});

  const query = async (q: { q?: string; id?: string }) => {
    const n = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const qs = new URLSearchParams({ ...(params ?? {}), ...Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as Record<string, string> });
      const answer = await apiFetch<LookupAnswer>(`/lookup/${kind}?${qs}`);
      if (n !== seq.current) return null; // a newer request was sent meanwhile
      return answer;
    } catch (e) {
      if (n === seq.current) setFailure(`Could not load the options: ${errorMessage(e)}`);
      return null;
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };

  // Show the label of a value set from outside (an existing record), resolved by id.
  useEffect(() => {
    if (!value) { setText(''); return; }
    let live = true;
    void query({ id: value }).then(a => { if (live && a) setText(a.items[0] ? a.items[0].label : value); });
    return () => { live = false; };
  }, [value, kind]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void query({ q: text.trim() }).then(a => { if (a) { setItems(a.items); setTruncated(a.truncated); setActive(a.items.length ? 0 : -1); } });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, open, kind, paramKey]);

  const choose = (item: LookupItem) => {
    setText(item.label);
    setOpen(false);
    onChange(item.id, item);
  };

  const onKeyDown = (e: any) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && open && active >= 0 && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };

  const describedBy = [hint ? `${inputId}-hint` : null, error || failure ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  const optionId = (i: number) => `${inputId}-opt-${i}`;

  return (
    <div className="flex flex-col gap-1 relative">
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700">{label}</label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={e => { setText(e.target.value); setOpen(true); if (value) onChange('', null); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="ui-control w-full px-3 py-2 border border-slate-400 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
      />
      <ul id={listId} role="listbox" aria-label={typeof label === 'string' ? label : undefined} hidden={!open}
        className="absolute top-full mt-1 left-0 right-0 z-40 max-h-64 overflow-y-auto bg-white border border-slate-300 rounded-lg shadow-lg">
        {items.map((item, i) => (
          <li key={item.id} id={optionId(i)} role="option" aria-selected={i === active ? 'true' : 'false'}
            onMouseDown={e => { e.preventDefault(); choose(item); }}
            className={`ui-option px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-blue-50' : ''}`}>
            <span className="font-medium text-slate-900">{item.label}</span>
            <span className="block text-xs text-slate-600">{item.detail}</span>
          </li>
        ))}
        {open && !loading && !failure && items.length === 0 && <li role="presentation" className="px-3 py-2 text-sm text-slate-600">No matches.</li>}
        {open && truncated && <li role="presentation" className="px-3 py-2 text-xs text-slate-600 border-t border-slate-200">More matches exist: type more to narrow the list.</li>}
      </ul>
      {loading && open && <span className="sr-only" role="status">Searching</span>}
      {hint && <p id={`${inputId}-hint`} className="text-xs text-slate-600">{hint}</p>}
      {(error || failure) && <p id={`${inputId}-error`} role="alert" className="text-xs font-medium text-red-700">{error || failure}</p>}
    </div>
  );
}
