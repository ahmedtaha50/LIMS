/**
 * The Ctrl+K command palette (roadmap M43): one box that finds samples, batches, products, specifications, methods, SOPs, documents and
 * users, and opens the one you pick. The server decides what each role may see (GET /search, src/server/routes/search.ts): a kind of
 * record the role may not read is not in the answer at all, so nothing here filters or hides by role.
 *
 * Keyboard: type (three characters or more); Up and Down move through the hits across groups; Enter opens the highlighted hit; Esc closes.
 * It is a combobox with a listbox of grouped options (role="combobox", aria-activedescendant), inside the shared Modal (focus trap, Esc,
 * focus returns to where it was). Every outcome is visible: searching, no hit, a failed search (with the reason) and the "more" notice.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { apiFetch, errorMessage } from '../lib/api';
import { formatHash } from '../lib/router';
import { Modal } from './ui/Modal';

export const PALETTE_MIN_CHARS = 3;
const DEBOUNCE_MS = 180;

export interface SearchHit { id: string; label: string; detail: string; view: string; segments: string[] }
export interface SearchGroup { type: string; label: string; hits: SearchHit[]; more: boolean }
interface SearchAnswer { q: string; indexed: boolean; groups: SearchGroup[] }

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the address (#/samples/SMP-...) of the hit that was picked. */
  onNavigate: (hash: string) => void;
}

export function CommandPalette({ open, onClose, onNavigate }: Props) {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const query = text.trim();
  const ready = query.length >= PALETTE_MIN_CHARS;

  useEffect(() => { if (!open) { setText(''); setAnswer(null); setFailure(null); setBusy(false); setActive(0); } }, [open]);

  useEffect(() => {
    if (!open || !ready) { setAnswer(null); setFailure(null); setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      apiFetch<SearchAnswer>(`/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(a => { setAnswer(a); setFailure(null); setActive(0); })
        .catch(e => { if (!controller.signal.aborted) { setAnswer(null); setFailure(errorMessage(e, 'The search failed. Try again.')); } })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query, ready]);

  // One flat list for the arrow keys, grouped for the eye.
  const flat = useMemo(() => (answer?.groups ?? []).flatMap(g => g.hits.map(h => ({ group: g, hit: h }))), [answer]);

  const pick = (i: number) => {
    const entry = flat[i];
    if (entry) onNavigate(formatHash(entry.hit.view, entry.hit.segments));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (flat.length === 0) return;
      e.preventDefault();
      setActive(a => (e.key === 'ArrowDown' ? (a + 1) % flat.length : (a - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  };

  const status = !ready ? `Type at least ${PALETTE_MIN_CHARS} characters.`
    : busy ? 'Searching...'
    : failure ? failure
    : flat.length === 0 && answer ? `No result for "${query}".`
    : flat.length > 0 ? `${flat.length} result${flat.length === 1 ? '' : 's'}.` : '';

  let index = -1;
  return (
    <Modal open={open} title="Search" description="Samples, batches, products, specifications, methods, SOPs, documents and users you may view." onClose={onClose} size="lg" initialFocus={input}>
      <div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onKeyDown={onKeyDown}
            maxLength={100}
            onChange={e => setText(e.target.value)}
            placeholder="Sample id, material, batch, product, SOP, user..."
            className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-300 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
          />
        </div>
        <p role={failure ? 'alert' : 'status'} aria-live="polite" className={`mt-2 text-xs ${failure ? 'text-red-700 font-medium' : 'text-slate-500'}`}>{status}</p>
        <div id={listId} role="listbox" aria-label="Search results" className="mt-2 space-y-3">
          {(answer?.groups ?? []).map(group => (
            <div key={group.type} role="group" aria-label={group.label}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono px-1 mb-1" aria-hidden="true">{group.label}</div>
              <ul className="space-y-0.5">
                {group.hits.map(hit => {
                  index += 1;
                  const i = index;
                  return (
                    // The options are operated from the combobox input (arrow keys and Enter); the click is for the mouse.
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <li
                      key={`${group.type}:${hit.id}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      onMouseMove={() => { if (active !== i) setActive(i); }}
                      onClick={() => pick(i)}
                      className={`flex items-baseline justify-between gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm ${i === active ? 'bg-blue-50 text-blue-900' : 'text-slate-800 hover:bg-slate-50'}`}
                    >
                      <span className="font-medium truncate">{hit.label}</span>
                      <span className="text-xs text-slate-500 truncate">{hit.detail}</span>
                    </li>
                  );
                })}
              </ul>
              {group.more && <p className="text-xs text-slate-500 px-3 pt-1">More {group.label.toLowerCase()} match: type more characters to narrow the search.</p>}
            </div>
          ))}
        </div>
        {answer && !answer.indexed && flat.length > 0 && <p className="mt-3 text-[11px] text-slate-400">The search index is not installed on this database; results can be slow on large data.</p>}
      </div>
    </Modal>
  );
}
