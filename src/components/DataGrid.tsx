import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Download, RefreshCw, Search } from 'lucide-react';
import { apiFetch, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { useQueryState, type QuerySpec } from '../lib/useQueryState';
import { Button } from './ui/Button';
import { Field, fieldErrors, inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { localizedError, t } from '../i18n';
import { formatNumber } from '../lib/format';

/**
 * The list screen (roadmap M24). It is a view of a server list that follows the list contract of src/server/routes/lookup.ts:
 *
 *   GET <endpoint>?q&sort&dir&limit&after|before&<filters>  ->  { rows, total, offset, nextCursor, prevCursor }
 *
 * Search, filters and sort run on the server (never over the rows the browser happens to hold), paging is by cursor in both
 * directions, and the whole state is in the URL (src/lib/useQueryState.ts): a reload, a pasted link or Back shows the same page.
 * States are honest: loading, the server's error with a retry, "nothing yet" versus "nothing matches", the real total.
 * A long page renders only the rows in view (virtual window). The export is the server's: every matching row, formula-safe,
 * audited with the file's sha256; the dialog shows the hash and the row count of what was delivered.
 */
export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  className?: string;
}

export interface GridFilter { key: string; label: string; options: Array<{ value: string; label: string }> }

export interface DataGridProps<T> {
  caption: string;
  endpoint: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  defaultSort: { key: string; dir: 'asc' | 'desc' };
  filters?: GridFilter[];
  /** The address a row opens (a deep link). The first column is rendered as that link. */
  rowHref?: (row: T) => string;
  /** POST endpoint of the export; no export button without it. */
  exportEndpoint?: string;
  searchPlaceholder?: string;
  /** "samples": used in the states ("No samples yet."). */
  noun?: string;
  /** Change it to load again (after a registration, for instance). */
  reloadKey?: unknown;
  /** Toolbar items next to the search. */
  actions?: React.ReactNode;
}

interface Page<T> { rows: T[]; total: number; offset: number; nextCursor: string | null; prevCursor: string | null }

export const PAGE_SIZES = ['25', '50', '100', '200'] as const;
/** Pages longer than this render only the rows in view. */
export const VIRTUALIZE_AT = 100;

export function gridQuerySpec<T>(columns: Column<T>[], defaultSort: { key: string; dir: 'asc' | 'desc' }, filters: GridFilter[] = []): QuerySpec {
  const spec: Record<string, QuerySpec[string]> = {
    q: '',
    sort: { default: defaultSort.key, oneOf: columns.filter(c => c.sortable).map(c => c.key) },
    dir: { default: defaultSort.dir, oneOf: ['asc', 'desc'] },
    limit: { default: '50', oneOf: PAGE_SIZES },
    after: '',
    before: '',
  };
  for (const f of filters) spec[f.key] = { default: '', oneOf: ['', ...f.options.map(o => o.value)] };
  return spec;
}

/** The rows to render for a scroll position: [start, end) plus the heights of the spacers above and below. */
export function virtualWindow({ count, rowHeight, scrollTop, viewport, overscan = 5 }: { count: number; rowHeight: number; scrollTop: number; viewport: number; overscan?: number }) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, (count - end) * rowHeight) };
}

const SEARCH_DEBOUNCE_MS = 300;

export function DataGrid<T>({ caption, endpoint, columns, rowKey, defaultSort, filters = [], rowHref, exportEndpoint, searchPlaceholder, noun = 'records', reloadKey, actions }: DataGridProps<T>) {
  const spec = useMemo(() => gridQuerySpec(columns, defaultSort, filters), [columns, defaultSort.key, defaultSort.dir, filters]);
  const [qs, update] = useQueryState(spec);
  const [page, setPage] = useState<Page<T> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The request the shown page answers. The grid is busy from the moment the address changes (not one render later, when the
  // effect starts the request), so "Updating..." and aria-busy never present the previous page as the answer to the new address.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [search, setSearch] = useState(qs.q);
  const [exportOpen, setExportOpen] = useState(false);
  const { toast } = useToast();

  const filterKeys = filters.map(f => f.key);
  const params = useMemo(() => {
    const p = new URLSearchParams({ sort: qs.sort, dir: qs.dir, limit: qs.limit });
    if (qs.q) p.set('q', qs.q);
    if (qs.after) p.set('after', qs.after); else if (qs.before) p.set('before', qs.before);
    for (const k of filterKeys) if (qs[k]) p.set(k, qs[k]);
    return p.toString();
  }, [qs]);

  const requestKey = `${endpoint}?${params}#${String(reloadKey)}#${attempt}`;
  useEffect(() => {
    const ctl = new AbortController();
    setStatus('loading');
    apiFetch<Page<T>>(`${endpoint}?${params}`, { signal: ctl.signal })
      .then(p => { setPage(p); setStatus('ready'); setFailure(null); setLoadedKey(requestKey); })
      .catch(e => {
        if (ctl.signal.aborted) return;
        setLoadedKey(requestKey);
        setStatus('error');
        setFailure(localizedError(e, 'error.generic'));
        // A stale cursor (another sort, a hand-edited link) is not a dead end: offer the first page.
        if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (qs.after || qs.before)) update({ after: null, before: null });
      });
    return () => ctl.abort();
  }, [endpoint, params, reloadKey, attempt]);

  // The URL can change under the box (Back, a pasted link): follow it.
  useEffect(() => { setSearch(qs.q); }, [qs.q]);
  useEffect(() => {
    if (search.trim() === qs.q) return;
    const t = setTimeout(() => update({ q: search.trim(), after: null, before: null }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const sortBy = (key: string) => {
    const dir = qs.sort === key ? (qs.dir === 'asc' ? 'desc' : 'asc') : key === defaultSort.key ? defaultSort.dir : 'asc';
    update({ sort: key, dir, after: null, before: null });
  };
  const filtered = !!qs.q || filterKeys.some(k => qs[k]);
  const clear = () => { setSearch(''); update({ q: null, after: null, before: null, ...Object.fromEntries(filterKeys.map(k => [k, null])) }); };

  // ---- virtual window ----
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rowHeight, setRowHeight] = useState(44);
  const rows = page?.rows ?? [];
  const virtual = rows.length > VIRTUALIZE_AT;
  const viewport = scroller.current?.clientHeight ?? 600;
  const win = virtual ? virtualWindow({ count: rows.length, rowHeight, scrollTop, viewport }) : { start: 0, end: rows.length, padTop: 0, padBottom: 0 };
  const measure = (el: HTMLTableRowElement | null) => { if (el && el.offsetHeight && Math.abs(el.offsetHeight - rowHeight) > 1) setRowHeight(el.offsetHeight); };
  useEffect(() => { if (scroller.current) { scroller.current.scrollTop = 0; setScrollTop(0); } }, [page]);

  const first = page && page.rows.length ? page.offset + 1 : 0;
  const last = page ? page.offset + page.rows.length : 0;
  const busy = status === 'loading' || loadedKey !== requestKey;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="relative w-64 max-w-full">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <input type="search" aria-label={t('grid.search', { caption })} placeholder={searchPlaceholder ?? t('grid.searchDefault')} value={search}
              onChange={e => setSearch(e.target.value)} className={`${inputClass} ps-9`} />
          </div>
          {filters.map(f => (
            <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-slate-700">
              {f.label}
              <select value={qs[f.key]} onChange={e => update({ [f.key]: e.target.value || null, after: null, before: null })} className={`${inputClass} w-auto`}>
                <option value="">{t('grid.all')}</option>
                {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
          {filtered && <Button variant="ghost" size="sm" onClick={clear}>{t('grid.clearFilters')}</Button>}
        </div>
        <div className="flex gap-2 items-center">
          {actions}
          {exportEndpoint && <Button size="sm" onClick={() => setExportOpen(true)} disabled={!page || page.total === 0}><Download className="w-4 h-4" aria-hidden="true" /> {t('grid.export')}</Button>}
        </div>
      </div>

      <div ref={scroller} onScroll={e => virtual && setScrollTop((e.target as HTMLDivElement).scrollTop)} className="overflow-auto max-h-[65vh]" aria-busy={busy || undefined}>
        <table className="w-full text-start border-collapse" aria-rowcount={page ? page.total + 1 : undefined}>
          <caption className="sr-only">{page ? t('grid.summary', { caption, total: formatNumber(page.total), column: columns.find(c => c.key === qs.sort)?.header ?? qs.sort, direction: qs.dir === 'asc' ? t('grid.ascending') : t('grid.descending') }) : caption}</caption>
          <thead className="sticky top-0 bg-slate-100 z-10 shadow-sm">
            <tr aria-rowindex={1}>
              {columns.map(c => {
                const sorted = qs.sort === c.key;
                const Icon = !sorted ? ChevronsUpDown : qs.dir === 'asc' ? ChevronUp : ChevronDown;
                return c.sortable ? (
                  <th key={c.key} scope="col" aria-sort={sorted ? (qs.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="p-0 font-semibold text-slate-700 text-sm">
                    <button type="button" onClick={() => sortBy(c.key)} className="ui-control w-full flex items-center gap-1 p-3 text-start hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                      {c.header}<Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  </th>
                ) : <th key={c.key} scope="col" className="p-3 font-semibold text-slate-700 text-sm">{c.header}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {status === 'error' && (
              <tr><td colSpan={columns.length} className="p-6">
                <div role="alert" className="flex flex-wrap items-center gap-3 text-red-800">
                  <span>{t('grid.loadFailed', { noun, failure: failure ?? '' })}</span>
                  <Button size="sm" onClick={() => setAttempt(a => a + 1)}><RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('grid.retry')}</Button>
                </div>
              </td></tr>
            )}
            {status !== 'error' && !page && (
              <tr><td colSpan={columns.length} className="p-8 text-center text-slate-600"><span role="status">{t('grid.loading', { noun })}</span></td></tr>
            )}
            {status !== 'error' && page && rows.length === 0 && (
              <tr><td colSpan={columns.length} className="p-8 text-center text-slate-600">
                <span role="status">{filtered ? t('grid.noneMatch', { noun }) : t('grid.noneYet', { noun })}</span>
                {filtered && <> <Button variant="ghost" size="sm" onClick={clear}>{t('grid.clearFilters')}</Button></>}
              </td></tr>
            )}
            {status !== 'error' && win.padTop > 0 && <tr aria-hidden="true" style={{ height: win.padTop }}><td colSpan={columns.length} /></tr>}
            {status !== 'error' && rows.slice(win.start, win.end).map((row, i) => {
              const index = win.start + i;
              const href = rowHref?.(row);
              return (
                <tr key={rowKey(row)} ref={i === 0 ? measure : undefined} aria-rowindex={(page?.offset ?? 0) + index + 2}
                  onClick={href ? (e => { if (!(e.target as HTMLElement).closest('a,button,input,select')) navigate(href); }) : undefined}
                  className={`ui-row border-b border-slate-100 ${href ? 'hover:bg-blue-50 cursor-pointer' : ''}`}>
                  {columns.map((c, ci) => (
                    <td key={c.key} className={`p-3 text-sm text-slate-800 ${c.className ?? ''}`}>
                      {ci === 0 && href
                        ? <a href={href} className="font-mono font-bold text-blue-800 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">{c.render ? c.render(row) : String((row as any)[c.key] ?? '')}</a>
                        : c.render ? c.render(row) : String((row as any)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
            {status !== 'error' && win.padBottom > 0 && <tr aria-hidden="true" style={{ height: win.padBottom }}><td colSpan={columns.length} /></tr>}
          </tbody>
        </table>
      </div>

      <div className="p-3 border-t border-slate-200 bg-slate-50 flex flex-wrap gap-3 items-center justify-between text-sm text-slate-700">
        <span role="status" aria-live="polite">
          {busy && page ? `${t('grid.updating')} ` : ''}
          {page && page.total > 0 ? t('grid.range', { first: formatNumber(first), last: formatNumber(last), total: formatNumber(page.total) }) : page ? t('grid.rangeEmpty', { zero: formatNumber(0) }) : ''}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2">{t('grid.rowsPerPage')}
            <select value={qs.limit} onChange={e => update({ limit: e.target.value, after: null, before: null })} className={`${inputClass} w-auto`}>
              {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <Button size="sm" disabled={!page?.prevCursor || busy} onClick={() => update({ before: page!.prevCursor, after: null }, { push: true })}>{t('grid.previous')}</Button>
          <Button size="sm" disabled={!page?.nextCursor || busy} onClick={() => update({ after: page!.nextCursor, before: null }, { push: true })}>{t('grid.next')}</Button>
        </div>
      </div>

      {exportEndpoint && exportOpen && (
        <ExportDialog endpoint={exportEndpoint} noun={noun} total={page?.total ?? 0}
          query={{ q: qs.q || undefined, sort: qs.sort, dir: qs.dir, ...Object.fromEntries(filterKeys.filter(k => qs[k]).map(k => [k, qs[k]])) }}
          onClose={() => setExportOpen(false)} onDone={msg => toast.success(msg)} onError={msg => toast.error(msg)} />
      )}
    </div>
  );
}

interface ExportAnswer { fileName: string; contentType: string; rowCount: number; sha256: string; auditSequence: number; content: string }

function download(answer: ExportAnswer) {
  const bin = atob(answer.content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: answer.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = answer.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ExportDialog({ endpoint, noun, total, query, onClose, onDone, onError }: { endpoint: string; noun: string; total: number; query: Record<string, string | undefined>; onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ExportAnswer | null>(null);

  const submit = async (e: any) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setErrors({ reason: t('grid.export.reasonShort') });
      onError(t('grid.export.reasonToast'));
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const answer = await apiFetch<ExportAnswer>(endpoint, { method: 'POST', body: { ...Object.fromEntries(Object.entries(query).filter(([, v]) => v)), format, reason } });
      download(answer);
      setResult(answer);
      onDone(t('grid.export.done', { count: formatNumber(answer.rowCount), noun, file: answer.fileName }));
    } catch (err) {
      setErrors(fieldErrors(err));
      onError(t('grid.export.failed', { message: localizedError(err, 'error.generic') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={t('grid.export.title', { noun })} onClose={onClose} dismissible={!busy}
      description={result ? undefined : t('grid.export.description', { total: formatNumber(total), noun })}
      footer={result
        ? <Button variant="primary" onClick={onClose}>{t('common.done')}</Button>
        : <><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="grid-export-form" busy={busy}>{t('grid.export')}</Button></>}>
      {result ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-slate-700">{t('grid.export.file')}</dt><dd dir="ltr" className="font-mono break-all text-start">{result.fileName}</dd>
          <dt className="font-medium text-slate-700">{t('grid.export.rows')}</dt><dd>{formatNumber(result.rowCount)}</dd>
          <dt className="font-medium text-slate-700">SHA-256</dt><dd dir="ltr" className="font-mono text-xs break-all text-start">{result.sha256}</dd>
          <dt className="font-medium text-slate-700">{t('grid.export.auditEntry')}</dt><dd><bdi dir="ltr">#{result.auditSequence}</bdi></dd>
        </dl>
      ) : (
        <form id="grid-export-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
          <fieldset className="flex gap-6">
            <legend className="text-sm font-medium text-slate-700 mb-1">{t('grid.export.format')}</legend>
            {(['csv', 'xlsx'] as const).map(f => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="radio" name="format" value={f} checked={format === f} onChange={() => setFormat(f)} /> {f === 'csv' ? 'CSV' : t('grid.export.excel')}
              </label>
            ))}
          </fieldset>
          <Field label={t('grid.export.reason')} required error={errors.reason} hint={t('grid.export.reasonHint')}>
            {p => <input {...p} type="text" value={reason} onChange={e => setReason(e.target.value)} className={inputClass} maxLength={500} />}
          </Field>
        </form>
      )}
    </Modal>
  );
}
