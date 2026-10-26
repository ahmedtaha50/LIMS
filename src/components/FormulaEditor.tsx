// The calculation formula editor (roadmap M18). Owned by r2-methods-calc.
//
// A formula is an expression over declared inputs plus test cases whose expected values were calculated by hand, outside the system.
// The screen never calculates: "Try" sends the expression to POST /api/calc/evaluate, and the approval is refused by the server unless
// every test case reproduces its value there. The functions listed are the server's allow-list (FORMULA_FUNCTIONS).
import React, { useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { FORMULA_FUNCTIONS, type FormulaInput, type FormulaTestCase } from '../lib/validations/methods';

export interface FormulaDraft {
  code: string;
  name: string;
  expression: string;
  unit: string | null;
  inputs: FormulaInput[];
  testCases: FormulaTestCase[];
}

type Values = FormulaTestCase['inputs'];

/** "1000, 1010, 990" -> [1000, 1010, 990]; "2.5" -> 2.5 (or [2.5] for a replicate input); text that is not a number -> null. */
export function parseValue(text: string, replicates: boolean): number | number[] | null {
  const parts = text.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isFinite(n))) return null;
  return replicates ? nums : nums.length === 1 ? nums[0] : null;
}
const valueText = (v: number | readonly number[] | undefined) => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

export interface FormulaEditorProps {
  value: FormulaDraft;
  onChange: (next: FormulaDraft) => void;
  /** The code is fixed once the formula exists (revisions keep it). */
  codeLocked?: boolean;
  /** Tries the expression on one test case's inputs on the server; resolves to the reported value or rejects with the reason. */
  onTry?: (expression: string, inputs: Values, decimals: number | null) => Promise<string>;
}

export function FormulaEditor({ value, onChange, codeLocked, onTry }: FormulaEditorProps) {
  const [tried, setTried] = useState<Record<number, string>>({});
  const set = (patch: Partial<FormulaDraft>) => onChange({ ...value, ...patch });
  const setInput = (i: number, patch: Partial<FormulaInput>) => set({ inputs: value.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setCase = (i: number, patch: Partial<FormulaTestCase>) => set({ testCases: value.testCases.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setCaseInput = (i: number, input: FormulaInput, text: string) => {
    const parsed = parseValue(text, input.replicates);
    const inputs: Values = { ...value.testCases[i].inputs };
    if (parsed === null) delete (inputs as Record<string, unknown>)[input.name]; else (inputs as Record<string, unknown>)[input.name] = parsed;
    setCase(i, { inputs });
  };
  const tryCase = async (i: number) => {
    if (!onTry) return;
    const c = value.testCases[i];
    try {
      const reported = await onTry(value.expression, c.inputs, c.decimals);
      setTried(t => ({ ...t, [i]: reported === c.expected ? `Server: ${reported} (matches)` : `Server: ${reported} (expected ${c.expected})` }));
    } catch (err) {
      setTried(t => ({ ...t, [i]: err instanceof Error ? err.message : 'The server could not calculate it.' }));
    }
  };

  return (
    <div className="space-y-5 text-sm">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">Code
          <input type="text" value={value.code} disabled={codeLocked} onChange={e => set({ code: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">Name
          <input type="text" value={value.name} onChange={e => set({ name: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
        </label>
      </div>
      <label className="flex flex-col gap-1">Expression
        <textarea value={value.expression} onChange={e => set({ expression: e.target.value })} rows={3} spellCheck={false} className="px-3 py-2 border border-slate-300 rounded font-mono" />
      </label>
      <label className="flex items-center gap-2">Unit of the result
        <input type="text" value={value.unit ?? ''} onChange={e => set({ unit: e.target.value || null })} className="w-28 px-3 py-1.5 border border-slate-300 rounded" />
      </label>

      <fieldset className="border border-slate-200 rounded-lg p-3">
        <legend className="px-1 font-semibold text-slate-700">Inputs</legend>
        {value.inputs.map((inp, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center mb-2">
            <input type="text" aria-label="Input name" placeholder="name" value={inp.name} onChange={e => setInput(i, { name: e.target.value })} className="w-32 px-2 py-1 border border-slate-300 rounded font-mono" />
            <input type="text" aria-label="Input label" placeholder="label" value={inp.label ?? ''} onChange={e => setInput(i, { label: e.target.value || null })} className="flex-1 min-w-[140px] px-2 py-1 border border-slate-300 rounded" />
            <input type="text" aria-label="Input unit" placeholder="unit" value={inp.unit ?? ''} onChange={e => setInput(i, { unit: e.target.value || null })} className="w-20 px-2 py-1 border border-slate-300 rounded" />
            <label className="flex items-center gap-1"><input type="checkbox" checked={inp.replicates} onChange={e => setInput(i, { replicates: e.target.checked })} /> replicates</label>
            <button type="button" aria-label={`Remove input ${inp.name}`} onClick={() => set({ inputs: value.inputs.filter((_, j) => j !== i) })} className="text-red-500 p-1 rounded hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button type="button" onClick={() => set({ inputs: [...value.inputs, { name: '', label: null, unit: null, replicates: false }] })} className="text-blue-700 flex items-center gap-1"><Plus className="w-4 h-4" /> Add input</button>
      </fieldset>

      <fieldset className="border border-slate-200 rounded-lg p-3">
        <legend className="px-1 font-semibold text-slate-700">Test cases (values calculated by hand)</legend>
        {value.testCases.length === 0 && <p className="text-slate-500 italic mb-2">No test case yet: the formula cannot be approved without one.</p>}
        {value.testCases.map((c, i) => (
          <div key={i} className="border border-slate-100 bg-slate-50 rounded p-2 mb-2 space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <input type="text" aria-label="Test case name" placeholder="case name" value={c.name} onChange={e => setCase(i, { name: e.target.value })} className="flex-1 min-w-[160px] px-2 py-1 border border-slate-300 rounded" />
              <label className="flex items-center gap-1">decimals
                <input type="number" min={0} max={10} value={c.decimals ?? ''} onChange={e => setCase(i, { decimals: e.target.value === '' ? null : Number(e.target.value) })} className="w-16 px-2 py-1 border border-slate-300 rounded" />
              </label>
              <label className="flex items-center gap-1">expected
                <input type="text" value={c.expected} onChange={e => setCase(i, { expected: e.target.value })} className="w-28 px-2 py-1 border border-slate-300 rounded font-mono" />
              </label>
              {onTry && <button type="button" onClick={() => tryCase(i)} className="text-blue-700 flex items-center gap-1"><FlaskConical className="w-4 h-4" /> Try</button>}
              <button type="button" aria-label={`Remove test case ${c.name}`} onClick={() => set({ testCases: value.testCases.filter((_, j) => j !== i) })} className="text-red-500 p-1 rounded hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {value.inputs.map(inp => (
                <label key={inp.name} className="flex items-center gap-1 font-mono">{inp.name} =
                  <input type="text" defaultValue={valueText(c.inputs[inp.name])} placeholder={inp.replicates ? '1, 2, 3' : '1.0'} onBlur={e => setCaseInput(i, inp, e.target.value)} className="w-48 px-2 py-1 border border-slate-300 rounded" />
                </label>
              ))}
            </div>
            {tried[i] && <p className="text-xs text-slate-600" role="status">{tried[i]}</p>}
          </div>
        ))}
        <button type="button" onClick={() => set({ testCases: [...value.testCases, { name: '', inputs: {}, decimals: null, expected: '' }] })} className="text-blue-700 flex items-center gap-1"><Plus className="w-4 h-4" /> Add test case</button>
      </fieldset>

      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer font-semibold">Functions the server allows</summary>
        <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1">
          {FORMULA_FUNCTIONS.map(f => <li key={f.name}><code className="font-mono text-slate-800">{f.name}</code>: {f.description}</li>)}
        </ul>
        <p className="mt-2">Operators: + - * / ^ (power), comparisons == != &lt; &lt;= &gt; &gt;=, &amp;&amp; and ||. Numbers are written with digits and a decimal point (no exponent).</p>
      </details>
    </div>
  );
}
