// Sample registration from master data (roadmap M17, r2-master-data): pick the product, then one of its batches (and, optionally,
// the customer). The specification revision in force for the product is shown before anything is registered. The server fills
// the sample's material and batch text from the master rows (POST /api/batches/:id/samples); nothing is typed free-hand.
import React, { useEffect, useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage } from '../lib/api';

export interface ProductOption { id: string; code: string; name: string; status: string }
export interface BatchOption { id: string; batchNo: string; status: string; manufacturedOn: string | null; expiresOn: string | null }
export interface CustomerOption { id: string; code: string; name: string; status: string }
export interface ActiveSpecView { id: string; revision: number; effectiveDate: string; parameters: string[] }

/** The batch statuses a sample may be registered against (the server decides again). */
export const REGISTRABLE_BATCH_STATUSES = ['Quarantine', 'Released'] as const;
export const registrableBatches = (batches: readonly BatchOption[]) => batches.filter(b => (REGISTRABLE_BATCH_STATUSES as readonly string[]).includes(b.status));

export interface RegisterSampleFormProps {
  products: readonly ProductOption[];
  customers: readonly CustomerOption[];
  productId: string;
  batches: readonly BatchOption[];
  batchId: string;
  customerId: string;
  /** undefined: not loaded yet; null: no revision in force. */
  activeSpec: ActiveSpecView | null | undefined;
  submitting?: boolean;
  onProduct: (id: string) => void;
  onBatch: (id: string) => void;
  onCustomer: (id: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/** The form itself, without data loading (rendered on its own by tests/api/master-ui.test.ts). */
export function RegisterSampleForm(p: RegisterSampleFormProps) {
  const product = p.products.find(x => x.id === p.productId);
  const offered = registrableBatches(p.batches);
  const batch = offered.find(b => b.id === p.batchId);
  const ready = !!product && !!batch && !!p.activeSpec && !p.submitting;
  const field = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (ready) p.onSubmit(); }}
      className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4"
      aria-label="Register sample from master data"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><FlaskConical className="w-5 h-5 text-blue-600" /> Register sample</h2>
        <button type="button" onClick={p.onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        Product
        <select aria-label="Product" value={p.productId} onChange={e => p.onProduct(e.target.value)} className={field} required>
          <option value="">Select a product</option>
          {p.products.filter(x => x.status === 'Active').map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}
        </select>
      </label>

      <label className="block text-sm font-medium text-slate-700">
        Batch
        <select aria-label="Batch" value={p.batchId} onChange={e => p.onBatch(e.target.value)} className={field} required disabled={!product}>
          <option value="">{product ? (offered.length ? 'Select a batch' : 'This product has no batch in Quarantine or Released') : 'Select the product first'}</option>
          {offered.map(b => (
            <option key={b.id} value={b.id}>{b.batchNo} ({b.status}{b.expiresOn ? `, expires ${b.expiresOn}` : ''})</option>
          ))}
        </select>
      </label>

      <label className="block text-sm font-medium text-slate-700">
        Customer (optional)
        <select aria-label="Customer" value={p.customerId} onChange={e => p.onCustomer(e.target.value)} className={field}>
          <option value="">None</option>
          {p.customers.filter(c => c.status === 'Active').map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
        </select>
      </label>

      {product && p.activeSpec === null && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          No Active specification is in force for {product.name}. A sample cannot be registered until a specification is approved.
        </p>
      )}
      {product && p.activeSpec && (
        <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3">
          Tested against specification {p.activeSpec.id}, Rev {p.activeSpec.revision} (effective {p.activeSpec.effectiveDate}):{' '}
          {p.activeSpec.parameters.join(', ')}.
        </div>
      )}
      {product && batch && (
        <p className="text-xs text-slate-500">The sample is recorded as material “{product.name}”, batch “{batch.batchNo}”.</p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={p.onClose} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700">Cancel</button>
        <button type="submit" disabled={!ready} className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50">
          {p.submitting ? 'Registering…' : 'Register sample'}
        </button>
      </div>
    </form>
  );
}

export interface RegisterSampleDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onRegistered?: (sample: { id: string; material: string; batch: string; version: number }) => void;
}

export function RegisterSampleDialog({ isOpen, onClose, onRegistered }: RegisterSampleDialogProps) {
  const { toast } = useToast();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [productId, setProductId] = useState('');
  const [batches, setBatches] = useState<BatchOption[]>([]);
  const [batchId, setBatchId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [activeSpec, setActiveSpec] = useState<ActiveSpecView | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    Promise.all([apiFetch<ProductOption[]>('/products'), apiFetch<CustomerOption[]>('/customers')])
      .then(([p, c]) => { setProducts(p); setCustomers(c); })
      .catch(err => toast.error(errorMessage(err, 'The products and customers could not be loaded.')));
  }, [isOpen, toast]);

  const chooseProduct = async (id: string) => {
    setProductId(id); setBatchId(''); setBatches([]); setActiveSpec(undefined);
    if (!id) return;
    try {
      const detail = await apiFetch<{ batches: BatchOption[]; activeSpec: ActiveSpecView | null }>(`/products/${encodeURIComponent(id)}`);
      setBatches(detail.batches);
      setActiveSpec(detail.activeSpec);
    } catch (err) { toast.error(errorMessage(err, 'The batches of this product could not be loaded.')); }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ sample: { id: string; material: string; batch: string; version: number } }>(
        `/batches/${encodeURIComponent(batchId)}/samples`, { method: 'POST', body: customerId ? { customerId } : {}, replay: 'never' });
      toast.success(`Sample ${res.sample.id} registered for ${res.sample.material}, batch ${res.sample.batch} (audit logged).`);
      onRegistered?.(res.sample);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'The sample could not be registered.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <RegisterSampleForm
        products={products} customers={customers} productId={productId} batches={batches} batchId={batchId} customerId={customerId}
        activeSpec={activeSpec} submitting={submitting}
        onProduct={chooseProduct} onBatch={setBatchId} onCustomer={setCustomerId} onSubmit={submit} onClose={onClose}
      />
    </div>
  );
}
