// Master data screen (roadmap M17, r2-master-data): products, their batches, and customers.
// Creating and editing needs master.manage; a status change of a product or a batch is an e-signature (MASTER_DATA_STATUS) and needs
// master.status. What the user may do comes from GET /permissions/me; the server decides again on every call.
import React, { useCallback, useEffect, useState } from 'react';
import { Boxes, Building2, Package, Plus } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

export interface ProductRow { id: string; code: string; name: string; description: string | null; status: string; origin: string; version: number }
export interface BatchRow {
  id: string; productId: string; productName: string; batchNo: string; status: string; manufacturedOn: string | null; expiresOn: string | null;
  batchSize: string | null; origin: string; version: number;
}
export interface CustomerRow { id: string; code: string; name: string; contact: string | null; status: string; version: number }

/** The status moves the server allows from each batch status (src/server/routes/batches.ts). Released needs the formal release first. */
export function nextBatchStatuses(status: string): string[] {
  return ({ Quarantine: ['Released', 'Rejected'], Released: ['Recalled'] } as Record<string, string[]>)[status] ?? [];
}

const STATUS_STYLE: Record<string, string> = {
  Active: 'bg-emerald-50 text-emerald-700', Inactive: 'bg-slate-100 text-slate-600', Quarantine: 'bg-amber-50 text-amber-700',
  Released: 'bg-emerald-50 text-emerald-700', Rejected: 'bg-red-50 text-red-700', Recalled: 'bg-red-50 text-red-700',
};
export const StatusBadge = ({ status }: { status: string }) => (
  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_STYLE[status] ?? 'bg-slate-100 text-slate-600'}`}>{status}</span>
);

/** The batch table (rendered on its own by tests/api/master-ui.test.ts). */
export function BatchTable({ batches, canSign, onStatus }: { batches: readonly BatchRow[]; canSign: boolean; onStatus: (b: BatchRow, to: string) => void }) {
  if (batches.length === 0) return <p className="text-sm text-slate-500 p-4">No batches yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Batch</th><th className="p-2">Product</th><th className="p-2">Status</th><th className="p-2">Manufactured</th><th className="p-2">Expires</th><th className="p-2">Size</th><th className="p-2" /></tr>
      </thead>
      <tbody>
        {batches.map(b => (
          <tr key={b.id} className="border-t border-slate-100">
            <td className="p-2 font-mono">{b.batchNo}</td>
            <td className="p-2">{b.productName}</td>
            <td className="p-2"><StatusBadge status={b.status} /></td>
            <td className="p-2">{b.manufacturedOn ?? 'not recorded'}</td>
            <td className="p-2">{b.expiresOn ?? 'not recorded'}</td>
            <td className="p-2">{b.batchSize ?? 'not recorded'}</td>
            <td className="p-2 text-end space-x-1">
              {canSign && nextBatchStatuses(b.status).map(to => (
                <button key={to} type="button" onClick={() => onStatus(b, to)} className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50">{to}</button>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Signing = { kind: 'product' | 'batch'; id: string; name: string; to: string; version: number };
const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';

export function MasterData({ token, user }: { token?: string; user: any }) {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [newProduct, setNewProduct] = useState({ code: '', name: '', description: '' });
  const [newBatch, setNewBatch] = useState({ productId: '', batchNo: '', manufacturedOn: '', expiresOn: '', batchSize: '' });
  const [newCustomer, setNewCustomer] = useState({ code: '', name: '', contact: '' });
  const [customerChange, setCustomerChange] = useState<{ c: CustomerRow; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, b, c] = await Promise.all([apiFetch<ProductRow[]>('/products'), apiFetch<BatchRow[]>('/batches'), apiFetch<CustomerRow[]>('/customers')]);
      setProducts(p); setBatches(b); setCustomers(c);
    } catch (err) { toast.error(errorMessage(err, 'The master data could not be loaded.')); }
  }, [toast]);

  useEffect(() => {
    load();
    apiFetch<{ permissions: string[] }>('/permissions/me')
      .then(me => setPermissions(me.permissions))
      .catch(err => toast.error(errorMessage(err, 'Your permissions could not be loaded; actions are hidden.')));
  }, [load, toast]);

  const canManage = permissions.includes('master.manage');
  const canSign = permissions.includes('master.status');
  const optional = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== ''));

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await apiFetch<ProductRow>('/products', { method: 'POST', body: optional(newProduct) });
      toast.success(`Product ${p.name} created (audit logged).`);
      setNewProduct({ code: '', name: '', description: '' });
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const createBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const b = await apiFetch<BatchRow>('/batches', { method: 'POST', body: optional(newBatch) });
      toast.success(`Batch ${b.batchNo} created in Quarantine (audit logged).`);
      setNewBatch({ productId: newBatch.productId, batchNo: '', manufacturedOn: '', expiresOn: '', batchSize: '' });
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const createCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await apiFetch<CustomerRow>('/customers', { method: 'POST', body: optional(newCustomer) });
      toast.success(`Customer ${c.name} created (audit logged).`);
      setNewCustomer({ code: '', name: '', contact: '' });
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const changeCustomerStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerChange) return;
    const { c, reason } = customerChange;
    try {
      await apiFetch(`/customers/${c.id}/status`, { method: 'POST', body: { status: c.status === 'Active' ? 'Inactive' : 'Active', reason, expectedVersion: c.version }, replay: 'never' });
      toast.success(`Customer ${c.name} is now ${c.status === 'Active' ? 'Inactive' : 'Active'}.`);
      setCustomerChange(null);
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const body: Record<string, unknown> = { status: signing.to, expectedVersion: signing.version, password, reason: reason?.trim() ?? '' };
    if (totpCode) body.totpCode = totpCode;
    try {
      await apiFetch(`/${signing.kind === 'product' ? 'products' : 'batches'}/${signing.id}/status`, { method: 'POST', body, replay: 'never' });
      toast.success(`${signing.name} is now ${signing.to}. Electronic signature applied.`);
      setSigning(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
      throw err; // the signature dialog shows it too and clears the password
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h1 className="text-2xl font-extrabold text-slate-900 flex items-center gap-2"><Boxes className="w-6 h-6 text-blue-600" /> Master data</h1>
        <p className="text-xs text-slate-500 mt-1">Products, batches and customers that samples, specifications and certificates refer to. Every change is audited; status changes are signed.</p>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3" aria-label="Products">
        <h2 className="font-bold text-slate-800 flex items-center gap-2"><Package className="w-4 h-4" /> Products</h2>
        {canManage && (
          <form onSubmit={createProduct} className="flex flex-wrap gap-2">
            <input aria-label="Product code" placeholder="Code" required value={newProduct.code} onChange={e => setNewProduct({ ...newProduct, code: e.target.value })} className={input} />
            <input aria-label="Product name" placeholder="Name (as in the specification)" required value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })} className={`${input} flex-1`} />
            <input aria-label="Description" placeholder="Description" value={newProduct.description} onChange={e => setNewProduct({ ...newProduct, description: e.target.value })} className={`${input} flex-1`} />
            <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold flex items-center gap-1"><Plus className="w-4 h-4" /> Add product</button>
          </form>
        )}
        <table className="w-full text-sm">
          <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2">Status</th><th className="p-2" /></tr></thead>
          <tbody>
            {products.map(p => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="p-2 font-mono">{p.code}</td>
                <td className="p-2">{p.name}{p.origin === 'migration' && <span className="ms-2 text-xs text-slate-400">(from existing records)</span>}</td>
                <td className="p-2"><StatusBadge status={p.status} /></td>
                <td className="p-2 text-end">
                  {canSign && (
                    <button type="button" onClick={() => setSigning({ kind: 'product', id: p.id, name: p.name, to: p.status === 'Active' ? 'Inactive' : 'Active', version: p.version })} className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50">
                      {p.status === 'Active' ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3" aria-label="Batches">
        <h2 className="font-bold text-slate-800 flex items-center gap-2"><Boxes className="w-4 h-4" /> Batches</h2>
        {canManage && (
          <form onSubmit={createBatch} className="flex flex-wrap gap-2">
            <select aria-label="Batch product" required value={newBatch.productId} onChange={e => setNewBatch({ ...newBatch, productId: e.target.value })} className={input}>
              <option value="">Product</option>
              {products.filter(p => p.status === 'Active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="Batch number" placeholder="Batch number" required value={newBatch.batchNo} onChange={e => setNewBatch({ ...newBatch, batchNo: e.target.value })} className={input} />
            <label className="text-xs text-slate-600 flex items-center gap-1">Manufactured <input type="date" aria-label="Manufacturing date" value={newBatch.manufacturedOn} onChange={e => setNewBatch({ ...newBatch, manufacturedOn: e.target.value })} className={input} /></label>
            <label className="text-xs text-slate-600 flex items-center gap-1">Expires <input type="date" aria-label="Expiry date" value={newBatch.expiresOn} onChange={e => setNewBatch({ ...newBatch, expiresOn: e.target.value })} className={input} /></label>
            <input aria-label="Batch size" placeholder="Batch size" value={newBatch.batchSize} onChange={e => setNewBatch({ ...newBatch, batchSize: e.target.value })} className={input} />
            <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold flex items-center gap-1"><Plus className="w-4 h-4" /> Add batch</button>
          </form>
        )}
        <BatchTable batches={batches} canSign={canSign} onStatus={(b, to) => setSigning({ kind: 'batch', id: b.id, name: `Batch ${b.batchNo} of ${b.productName}`, to, version: b.version })} />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3" aria-label="Customers">
        <h2 className="font-bold text-slate-800 flex items-center gap-2"><Building2 className="w-4 h-4" /> Customers</h2>
        {canManage && (
          <form onSubmit={createCustomer} className="flex flex-wrap gap-2">
            <input aria-label="Customer code" placeholder="Code" required value={newCustomer.code} onChange={e => setNewCustomer({ ...newCustomer, code: e.target.value })} className={input} />
            <input aria-label="Customer name" placeholder="Name" required value={newCustomer.name} onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })} className={`${input} flex-1`} />
            <input aria-label="Contact" placeholder="Contact" value={newCustomer.contact} onChange={e => setNewCustomer({ ...newCustomer, contact: e.target.value })} className={`${input} flex-1`} />
            <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold flex items-center gap-1"><Plus className="w-4 h-4" /> Add customer</button>
          </form>
        )}
        <table className="w-full text-sm">
          <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2">Contact</th><th className="p-2">Status</th><th className="p-2" /></tr></thead>
          <tbody>
            {customers.map(c => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="p-2 font-mono">{c.code}</td><td className="p-2">{c.name}</td><td className="p-2">{c.contact ?? ''}</td>
                <td className="p-2"><StatusBadge status={c.status} /></td>
                <td className="p-2 text-end">
                  {canManage && <button type="button" onClick={() => setCustomerChange({ c, reason: '' })} className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50">{c.status === 'Active' ? 'Deactivate' : 'Activate'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {customerChange && (
          <form onSubmit={changeCustomerStatus} className="flex flex-wrap gap-2 items-center border-t border-slate-100 pt-3">
            <span className="text-sm text-slate-700">{customerChange.c.status === 'Active' ? 'Deactivate' : 'Activate'} {customerChange.c.name}: reason</span>
            <input aria-label="Reason" required minLength={5} value={customerChange.reason} onChange={e => setCustomerChange({ ...customerChange, reason: e.target.value })} className={`${input} flex-1`} />
            <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold">Confirm</button>
            <button type="button" onClick={() => setCustomerChange(null)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          </form>
        )}
      </section>

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode="MASTER_DATA_STATUS"
          action="status change"
          entityName={`${signing.name}: ${signing.to}`}
          recordVersion={signing.version}
          requiresReason
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
