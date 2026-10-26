// Reagents, reference standards and prepared solutions (roadmap M30, r2-reagents). The server is the authority on every step
// (src/server/routes/reagents.ts): `lotActions` only decides which buttons to show, from the lot's status, who the user is and what
// GET /permissions/me grants. Receipt, release, rejection and retest go through the e-signature dialog with their own meaning code;
// every refusal is shown as the server worded it. Whether a lot or solution may be used is the server's verdict (usable,
// blockedReason), never recomputed here. SampleMaterialsPanel is the result-to-lot link of the sample screen.
import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, PackagePlus, Search, ShieldCheck, Beaker, Link2 } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

export interface LotRow {
  id: string; itemId: string; itemCode: string; itemName: string; category: string; lotNumber: string; supplier: string;
  coaReference: string | null; receivedQuantity: number; unit: string; expiryDate: string; retestDate: string | null;
  potency: number | null; potencyBasis: string | null; storageLocation: string | null; status: string; receivedBy: string;
  receivedAt: string; releasedBy: string | null; openedAt: string | null; inUseExpiry: string | null; balance: number;
  useUntil: string; usable: boolean; blockedReason: string | null; version: number;
}
export interface SolutionRow {
  id: string; name: string; concentration: string | null; preparation: string; quantity: number; unit: string; expiryDate: string;
  status: string; preparedBy: string; preparedAt: string; balance: number; usable: boolean; blockedReason: string | null; version: number;
}
export interface ItemRow {
  id: string; code: string; name: string; category: string; grade: string | null; unit: string; storageCondition: string | null;
  inUseShelfLifeDays: number | null; requiresPotency: boolean; status: string; version: number;
}
export interface MaterialOption {
  id: string; kind: 'lot' | 'solution'; label: string; name: string; lotNumber: string | null; status: string; unit: string;
  useUntil: string; usable: boolean; blockedReason: string | null; balance: number;
}
export interface MaterialLink {
  id: string; resultId: string; materialId: string; label: string | null; quantity: number | null; linkedAt: string; linkedBy: string;
  withdrawnAt: string | null; withdrawReason: string | null; usable: boolean; blockedReason: string | null; useUntil: string | null;
}

export const LOT_STATUS_LABEL: Record<string, string> = {
  Quarantine: 'Quarantine', Approved: 'Released', InUse: 'In use', Consumed: 'Used up', Disposed: 'Disposed', Expired: 'Expired', Rejected: 'Rejected',
};
const STATUS_STYLE: Record<string, string> = {
  Quarantine: 'bg-amber-50 text-amber-800 border-amber-200', Approved: 'bg-blue-50 text-blue-700 border-blue-200',
  InUse: 'bg-emerald-50 text-emerald-700 border-emerald-200', Active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Expired: 'bg-red-50 text-red-700 border-red-200', Rejected: 'bg-red-50 text-red-700 border-red-200',
};
export const LotStatus = ({ status }: { status: string }) =>
  <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${STATUS_STYLE[status] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>{LOT_STATUS_LABEL[status] ?? status}</span>;

const input = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50';

export type LotAction = 'release' | 'reject' | 'retest' | 'open' | 'consume' | 'dispose' | 'traceback';
export const ACTION_LABEL: Record<LotAction, string> = {
  release: 'Release (sign)', reject: 'Reject (sign)', retest: 'Record retest (sign)', open: 'Open', consume: 'Record consumption', dispose: 'Dispose', traceback: 'Traceback',
};
const SIGNED: Partial<Record<LotAction, string>> = { release: 'REAGENT_LOT_RELEASE', reject: 'REAGENT_LOT_REJECTION', retest: 'REAGENT_LOT_RETEST' };

/** The steps offered for a lot. The server's rules: release and rejection by someone who did not receive the lot. */
export function lotActions(lot: Pick<LotRow, 'status' | 'receivedBy'>, me: { id: string }, perms: { approve: boolean; use: boolean }): LotAction[] {
  const out: LotAction[] = [];
  const receiver = lot.receivedBy === me.id;
  if (perms.approve && !receiver && lot.status === 'Quarantine') out.push('release');
  if (perms.approve && !receiver && ['Quarantine', 'Approved', 'InUse'].includes(lot.status)) out.push('reject');
  if (perms.approve && ['Quarantine', 'Approved', 'InUse'].includes(lot.status)) out.push('retest');
  if (perms.use && lot.status === 'Approved') out.push('open');
  if (perms.use && lot.status === 'InUse') out.push('consume');
  if (perms.use && ['Approved', 'InUse'].includes(lot.status)) out.push('dispose');
  out.push('traceback');
  return out;
}

/** The lot register (rendered on its own by tests/api/reagents-ui.test.ts). */
export function LotTable({ lots, selected, onSelect }: { lots: readonly LotRow[]; selected?: string; onSelect: (id: string) => void }) {
  if (lots.length === 0) return <p className="text-sm text-slate-500 p-4">No reagent lots received yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Lot</th><th className="p-2">Item</th><th className="p-2">Supplier lot</th><th className="p-2">Status</th><th className="p-2">Use until</th><th className="p-2">Balance</th><th className="p-2">For results</th></tr>
      </thead>
      <tbody>
        {lots.map(l => (
          <tr key={l.id} className={`border-t border-slate-100 cursor-pointer ${selected === l.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`} onClick={() => onSelect(l.id)}>
            <td className="p-2 font-mono"><button type="button" className="hover:underline" onClick={() => onSelect(l.id)}>{l.id}</button></td>
            <td className="p-2">{l.itemName}<span className="ms-2 text-xs text-slate-400">{l.itemCode}</span></td>
            <td className="p-2 font-mono">{l.lotNumber}<div className="text-xs text-slate-400">{l.supplier}</div></td>
            <td className="p-2"><LotStatus status={l.status} /></td>
            <td className="p-2">{l.useUntil}{l.inUseExpiry && l.inUseExpiry < l.expiryDate && <div className="text-xs text-slate-400">in-use expiry (expiry {l.expiryDate})</div>}
              {l.retestDate && <div className="text-xs text-slate-400">retest {l.retestDate}</div>}</td>
            <td className="p-2">{l.balance} {l.unit}</td>
            <td className="p-2">{l.usable ? <span className="text-emerald-700 text-xs font-semibold">Usable</span>
              : <span className="text-xs text-red-700" data-blocked="true">{l.blockedReason}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The material picker of result entry: every lot and solution the server lists, the ones that may not be used DISABLED with the
 * server's reason (expired, quarantined, past retest), so an analyst cannot pick them.
 */
export function MaterialSelect({ materials, value, onChange, id }: { materials: readonly MaterialOption[]; value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <select id={id} className={input} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">Choose a lot or solution...</option>
      {materials.map(m => (
        <option key={m.id} value={m.id} disabled={!m.usable} title={m.blockedReason ?? undefined}>
          {m.id} {m.name}{m.lotNumber ? ` (lot ${m.lotNumber})` : ''}{m.usable ? ` - until ${m.useUntil}, ${m.balance} ${m.unit} left` : ` - not usable: ${m.blockedReason}`}
        </option>
      ))}
    </select>
  );
}

/** The links of a sample's results (rendered on its own by the UI test). */
export function MaterialLinkList({ links, parameters, canWithdraw, onWithdraw }: {
  links: readonly MaterialLink[]; parameters: Record<string, string>; canWithdraw: boolean; onWithdraw: (l: MaterialLink) => void;
}) {
  if (links.length === 0) return <p className="text-sm text-slate-500 italic">No reagent lots or solutions recorded for these results.</p>;
  return (
    <table className="w-full text-sm text-start">
      <thead className="text-slate-500 border-b border-slate-200">
        <tr><th className="py-2 pe-3">Result</th><th className="py-2 pe-3">Material</th><th className="py-2 pe-3">Quantity</th><th className="py-2 pe-3">Now</th><th className="py-2" /></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {links.map(l => (
          <tr key={l.id} className={l.withdrawnAt ? 'text-slate-400 line-through' : ''}>
            <td className="py-2 pe-3">{parameters[l.resultId] ?? l.resultId}</td>
            <td className="py-2 pe-3">{l.label ?? l.materialId}</td>
            <td className="py-2 pe-3">{l.quantity ?? ''}</td>
            <td className="py-2 pe-3 text-xs">{l.withdrawnAt ? `withdrawn: ${l.withdrawReason}` : l.usable ? `usable until ${l.useUntil}` : <span className="text-red-700">{l.blockedReason}</span>}</td>
            <td className="py-2 text-end">{canWithdraw && !l.withdrawnAt && <button type="button" className={button} onClick={() => onWithdraw(l)}>Withdraw</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface Ask { title: string; quantityUnit?: string; submit: (v: { quantity?: number; reason: string }) => Promise<boolean> }

/** A reason (and, for a consumption, a quantity) asked inline; the server checks both again. */
export function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [quantity, setQuantity] = useState('');
  const submit = async () => {
    const q = ask.quantityUnit !== undefined ? Number(quantity) : undefined;
    if (q !== undefined && !(q > 0)) { toast.error('The quantity must be a number above 0.'); return; }
    if (reason.trim().length < 5) { toast.error('A clear reason is required (at least 5 characters).'); return; }
    if (await ask.submit({ quantity: q, reason: reason.trim() })) onClose();
  };
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-40" role="dialog">
      <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3">
        <h3 className="font-bold text-sm">{ask.title}</h3>
        {ask.quantityUnit !== undefined && <label className="text-xs block">Quantity ({ask.quantityUnit})<input className={input} inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>}
        <label className="text-xs block">Reason<textarea className={input} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="flex justify-end gap-2"><button type="button" className={button} onClick={onClose}>Cancel</button><button type="button" className={primary} onClick={submit}>Record</button></div>
      </div>
    </div>
  );
}

/** Mounted under the result grid of the sample screen: which lots and solutions each result was measured with. */
export function SampleMaterialsPanel({ sampleId, results, editable, onChanged }: {
  sampleId: string; results: ReadonlyArray<{ id: string; parameter: string }>; editable: boolean; onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [links, setLinks] = useState<MaterialLink[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [form, setForm] = useState({ resultId: '', materialId: '', quantity: '' });
  const [ask, setAsk] = useState<Ask | null>(null);
  const parameters = Object.fromEntries(results.map(r => [r.id, r.parameter]));

  const load = useCallback(async () => {
    try {
      setLinks(await apiFetch<MaterialLink[]>(`/samples/${encodeURIComponent(sampleId)}/materials`));
      if (editable) setMaterials(await apiFetch<MaterialOption[]>('/reagent-materials'));
    } catch (err) { toast.error(errorMessage(err, 'The reagent lots of this sample could not be loaded.')); }
  }, [sampleId, editable, toast]);
  useEffect(() => { load(); }, [load]);

  const link = async () => {
    if (!form.resultId || !form.materialId) { toast.error('Choose the result and the lot or solution it was measured with.'); return; }
    const quantity = form.quantity.trim() === '' ? undefined : Number(form.quantity);
    if (quantity !== undefined && !(quantity > 0)) { toast.error('The quantity used must be a number above 0, or left empty.'); return; }
    try {
      await apiFetch(`/samples/${encodeURIComponent(sampleId)}/results/${encodeURIComponent(form.resultId)}/materials`, { body: { materialId: form.materialId, ...(quantity !== undefined ? { quantity } : {}) } });
      toast.success('Lot recorded for the result');
      setForm({ resultId: form.resultId, materialId: '', quantity: '' });
      await load(); onChanged?.();
    } catch (err) { toast.error(errorMessage(err, 'The lot was not recorded.')); }
  };
  const withdraw = (l: MaterialLink) => setAsk({
    title: `Withdraw ${l.label ?? l.materialId} from ${parameters[l.resultId] ?? l.resultId}`,
    submit: async ({ reason }) => {
      try {
        await apiFetch(`/result-materials/${encodeURIComponent(l.id)}/withdraw`, { body: { reason } });
        toast.success('Link withdrawn'); await load(); onChanged?.(); return true;
      } catch (err) { toast.error(errorMessage(err, 'The link was not withdrawn.')); return false; }
    },
  });

  return (
    <div className="mt-6 bg-white border border-slate-200 rounded-xl shadow-sm p-6" data-panel="reagent-lots">
      <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2"><Link2 className="w-4 h-4" /> Reagents, standards and solutions used</h3>
      <MaterialLinkList links={links} parameters={parameters} canWithdraw={editable} onWithdraw={withdraw} />
      {editable && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4 items-end">
          <label className="text-xs text-slate-600">Result
            <select className={input} value={form.resultId} onChange={e => setForm({ ...form, resultId: e.target.value })}>
              <option value="">Choose a result...</option>
              {results.map(r => <option key={r.id} value={r.id}>{r.parameter}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600 md:col-span-2">Lot or solution
            <MaterialSelect materials={materials} value={form.materialId} onChange={v => setForm({ ...form, materialId: v })} />
          </label>
          <label className="text-xs text-slate-600">Quantity used (optional)
            <input className={input} inputMode="decimal" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} />
          </label>
          <div className="md:col-span-4"><button type="button" className={primary} onClick={link}>Record lot for result</button></div>
        </div>
      )}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}

type Tab = 'lots' | 'solutions' | 'items' | 'legacy';
type Signing = { action: 'receive' } | { action: 'release' | 'reject' | 'retest'; lot: LotRow };

const emptyReceipt = { itemId: '', lotNumber: '', supplier: '', quantity: '', expiryDate: '', retestDate: '', potency: '', potencyBasis: '', coaReference: '', storageLocation: '' };
const emptyItem = { code: '', name: '', category: 'Reagent', unit: 'mL', grade: '', storageCondition: '', inUseShelfLifeDays: '', requiresPotency: false };
const emptySolution = { name: '', concentration: '', preparation: '', quantity: '', unit: 'mL', expiryDate: '', storageCondition: '', components: [{ materialId: '', quantity: '' }] };

export function Reagents({ token, user }: { token: string, user: any }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('lots');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [solutions, setSolutions] = useState<SolutionRow[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [legacy, setLegacy] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | undefined>();
  const [signing, setSigning] = useState<Signing | null>(null);
  const [receipt, setReceipt] = useState({ ...emptyReceipt });
  const [retestDate, setRetestDate] = useState('');
  const [item, setItem] = useState<typeof emptyItem | null>(null);
  const [solution, setSolution] = useState<typeof emptySolution | null>(null);
  const [trace, setTrace] = useState<any | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const me = { id: user?.id ?? '' };
  const perms = { approve: permissions.includes('reagent.approve'), use: permissions.includes('reagent.use'), manage: permissions.includes('reagent.manage'), receive: permissions.includes('reagent.receive') };

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);
  const load = useCallback(async () => {
    try {
      const [l, i, s, m, g] = await Promise.all([
        apiFetch<LotRow[]>('/reagent-lots'), apiFetch<ItemRow[]>('/reagent-items'), apiFetch<SolutionRow[]>('/prepared-solutions'),
        apiFetch<MaterialOption[]>('/reagent-materials'), apiFetch<any[]>('/reagents'),
      ]);
      setLots(l); setItems(i); setSolutions(s); setMaterials(m); setLegacy(g);
    } catch (err) { fail(err, 'The reagent inventory could not be loaded.'); }
  }, [fail]);
  useEffect(() => {
    load();
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
  }, [token, load, fail]);

  const run = async (done: string, call: () => Promise<unknown>) => {
    try { await call(); toast.success(done); await load(); return true; } catch (err) { fail(err, 'The action was not recorded.'); return false; }
  };
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const lot = lots.find(l => l.id === selected);

  // A signed step: on a refusal the dialog stays open and shows the server's message (onSign throws).
  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, ...(totpCode ? { totpCode } : {}) };
    try {
      if (signing.action === 'receive') {
        const body: Record<string, unknown> = { itemId: receipt.itemId, lotNumber: receipt.lotNumber, supplier: receipt.supplier, quantity: num(receipt.quantity), expiryDate: receipt.expiryDate, ...cred };
        for (const k of ['retestDate', 'coaReference', 'storageLocation', 'potencyBasis'] as const) if (receipt[k]) body[k] = receipt[k];
        if (receipt.potency) body.potency = num(receipt.potency);
        await apiFetch('/reagent-lots', { body });
        toast.success('Lot received into quarantine and signed'); setReceipt({ ...emptyReceipt });
      } else {
        const body: Record<string, unknown> = { expectedVersion: signing.lot.version, ...cred, ...(reason ? { reason } : {}) };
        if (signing.action === 'retest') body.retestDate = retestDate;
        await apiFetch(`/reagent-lots/${encodeURIComponent(signing.lot.id)}/${signing.action}`, { body });
        toast.success(signing.action === 'release' ? 'Lot released for use' : signing.action === 'reject' ? 'Lot rejected' : 'Retest recorded');
      }
      setSigning(null); await load();
    } catch (err) {
      const message = errorMessage(err, 'The signature was not recorded.');
      toast.error(message);
      throw new Error(message);
    }
  };

  const act = async (action: LotAction, l: LotRow) => {
    if (SIGNED[action]) { setRetestDate(''); setSigning({ action: action as 'release' | 'reject' | 'retest', lot: l }); return; }
    if (action === 'traceback') {
      try { setTrace(await apiFetch(`/reagent-lots/${encodeURIComponent(l.id)}/traceback`)); } catch (err) { fail(err, 'The traceback could not be loaded.'); }
      return;
    }
    if (action === 'open') { await run(`Lot ${l.id} opened`, () => apiFetch(`/reagent-lots/${encodeURIComponent(l.id)}/open`, { body: { expectedVersion: l.version } })); return; }
    if (action === 'consume') {
      setAsk({ title: `Consumption from ${l.id} (${l.balance} ${l.unit} left): what it was used for`, quantityUnit: l.unit,
        submit: ({ quantity, reason }) => run('Consumption recorded', () => apiFetch(`/reagent-lots/${encodeURIComponent(l.id)}/consume`, { body: { quantity, reason } })) });
      return;
    }
    if (action === 'dispose') {
      setAsk({ title: `Dispose of ${l.id}: the remaining ${l.balance} ${l.unit} is written off`,
        submit: ({ reason }) => run(`Lot ${l.id} disposed of`, () => apiFetch(`/reagent-lots/${encodeURIComponent(l.id)}/dispose`, { body: { expectedVersion: l.version, reason } })) });
    }
  };

  const saveItem = async () => {
    if (!item) return;
    const body: Record<string, unknown> = { code: item.code, name: item.name, category: item.category, unit: item.unit, requiresPotency: item.requiresPotency };
    if (item.grade) body.grade = item.grade;
    if (item.storageCondition) body.storageCondition = item.storageCondition;
    if (item.inUseShelfLifeDays) body.inUseShelfLifeDays = Number(item.inUseShelfLifeDays);
    if (await run(`Item ${item.code} defined`, () => apiFetch('/reagent-items', { body }))) setItem(null);
  };
  const saveSolution = async () => {
    if (!solution) return;
    const body: Record<string, unknown> = {
      name: solution.name, preparation: solution.preparation, quantity: num(solution.quantity), unit: solution.unit, expiryDate: solution.expiryDate,
      components: solution.components.filter(c => c.materialId).map(c => ({ materialId: c.materialId, quantity: num(c.quantity) })),
    };
    if (solution.concentration) body.concentration = solution.concentration;
    if (solution.storageCondition) body.storageCondition = solution.storageCondition;
    if (await run('Solution prepared', () => apiFetch('/prepared-solutions', { body }))) setSolution(null);
  };
  const discard = (s: SolutionRow) => setAsk({ title: `Discard ${s.id} (${s.name})`,
    submit: ({ reason }) => run(`Solution ${s.id} discarded`, () => apiFetch(`/prepared-solutions/${encodeURIComponent(s.id)}/discard`, { body: { expectedVersion: s.version, reason } })) });

  const q = search.toLowerCase();
  const shownLots = lots.filter(l => !q || [l.id, l.itemName, l.itemCode, l.lotNumber, l.supplier].some(v => v.toLowerCase().includes(q)));
  const activeItems = items.filter(i => i.status === 'Active');
  const receiptItem = items.find(i => i.id === receipt.itemId);
  const tabButton = (t: Tab, label: string) =>
    <button type="button" className={`px-3 py-2 text-sm font-medium border-b-2 ${tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500'}`} onClick={() => setTab(t)}>{label}</button>;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <FlaskConical className="w-8 h-8 text-indigo-600" /> Reagents & Standards
          </h2>
          <p className="text-slate-500 mt-1">Lots from receipt to quarantine release, opening, consumption and expiry; prepared solutions; what each result was measured with.</p>
        </div>
        <div className="flex gap-2">
          {perms.receive && <button type="button" className={primary + ' flex items-center gap-2'} onClick={() => setSigning({ action: 'receive' })}><PackagePlus className="w-4 h-4" /> Receive lot</button>}
          {perms.use && <button type="button" className={button + ' flex items-center gap-2'} onClick={() => setSolution({ ...emptySolution, components: [{ materialId: '', quantity: '' }] })}><Beaker className="w-4 h-4" /> Prepare solution</button>}
          {perms.manage && <button type="button" className={button} onClick={() => setItem({ ...emptyItem })}>New item</button>}
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 mb-4">
        {tabButton('lots', `Lots (${lots.length})`)}{tabButton('solutions', `Solutions (${solutions.length})`)}{tabButton('items', `Items (${items.length})`)}{tabButton('legacy', 'Legacy register')}
      </div>

      {tab === 'lots' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/50 relative max-w-md">
            <Search className="w-5 h-5 absolute start-7 top-6 text-slate-400" />
            <input type="text" placeholder="Search by lot, item or supplier lot..." className={input + ' ps-10'} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <LotTable lots={shownLots} selected={selected} onSelect={setSelected} />
          {lot && (
            <div className="border-t border-slate-200 p-4 bg-slate-50/50">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-mono font-bold">{lot.id}</span><LotStatus status={lot.status} />
                <span className="text-sm text-slate-600">received {lot.receivedQuantity} {lot.unit}, expiry {lot.expiryDate}{lot.potency !== null ? `, potency ${lot.potency} % (${lot.potencyBasis})` : ''}{lot.coaReference ? `, CoA ${lot.coaReference}` : ''}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {lotActions(lot, me, perms).map(a => <button key={a} type="button" className={SIGNED[a] ? primary : button} onClick={() => act(a, lot)}>{ACTION_LABEL[a]}</button>)}
              </div>
              {lot.receivedBy === me.id && lot.status === 'Quarantine' && <p className="text-xs text-slate-500 mt-2">You received this lot: another person releases it.</p>}
            </div>
          )}
          {trace && (
            <div className="border-t border-slate-200 p-4">
              <h4 className="font-semibold text-sm mb-2">Traceback of {trace.material?.label}</h4>
              {trace.solutions.length > 0 && <p className="text-xs text-slate-600 mb-2">Through solutions: {trace.solutions.map((s: any) => `${s.id} (${s.name})`).join(', ')}</p>}
              {trace.results.length === 0 ? <p className="text-sm text-slate-500">No result was measured with it.</p> : (
                <table className="w-full text-sm"><tbody>
                  {trace.results.map((r: any) => <tr key={r.linkId} className={`border-t border-slate-100 ${r.withdrawnAt ? 'line-through text-slate-400' : ''}`}>
                    <td className="p-1 font-mono"><a className="hover:underline" href={`#/samples/${encodeURIComponent(r.sampleId)}`}>{r.sampleId}</a></td>
                    <td className="p-1">{r.parameter}</td><td className="p-1">{r.value ?? ''}</td><td className="p-1">{r.sampleState}</td><td className="p-1 font-mono text-xs">{r.materialId}</td></tr>)}
                </tbody></table>
              )}
              {trace.truncated && <p className="text-xs text-amber-700 mt-1">Only the latest 5000 results are listed.</p>}
              <button type="button" className={button + ' mt-2'} onClick={() => setTrace(null)}>Close</button>
            </div>
          )}
        </div>
      )}

      {tab === 'solutions' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {solutions.length === 0 ? <p className="text-sm text-slate-500 p-4">No solutions prepared yet.</p> : (
            <table className="w-full text-sm">
              <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Solution</th><th className="p-2">Name</th><th className="p-2">Status</th><th className="p-2">Expiry</th><th className="p-2">Balance</th><th className="p-2">For results</th><th className="p-2" /></tr></thead>
              <tbody>{solutions.map(s => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="p-2 font-mono">{s.id}</td><td className="p-2">{s.name}{s.concentration ? <span className="text-xs text-slate-400 ms-1">{s.concentration}</span> : null}</td>
                  <td className="p-2"><LotStatus status={s.status} /></td><td className="p-2">{s.expiryDate}</td><td className="p-2">{s.balance} {s.unit}</td>
                  <td className="p-2 text-xs">{s.usable ? <span className="text-emerald-700 font-semibold">Usable</span> : <span className="text-red-700">{s.blockedReason}</span>}</td>
                  <td className="p-2 text-end">{perms.use && s.status === 'Active' && <button type="button" className={button} onClick={() => discard(s)}>Discard</button>}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'items' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {items.length === 0 ? <p className="text-sm text-slate-500 p-4">No items defined yet. An item is defined once (code, unit, in-use shelf life); its lots are received against it.</p> : (
            <table className="w-full text-sm">
              <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2">Category</th><th className="p-2">Unit</th><th className="p-2">In-use shelf life</th><th className="p-2">Potency at receipt</th><th className="p-2">Status</th></tr></thead>
              <tbody>{items.map(i => (
                <tr key={i.id} className="border-t border-slate-100"><td className="p-2 font-mono">{i.code}</td><td className="p-2">{i.name}{i.grade ? <span className="text-xs text-slate-400 ms-1">{i.grade}</span> : null}</td>
                  <td className="p-2">{i.category}</td><td className="p-2">{i.unit}</td><td className="p-2">{i.inUseShelfLifeDays ? `${i.inUseShelfLifeDays} days` : 'until expiry'}</td>
                  <td className="p-2">{i.requiresPotency ? 'required' : ''}</td><td className="p-2">{i.status}</td></tr>))}</tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'legacy' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <p className="text-xs text-slate-500 p-4 border-b border-slate-100">The register of earlier versions (read only). Its entries were received without quarantine release and cannot be recorded on results; receive the material as a lot to use it.</p>
          {legacy.length === 0 ? <p className="text-sm text-slate-500 p-4">No legacy entries.</p> : (
            <table className="w-full text-sm"><thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">ID</th><th className="p-2">Name</th><th className="p-2">Lot</th><th className="p-2">Expiry</th><th className="p-2">Quantity</th></tr></thead>
              <tbody>{legacy.map(r => <tr key={r.id} className="border-t border-slate-100"><td className="p-2 font-mono">{r.id}</td><td className="p-2">{r.name}</td><td className="p-2 font-mono">{r.lotNumber}</td><td className="p-2">{String(r.expiryDate).slice(0, 10)}</td><td className="p-2">{r.quantity}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}

      {item && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-40">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg space-y-3">
            <h3 className="font-bold">New reagent item</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs">Code<input className={input} value={item.code} onChange={e => setItem({ ...item, code: e.target.value })} /></label>
              <label className="text-xs">Name<input className={input} value={item.name} onChange={e => setItem({ ...item, name: e.target.value })} /></label>
              <label className="text-xs">Category<select className={input} value={item.category} onChange={e => setItem({ ...item, category: e.target.value, requiresPotency: e.target.value === 'ReferenceStandard' || item.requiresPotency })}>
                {['Reagent', 'ReferenceStandard', 'WorkingStandard', 'Solvent', 'Medium', 'Other'].map(c => <option key={c}>{c}</option>)}</select></label>
              <label className="text-xs">Unit<input className={input} value={item.unit} onChange={e => setItem({ ...item, unit: e.target.value })} /></label>
              <label className="text-xs">Grade<input className={input} value={item.grade} onChange={e => setItem({ ...item, grade: e.target.value })} /></label>
              <label className="text-xs">Storage<input className={input} value={item.storageCondition} onChange={e => setItem({ ...item, storageCondition: e.target.value })} /></label>
              <label className="text-xs">In-use shelf life (days after opening)<input className={input} inputMode="numeric" value={item.inUseShelfLifeDays} onChange={e => setItem({ ...item, inUseShelfLifeDays: e.target.value })} /></label>
              <label className="text-xs flex items-center gap-2 mt-5"><input type="checkbox" checked={item.requiresPotency} onChange={e => setItem({ ...item, requiresPotency: e.target.checked })} /> Potency required at receipt</label>
            </div>
            <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setItem(null)}>Cancel</button><button type="button" className={primary} onClick={saveItem}>Save</button></div>
          </div>
        </div>
      )}

      {solution && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-40">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl space-y-3 max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold">Prepare a solution</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs">Name<input className={input} value={solution.name} onChange={e => setSolution({ ...solution, name: e.target.value })} /></label>
              <label className="text-xs">Concentration<input className={input} value={solution.concentration} onChange={e => setSolution({ ...solution, concentration: e.target.value })} /></label>
              <label className="text-xs">Quantity prepared<input className={input} inputMode="decimal" value={solution.quantity} onChange={e => setSolution({ ...solution, quantity: e.target.value })} /></label>
              <label className="text-xs">Unit<input className={input} value={solution.unit} onChange={e => setSolution({ ...solution, unit: e.target.value })} /></label>
              <label className="text-xs">Expiry date (not after any component's)<input type="date" className={input} value={solution.expiryDate} onChange={e => setSolution({ ...solution, expiryDate: e.target.value })} /></label>
              <label className="text-xs">Storage<input className={input} value={solution.storageCondition} onChange={e => setSolution({ ...solution, storageCondition: e.target.value })} /></label>
            </div>
            <label className="text-xs block">Preparation (procedure and what was done)<textarea className={input} rows={3} value={solution.preparation} onChange={e => setSolution({ ...solution, preparation: e.target.value })} /></label>
            <div className="space-y-2">
              <div className="text-xs font-semibold">Made from</div>
              {solution.components.map((c, i) => (
                <div key={i} className="grid grid-cols-3 gap-2">
                  <div className="col-span-2"><MaterialSelect materials={materials} value={c.materialId} onChange={v => setSolution({ ...solution, components: solution.components.map((x, j) => (j === i ? { ...x, materialId: v } : x)) })} /></div>
                  <input className={input} placeholder="quantity" inputMode="decimal" value={c.quantity} onChange={e => setSolution({ ...solution, components: solution.components.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
                </div>
              ))}
              <button type="button" className={button} onClick={() => setSolution({ ...solution, components: [...solution.components, { materialId: '', quantity: '' }] })}>Add component</button>
            </div>
            <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setSolution(null)}>Cancel</button><button type="button" className={primary} onClick={saveSolution}>Prepare</button></div>
          </div>
        </div>
      )}

      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode={signing.action === 'receive' ? 'RECEIPT' : SIGNED[signing.action]}
          action={signing.action}
          entityName={signing.action === 'receive' ? 'Reagent lot receipt' : `Reagent lot ${signing.lot.id}`}
          recordVersion={signing.action === 'receive' ? undefined : signing.lot.version}
          onClose={() => setSigning(null)}
          onSign={sign}
        >
          {signing.action === 'receive' ? (
            <div className="grid grid-cols-2 gap-3 mb-4">
              <label className="text-xs col-span-2">Item<select className={input} value={receipt.itemId} onChange={e => setReceipt({ ...receipt, itemId: e.target.value })}>
                <option value="">Choose the item...</option>{activeItems.map(i => <option key={i.id} value={i.id}>{i.code} {i.name} ({i.unit})</option>)}</select></label>
              <label className="text-xs">Supplier lot number<input className={input + ' font-mono'} value={receipt.lotNumber} onChange={e => setReceipt({ ...receipt, lotNumber: e.target.value })} /></label>
              <label className="text-xs">Supplier<input className={input} value={receipt.supplier} onChange={e => setReceipt({ ...receipt, supplier: e.target.value })} /></label>
              <label className="text-xs">Quantity received{receiptItem ? ` (${receiptItem.unit})` : ''}<input className={input} inputMode="decimal" value={receipt.quantity} onChange={e => setReceipt({ ...receipt, quantity: e.target.value })} /></label>
              <label className="text-xs">Expiry date<input type="date" className={input} value={receipt.expiryDate} onChange={e => setReceipt({ ...receipt, expiryDate: e.target.value })} /></label>
              <label className="text-xs">Retest date (optional)<input type="date" className={input} value={receipt.retestDate} onChange={e => setReceipt({ ...receipt, retestDate: e.target.value })} /></label>
              <label className="text-xs">CoA reference<input className={input} value={receipt.coaReference} onChange={e => setReceipt({ ...receipt, coaReference: e.target.value })} /></label>
              <label className="text-xs">Potency (%){receiptItem?.requiresPotency ? ' - required' : ''}<input className={input} inputMode="decimal" value={receipt.potency} onChange={e => setReceipt({ ...receipt, potency: e.target.value })} /></label>
              <label className="text-xs">Potency basis<select className={input} value={receipt.potencyBasis} onChange={e => setReceipt({ ...receipt, potencyBasis: e.target.value })}>
                <option value="">-</option>{['As is', 'Dried basis', 'Anhydrous basis', 'Solvent-free basis'].map(b => <option key={b}>{b}</option>)}</select></label>
              <label className="text-xs col-span-2">Storage location<input className={input} value={receipt.storageLocation} onChange={e => setReceipt({ ...receipt, storageLocation: e.target.value })} /></label>
              <p className="text-xs text-slate-500 col-span-2 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> The lot goes into Quarantine; another person releases it.</p>
            </div>
          ) : signing.action === 'retest' ? (
            <label className="text-xs block mb-4">New retest date (after today, not after expiry {signing.lot.expiryDate})<input type="date" className={input} value={retestDate} onChange={e => setRetestDate(e.target.value)} /></label>
          ) : null}
        </ElectronicSignatureModal>
      )}
    </div>
  );
}
