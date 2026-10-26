/**
 * The bench-side result workbench (roadmap M19). Owned by r2-result-ui.
 *
 * Every parameter of a sample in one grid: specification, unit, value, instrument, and the evaluation. The analyst types the values
 * in a row after another (Enter / Shift+Enter, or the arrow keys, walk the rows; Tab keeps the browser's order: value, instrument,
 * next row) and saves all changed rows at once with Ctrl+S (Cmd+S) or the Save button, through PUT /samples/:id/results-batch,
 * one transaction. Nothing is ever saved automatically.
 *
 *   * The live PASS/OOS chip is ADVISORY: it applies the server's own rule (src/server/lib/evaluate.ts) to what is typed, so the
 *     analyst sees a likely OOS before saving. It is not a result: the server evaluates again on save, and its verdict is the record.
 *   * An instrument that is not Active, or past its calibration due date, is disabled in the dropdown with the date (the server
 *     refuses it as well: the calibration guard).
 *   * Overwriting a value shows the reason fields of that row (free text and coded reason); the row is held back on the screen until
 *     both are given. Replacing an OOS value sends its open investigation.
 *   * A stale row (someone saved it meanwhile) or a row the server refused is highlighted with the server's reason; the whole save
 *     was refused, nothing was written.
 *   * An OOS row links to its investigation, or offers to open one.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, ShieldAlert, Save, RotateCcw, RefreshCw, Paperclip } from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import { localizedError, t } from '../i18n';
import { formatNumber, parseResultInput } from '../lib/format';
import { OOS_RESULT_CHANGE_CODES } from '../lib/constants/results';
import { calibrationState } from '../lib/validations/instruments';
import type { ResultsBatchItem } from '../lib/validations/results-batch';
import { formatHash } from '../lib/router';
import { evaluateResult, limitOfResult } from '../server/lib/evaluate';
import { RESULT_CHANGE_CODES, VERSION_CODE_LABELS, isOosChangeCode, type ResultChangeCode } from '../server/services/result-hooks/codes';
import { Button } from './ui/Button';
import { useToast } from './ui/Toast';

// ---- rows ----------------------------------------------------------------------------------------------------------------------

/** A result row as GET /samples/:id returns it (the limit is the copy taken at registration; v0.1.0 rows have only specMin/specMax). */
export interface ResultRow {
  id: string; parameter: string; value: string | null; isOos: boolean; version?: number;
  limitKind?: string | null; lowerText?: string | null; upperText?: string | null; decimals?: number | null; unit?: string | null;
  acceptanceText?: string | null; specMin?: number | null; specMax?: number | null;
  instrumentId?: string | null; attachmentName?: string | null; attachmentData?: string | null;
}

/** The limit as it is written: "98.0 - 102.0 %", "NMT 0.5 %", "NLT 98.0 %", or the acceptance text. */
export function formatResultLimit(r: ResultRow): string {
  const unit = r.unit ? ` ${r.unit}` : '';
  const lower = r.lowerText ?? (r.specMin ?? null)?.toString() ?? null;
  const upper = r.upperText ?? (r.specMax ?? null)?.toString() ?? null;
  switch (r.limitKind ?? (lower !== null && upper !== null ? 'RANGE' : lower !== null ? 'NLT' : upper !== null ? 'NMT' : 'TEXT')) {
    case 'RANGE': return `${lower} - ${upper}${unit}`;
    case 'NLT': return `NLT ${lower}${unit}`;
    case 'NMT': return `NMT ${upper}${unit}`;
    default: return r.acceptanceText ?? '-';
  }
}

const isBlank = (v: string | null | undefined) => v === null || v === undefined || v === '';

/** The evaluation the server made (results.is_oos): OOS, Pass, or Pending while no value is entered. */
export function ResultEvaluation({ result }: { result: ResultRow }) {
  if (isBlank(result.value)) {
    return <span className="inline-flex items-center gap-1 text-slate-600 bg-slate-50 px-2 py-1 rounded text-xs font-semibold border border-slate-200">Pending</span>;
  }
  return result.isOos
    ? <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-1 rounded text-xs font-bold border border-red-200"><ShieldAlert className="w-3 h-3" aria-hidden="true"/> OOS</span>
    : <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-1 rounded text-xs font-bold border border-emerald-200"><Check className="w-3 h-3" aria-hidden="true"/> Pass</span>;
}

/** What the analyst has typed or chosen on a row and not saved yet. */
export interface RowDraft { value?: string; instrumentId?: string; reason?: string; reasonCode?: string }
export interface RowError { stale: boolean; message: string }
export interface InstrumentLike { id: string; name: string; status: string; calibrationDueDate: string }
export interface InvestigationLike { id: string; resultId: string | null; status: string }

/** An investigation that is not final (the server's OOS_TERMINAL_STATUSES: Closed, and v0.1.0's Approved). */
const isOpenInvestigation = (o: InvestigationLike) => o.status !== 'Closed' && o.status !== 'Approved';
export const openInvestigationOf = (resultId: string, investigations: readonly InvestigationLike[]) =>
  investigations.find(o => o.resultId === resultId && isOpenInvestigation(o)) ?? null;

// ---- pure pieces (tested in tests/api/result-ui-grid.test.ts) ------------------------------------------------------------------

export type GridKeyAction = 'next' | 'prev' | 'save' | null;

/** Enter / ArrowDown: next row; Shift+Enter / ArrowUp: previous row; Ctrl+S or Cmd+S: save. Tab is left to the browser. */
export function gridKeyAction(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): GridKeyAction {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') return 'save';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Enter') return e.shiftKey ? 'prev' : 'next';
  if (e.key === 'ArrowDown') return 'next';
  if (e.key === 'ArrowUp') return 'prev';
  return null;
}

/** The row to move to: the next (or previous) row that can be typed in; at either end, the row stays where it is. */
export function nextRowIndex(typeable: readonly boolean[], from: number, dir: 'next' | 'prev'): number {
  const step = dir === 'next' ? 1 : -1;
  for (let i = from + step; i >= 0 && i < typeable.length; i += step) if (typeable[i]) return i;
  return from;
}

export type AdvisoryKind = 'EMPTY' | 'INVALID' | 'PASS' | 'OOS';

/** The live check of a typed value, by the server's rule (rounded to the declared decimals). Advisory: the server evaluates on save. */
export function advisoryChip(row: ResultRow, typed: string): { kind: AdvisoryKind; text: string } {
  if (typed.trim() === '') return { kind: 'EMPTY', text: '' };
  // 1,5 is refused with its own explanation: the comma is never read as a decimal separator or as thousands (the server refuses it too).
  const input = parseResultInput(typed);
  if (input.ok === false && input.code === 'DECIMAL_COMMA') {
    return { kind: 'INVALID', text: t('result.input.DECIMAL_COMMA', { value: typed.trim(), example: typed.trim().replace(/[,،]/, '.') }) };
  }
  const evaluation = evaluateResult(typed, limitOfResult({
    limitKind: row.limitKind ?? null, lowerText: row.lowerText ?? null, upperText: row.upperText ?? null, decimals: row.decimals ?? null,
    acceptanceText: row.acceptanceText ?? null, specMin: row.specMin ?? null, specMax: row.specMax ?? null,
  }));
  if (evaluation.ok === false) return { kind: 'INVALID', text: evaluation.error };
  const note = input.ok === true && input.normalized ? ` ${t('result.input.readAs', { value: input.value })}` : '';
  return { kind: evaluation.isOos ? 'OOS' : 'PASS', text: `${evaluation.reportable}${note}` };
}

/** One option of the instrument dropdown. Not Active, or past the calibration due date: disabled, with the reason and the date. */
export function instrumentOption(inst: InstrumentLike, now = new Date()): { value: string; label: string; disabled: boolean } {
  const name = `${inst.id} - ${inst.name}`;
  if (inst.status !== 'Active') return { value: inst.id, label: `${name} (${inst.status})`, disabled: true };
  if (calibrationState(inst.calibrationDueDate, now).expired) {
    return { value: inst.id, label: t('result.inst.overdue', { name, date: inst.calibrationDueDate }), disabled: true };
  }
  return { value: inst.id, label: t('result.inst.due', { name, date: inst.calibrationDueDate }), disabled: false };
}

const storedValue = (row: ResultRow) => row.value ?? '';
const typedValue = (row: ResultRow, d: RowDraft | undefined) => (d?.value === undefined ? storedValue(row) : d.value.trim());
const chosenInstrument = (d: RowDraft | undefined) => (d?.instrumentId ? d.instrumentId : undefined);

/** Has the row a change to save: a different value, or an instrument chosen that is not the recorded one. */
export function isDirty(row: ResultRow, d: RowDraft | undefined): boolean {
  if (!d) return false;
  const inst = chosenInstrument(d);
  return typedValue(row, d) !== storedValue(row) || (inst !== undefined && inst !== (row.instrumentId ?? undefined));
}

/** A row that already holds a value and is being changed: it needs its reason and coded reason. */
export const isOverwrite = (row: ResultRow, d: RowDraft | undefined) => isDirty(row, d) && !isBlank(row.value);

/**
 * What a save sends: the dirty rows only, each with the version it was loaded at. A row that is not complete (an overwrite without
 * its reason or coded reason, an OOS value without an open investigation, a value removed) is held back as a problem, and while
 * there is any problem nothing is sent: the save is all or nothing on the screen as on the server.
 */
export function buildBatchItems(rows: readonly ResultRow[], drafts: Record<string, RowDraft>, investigations: readonly InvestigationLike[] = []):
  { items: ResultsBatchItem[]; problems: Array<{ resultId: string; message: string }> } {
  const items: ResultsBatchItem[] = [];
  const problems: Array<{ resultId: string; message: string }> = [];
  for (const row of rows) {
    const d = drafts[row.id];
    if (!isDirty(row, d)) continue;
    const problem = (message: string) => problems.push({ resultId: row.id, message });
    const value = typedValue(row, d);
    if (value === '') {
      problem(isBlank(row.value) ? t('result.problem.enterValue', { parameter: row.parameter }) : t('result.problem.cannotRemove', { parameter: row.parameter }));
      continue;
    }
    const item: ResultsBatchItem = { resultId: row.id, value, expectedVersion: row.version ?? 0 };
    const instrumentId = chosenInstrument(d);
    if (instrumentId) item.instrumentId = instrumentId;
    const reason = d?.reason?.trim() ?? '';
    if (!isBlank(row.value)) {
      if (reason.length < 5 || !d?.reasonCode) {
        problem(t('result.problem.needsReason', { parameter: row.parameter }));
        continue;
      }
      item.reason = reason;
      item.reasonCode = d.reasonCode as ResultChangeCode;
      if (row.isOos) {
        const open = openInvestigationOf(row.id, investigations);
        if (!open) { problem(t('result.problem.oosNoInvestigation', { parameter: row.parameter })); continue; }
        if (!isOosChangeCode(d.reasonCode)) { problem(t('result.problem.oosCode', { parameter: row.parameter })); continue; }
        item.oosId = open.id;
      }
    } else if (reason !== '') {
      if (reason.length < 5) { problem(t('result.problem.reasonShort', { parameter: row.parameter })); continue; }
      item.reason = reason;
    }
    items.push(item);
  }
  return { items, problems };
}

/** The rows a refused save names (`details` of the server's answer: resultId, or path items.<n>), with the server's reason. */
export function rowErrorsFromApiError(err: unknown, items: readonly ResultsBatchItem[]): Record<string, RowError> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const stale = err.status === 409 && err.code === 'RESULTS_STALE';
  const out: Record<string, RowError> = {};
  for (const d of err.details as Array<{ path?: string; resultId?: string; message?: string }>) {
    const index = /^items\.(\d+)/.exec(d?.path ?? '')?.[1];
    const id = d?.resultId ?? (index !== undefined ? items[Number(index)]?.resultId : undefined);
    if (id) out[id] = { stale, message: d.message ?? err.message };
  }
  return out;
}

// ---- the table (presentational: rendered by tests with react-dom/server) -------------------------------------------------------

export interface ResultGridTableProps {
  rows: readonly ResultRow[];
  drafts: Record<string, RowDraft>;
  instruments: readonly InstrumentLike[];
  rowErrors: Record<string, RowError>;
  editable: boolean;
  now?: Date;
  investigations?: readonly InvestigationLike[];
  onDraft?: (resultId: string, patch: RowDraft) => void;
  onOpenInvestigation?: (row: ResultRow) => void;
  /** The value inputs, by row index, so the grid can move the focus. */
  valueRef?: (index: number, el: HTMLInputElement | null) => void;
}

const CHIP: Record<Exclude<AdvisoryKind, 'EMPTY'>, string> = {
  PASS: 'text-emerald-800 bg-emerald-50 border-emerald-300',
  OOS: 'text-red-800 bg-red-50 border-red-300',
  INVALID: 'text-amber-800 bg-amber-50 border-amber-300',
};

function AdvisoryChip({ row, typed }: { row: ResultRow; typed: string }) {
  const chip = advisoryChip(row, typed);
  if (chip.kind === 'EMPTY') return <span className="text-xs text-slate-500">{t('result.notEntered')}</span>;
  const title = chip.kind === 'INVALID' ? chip.text
    : t('result.advisoryTitle', { text: chip.text, oos: chip.kind === 'OOS' ? t('result.advisoryOos') : '' });
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold border border-dashed ${CHIP[chip.kind]}`}>
      {chip.kind === 'INVALID' ? t('result.notAcceptable') : chip.kind} <span className="font-normal italic">{t('result.advisory')}</span>
    </span>
  );
}

const cell = 'px-3 py-2 align-top';
const control = 'ui-control px-2 py-1 border border-slate-400 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600';

export function ResultGridTable({ rows, drafts, instruments, rowErrors, editable, now = new Date(), investigations = [], onDraft, onOpenInvestigation, valueRef }: ResultGridTableProps) {
  const set = (id: string, patch: RowDraft) => onDraft?.(id, patch);
  return (
    <table className="w-full text-sm text-start">
      <caption className="text-start text-xs text-slate-600 px-3 py-2">
        {t('result.caption')}
      </caption>
      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-medium">
        <tr>
          <th scope="col" className={cell}>{t('result.col.parameter')}</th>
          <th scope="col" className={cell}>{t('result.col.specification')}</th>
          <th scope="col" className={cell}>{t('result.col.unit')}</th>
          <th scope="col" className={cell}>{t('result.col.result')}</th>
          <th scope="col" className={cell}>{t('result.col.instrument')}</th>
          <th scope="col" className={cell}>{t('result.col.evaluation')}</th>
          <th scope="col" className={cell}>{t('result.col.investigation')}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r, index) => {
          const d = drafts[r.id];
          const dirty = isDirty(r, d);
          const overwrite = isOverwrite(r, d);
          const error = rowErrors[r.id];
          const open = openInvestigationOf(r.id, investigations);
          const anyInvestigation = open ?? investigations.find(o => o.resultId === r.id) ?? null;
          const tone = error ? (error.stale ? 'bg-amber-50' : 'bg-red-50') : dirty ? 'bg-blue-50/50' : '';
          return (
            <React.Fragment key={r.id}>
              <tr data-row={r.id} data-stale={error?.stale ? 'true' : undefined} data-dirty={dirty ? 'true' : undefined} className={tone}>
                <th scope="row" className={`${cell} font-medium text-slate-900`}>{r.parameter}</th>
                <td className={`${cell} text-slate-700 font-mono`} dir="ltr">{formatResultLimit(r)}</td>
                <td className={`${cell} text-slate-700`}>{r.unit ?? '-'}</td>
                <td className={cell}>
                  {editable ? (
                    <input
                      id={`value-${r.id}`}
                      ref={el => valueRef?.(index, el)}
                      data-row-index={index}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={r.unit ? t('result.valueLabelUnit', { parameter: r.parameter, unit: r.unit }) : t('result.valueLabel', { parameter: r.parameter })}
                      dir="ltr"
                      aria-invalid={error ? true : undefined}
                      className={`${control} w-28 font-mono`}
                      value={d?.value ?? storedValue(r)}
                      onChange={e => set(r.id, { value: e.target.value })}
                    />
                  ) : (
                    <span className="font-mono text-slate-900" dir="ltr">{isBlank(r.value) ? '-' : r.unit ? `${r.value} ${r.unit}` : r.value}</span>
                  )}
                  {r.attachmentData && (
                    // A file kept inline on the row by v0.1.0 or R1 (new files are in the attachment panel below the grid).
                    <a href={r.attachmentData} download={r.attachmentName ?? undefined} className="mt-1 text-xs text-indigo-800 flex items-center gap-1 font-medium w-fit underline">
                      <Paperclip className="w-3 h-3" aria-hidden="true" /> {r.attachmentName ?? t('result.attachment')}
                    </a>
                  )}
                </td>
                <td className={cell}>
                  {editable ? (
                    <select
                      id={`instrument-${r.id}`}
                      aria-label={t('result.instrumentLabel', { parameter: r.parameter })}
                      className={`${control} max-w-[16rem]`}
                      value={d?.instrumentId ?? r.instrumentId ?? ''}
                      onChange={e => set(r.id, { instrumentId: e.target.value })}
                    >
                      <option value="">{t('result.noInstrument')}</option>
                      {instruments.map(i => {
                        const o = instrumentOption(i, now);
                        return <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>;
                      })}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-700">{r.instrumentId ?? '-'}</span>
                  )}
                </td>
                <td className={cell}>{dirty ? <AdvisoryChip row={r} typed={typedValue(r, d)} /> : <ResultEvaluation result={r} />}</td>
                <td className={cell}>
                  {anyInvestigation ? (
                    <a href={formatHash('oos', [anyInvestigation.id])} className="text-xs font-semibold text-blue-800 underline">
                      <bdi dir="ltr">{anyInvestigation.id}</bdi> ({anyInvestigation.status})
                    </a>
                  ) : r.isOos ? (
                    <Button size="sm" variant="danger" onClick={() => onOpenInvestigation?.(r)}>{t('result.openInvestigation')}</Button>
                  ) : null}
                </td>
              </tr>
              {(overwrite || error) && (
                <tr data-row-detail={r.id} className={tone}>
                  <td colSpan={7} className="px-3 pb-3">
                    {error && <p className={`text-xs font-semibold mb-2 ${error.stale ? 'text-amber-900' : 'text-red-800'}`}>{error.message}</p>}
                    {overwrite && editable && (
                      <div className="flex flex-col md:flex-row gap-2">
                        <label htmlFor={`reason-${r.id}`} className="text-xs font-bold text-amber-900 uppercase tracking-wide md:w-40 md:pt-1">{t('result.reasonForChange')}</label>
                        <input
                          id={`reason-${r.id}`}
                          type="text"
                          className={`${control} flex-1`}
                          placeholder={t('result.reasonPlaceholder')}
                          value={d?.reason ?? ''}
                          onChange={e => set(r.id, { reason: e.target.value })}
                        />
                        <label htmlFor={`reasonCode-${r.id}`} className="sr-only">{t('result.codedReasonFor', { parameter: r.parameter })}</label>
                        <select id={`reasonCode-${r.id}`} className={control} value={d?.reasonCode ?? ''} onChange={e => set(r.id, { reasonCode: e.target.value })}>
                          <option value="">{r.isOos ? t('result.phaseOne', { id: open?.id ?? t('result.noneOpen') }) : t('result.codedReason')}</option>
                          {(r.isOos ? OOS_RESULT_CHANGE_CODES : RESULT_CHANGE_CODES).map(c => (
                            <option key={c} value={c}>{VERSION_CODE_LABELS[c]}{c === 'REINTEGRATION' ? t('result.needsQa') : ''}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- the grid (state, keyboard, save) ------------------------------------------------------------------------------------------

export interface SavedResult { id: string; parameter: string; value: string | null; isOos: boolean; version: number; oosInvestigationId: string | null }

export interface ResultGridProps {
  sampleId: string;
  rows: readonly ResultRow[];
  instruments: readonly InstrumentLike[];
  investigations: readonly InvestigationLike[];
  /** The person may enter results and the sample is in Testing (a hint: the server decides). */
  editable: boolean;
  /** Reload the sample (after a save, or to see what someone else saved). */
  onReload: () => void | Promise<void>;
  onOpenInvestigation: (row: ResultRow) => void;
}

export function ResultGrid({ sampleId, rows, instruments, investigations, editable, onReload, onOpenInvestigation }: ResultGridProps) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [saving, setSaving] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const dirtyCount = rows.filter(r => isDirty(r, drafts[r.id])).length;

  // Unsaved values are never saved for the analyst: leaving the page with some asks first.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);

  const onDraft = (id: string, patch: RowDraft) => {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    if (rowErrors[id] && !rowErrors[id].stale) setRowErrors(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  const save = async () => {
    if (saving) return;
    const { items, problems } = buildBatchItems(rows, drafts, investigations);
    if (problems.length > 0) {
      setRowErrors(Object.fromEntries(problems.map(p => [p.resultId, { stale: false, message: p.message }])));
      toast.error(t('result.nothingSaved', { message: `${problems[0].message}${problems.length > 1 ? t(problems.length > 2 ? 'result.moreMany' : 'result.moreOne', { n: formatNumber(problems.length - 1) }) : ''}` }));
      return;
    }
    if (items.length === 0) { toast.info(t('result.nothingToSave')); return; }
    setSaving(true);
    try {
      const out = await apiFetch<{ saved: SavedResult[] }>(`/samples/${encodeURIComponent(sampleId)}/results-batch`, { method: 'PUT', body: { items } });
      setDrafts({});
      setRowErrors({});
      const oos = out.saved.filter(r => r.isOos);
      if (oos.length > 0) {
        toast(t(out.saved.length > 1 ? 'result.savedOosMany' : 'result.savedOosOne', { n: formatNumber(out.saved.length), list: oos.map(r => t('result.oosItem', { parameter: r.parameter, id: String(r.oosInvestigationId) })).join(', ') }), 'error');
      } else {
        toast.success(t(out.saved.length > 1 ? 'result.savedMany' : 'result.savedOne', { n: formatNumber(out.saved.length) }));
      }
      await onReload();
    } catch (e) {
      setRowErrors(rowErrorsFromApiError(e, items));
      toast.error(t('result.nothingSaved', { message: localizedError(e, 'result.saveFailed') }));
    } finally {
      setSaving(false);
    }
  };

  const reloadKeepingDrafts = async () => {
    setRowErrors({});
    await onReload();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = gridKeyAction(e);
    if (action === 'save') {
      e.preventDefault();
      if (editable) void save();
      return;
    }
    if (!action) return;
    const index = Number((e.target as HTMLElement).getAttribute?.('data-row-index'));
    if (!Number.isInteger(index) || (e.target as HTMLElement).tagName !== 'INPUT') return;
    e.preventDefault();
    const typeable = rows.map((_, i) => !!inputs.current[i] && !inputs.current[i]!.disabled);
    const to = nextRowIndex(typeable, index, action);
    inputs.current[to]?.focus();
    inputs.current[to]?.select();
  };

  const stale = (Object.values(rowErrors) as RowError[]).some(e => e.stale);

  return (
    // The keyboard handler serves the inputs inside (Enter walks the rows, Ctrl+S saves); the div itself is not interactive.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDown={onKeyDown} className="flex flex-col">
      {editable && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white">
          <span className="text-xs text-slate-700" aria-live="polite">
            {dirtyCount === 0 ? t('result.noUnsaved') : t(dirtyCount > 1 ? 'result.unsavedMany' : 'result.unsavedOne', { n: formatNumber(dirtyCount) })}
          </span>
          <span className="text-xs text-slate-500 hidden md:inline">{t('result.keys')}</span>
          <div className="ms-auto flex gap-2">
            {stale && (
              <Button size="sm" onClick={reloadKeepingDrafts}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {t('result.reload')}</Button>
            )}
            <Button size="sm" disabled={dirtyCount === 0 || saving} onClick={() => { setDrafts({}); setRowErrors({}); }}>
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {t('result.discard')}
            </Button>
            <Button size="sm" variant="primary" busy={saving} disabled={dirtyCount === 0} onClick={() => void save()}>
              <Save className="w-3.5 h-3.5" aria-hidden="true" /> {t('result.saveAll')}
            </Button>
          </div>
        </div>
      )}
      <div className="overflow-auto">
        <ResultGridTable
          rows={rows} drafts={drafts} instruments={instruments} rowErrors={rowErrors} editable={editable}
          investigations={investigations} onDraft={onDraft} onOpenInvestigation={onOpenInvestigation}
          valueRef={(i, el) => { inputs.current[i] = el; }}
        />
      </div>
    </div>
  );
}
