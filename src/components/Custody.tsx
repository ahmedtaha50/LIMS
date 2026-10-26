/**
 * Sample custody (roadmap M29): the custody panel of a sample and the custody screen (#/custody).
 *
 *   CustodyPanel    receipt (condition, seal, temperature against the required storage), the receipt deviation and QA's signed
 *                   acknowledgement, the containers and aliquots with their balance, place and holder, the custody ledger, retains
 *                   with their signed disposal, labels. Shown on the sample page.
 *   ScanToOpen      the global wedge-scanner sink, mounted once in the signed-in shell.
 *   CustodyScreen   storage locations, the retain register (disposal due first), the ledger check; #/custody/samples/<id> opens the
 *                   panel of one sample, #/custody/locations/<id> a location.
 *
 * What the user may do comes from GET /permissions/me; the server decides again on every call. Every outcome is a toast or an
 * inline message (no silent failure). Quantities are shown as the server holds them (4 decimals at most).
 */
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, MapPin, Printer, ShieldCheck } from 'lucide-react';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { formatHash } from '../lib/router';
import { useScanToOpen } from '../lib/useScanSink';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { LabelPrint, type LabelEntityType } from './LabelPrint';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { EntityPicker } from './ui/EntityPicker';
import { Field, fieldErrors, inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

// ---- types (the answers of /api/custody) --------------------------------------------------------------------------------------

export interface Receipt {
  sampleId: string; receivedAt: string; receivedBy: string; condition: string; sealIntact: boolean; temperatureC: number | null;
  requiredStorage: string; requiredTempMin: number | null; requiredTempMax: number | null; mfgDate: string | null; expDate: string | null;
  notes: string | null; deviation: boolean; deviationReasons: string | null; deviationAckBy: string | null; deviationAckAt: string | null; version: number;
}
export interface Container {
  id: string; sampleId: string; parentId: string | null; kind: string; quantity: number; unit: string; locationId: string | null;
  holderId: string | null; status: string; version: number; retained?: boolean;
}
export interface LedgerRow {
  id: string; seq: number; containerId: string; eventType: string; qtyDelta: number; balanceAfter: number; unit: string;
  fromLocationId: string | null; toLocationId: string | null; fromHolderId: string | null; toHolderId: string | null;
  relatedContainerId: string | null; reason: string; actorId: string; at: string; hash: string;
}
export interface RetainRow {
  id: string; sampleId: string; containerId: string; retainUntil: string; status: string; due: boolean; version: number;
  disposedBy: string | null; disposedAt: string | null; disposalMethod: string | null; quantity?: number; unit?: string;
}
export interface LocationRow { id: string; code: string; name: string; kind: string; parentId: string | null; tempMin: number | null; tempMax: number | null; status: string; version: number }
interface LabelRow { id: string; entityType: string; entityId: string; isReprint: boolean; reason: string | null; printedAt: string; printedBy: string; copies: number; symbology: string }
export interface SampleCustody {
  sample: { id: string; state: string; material: string; batch: string };
  status: string; receipt: Receipt | null; containers: Container[]; events: LedgerRow[]; retains: RetainRow[]; labels: LabelRow[];
}

const STATUS_TONE: Record<string, Tone> = { 'Not received': 'warning', Received: 'success', 'Deviation: awaiting QA': 'danger', 'Deviation acknowledged': 'info' };
const CONDITIONS = ['Intact', 'Damaged', 'Leaking', 'Contaminated'] as const;
const LOCATION_KINDS = ['Site', 'Building', 'Room', 'Storage unit', 'Shelf', 'Box'] as const;
const range = (min: number | null, max: number | null) => (min == null && max == null ? '—' : `${min ?? '-∞'} to ${max ?? '+∞'} °C`);
const when = (s: string | null) => (s ? formatDateTime(s) : '—');
const num = (v: string) => (v.trim() === '' ? null : Number(v));

function usePermissions() {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[] | null>(null);
  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions))
      .catch(e => { setPermissions([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);
  return (code: Parameters<typeof hasPermission>[1]) => hasPermission(permissions, code);
}

function useLocations() {
  const { toast } = useToast();
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const load = useCallback(() => apiFetch<LocationRow[]>('/custody/locations').then(setLocations)
    .catch(e => toast.error(`The storage locations could not be loaded: ${errorMessage(e)}`)), [toast]);
  useEffect(() => { void load(); }, [load]);
  return { locations, reload: load };
}

function LocationSelect({ locations, value, onChange, id, allowNone = true }: { locations: LocationRow[]; value: string; onChange: (v: string) => void; id?: string; allowNone?: boolean }) {
  return (
    <select id={id} className={inputClass} value={value} onChange={e => onChange(e.target.value)}>
      {allowNone && <option value="">No storage location</option>}
      {locations.filter(l => l.status === 'Active').map(l => <option key={l.id} value={l.id}>{l.code}: {l.name} ({range(l.tempMin, l.tempMax)})</option>)}
    </select>
  );
}

/** Mounted once in the signed-in shell: a wedge scan anywhere opens the record it names (src/lib/useScanSink.ts). */
export function ScanToOpen() {
  const { toast } = useToast();
  useScanToOpen(toast);
  return null;
}

// ---- the custody panel of a sample --------------------------------------------------------------------------------------------

type ContainerAction = { kind: 'aliquot' | 'consume' | 'transfer' | 'retain'; container: Container };

export function CustodyPanel({ sampleId, user, token, onChanged }: { sampleId: string; user: SelfUser; token?: string; onChanged?: () => void }) {
  const { toast } = useToast();
  const can = usePermissions();
  const { locations } = useLocations();
  const [data, setData] = useState<SampleCustody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ContainerAction | null>(null);
  const [signing, setSigning] = useState<{ kind: 'ack' } | { kind: 'dispose'; retain: RetainRow } | null>(null);
  const [disposalMethod, setDisposalMethod] = useState('');
  const [label, setLabel] = useState<{ type: LabelEntityType; id: string } | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiFetch<SampleCustody>(`/custody/samples/${encodeURIComponent(sampleId)}`)); setLoadError(null); }
    catch (e) { setLoadError(errorMessage(e, 'The custody record could not be loaded.')); }
  }, [sampleId]);
  useEffect(() => { void load(); }, [load]);

  const changed = async () => { await load(); onChanged?.(); };
  const locName = useMemo(() => new Map(locations.map(l => [l.id, l.code])), [locations]);

  if (loadError) {
    return (
      <section aria-label="Custody" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800" role="alert">
        {loadError} <Button size="sm" onClick={() => void load()}>Retry</Button>
      </section>
    );
  }
  if (!data) return <section aria-label="Custody" aria-busy="true" className="p-4 text-sm text-slate-600">Loading custody…</section>;

  const r = data.receipt;
  return (
    <section aria-labelledby="custody-title" className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
      <header className="flex flex-wrap items-center gap-2 justify-between">
        <h3 id="custody-title" className="text-base font-bold text-slate-800 flex items-center gap-2"><Boxes className="w-4 h-4" aria-hidden="true" /> Custody</h3>
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[data.status] ?? 'neutral'}>{data.status}</Badge>
          {can('label.print') && <Button size="sm" onClick={() => setLabel({ type: 'Sample', id: sampleId })}><Printer className="w-4 h-4" aria-hidden="true" /> Sample label</Button>}
        </div>
      </header>

      {!r && (can('custody.handle')
        ? <ReceiptForm sampleId={sampleId} locations={locations} onDone={changed} />
        : <p className="text-sm text-amber-800">Not received. Testing cannot start until the receipt is recorded.</p>)}

      {r && (
        <div className="grid gap-2 text-sm">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
            <div><dt className="text-slate-500">Received</dt><dd>{when(r.receivedAt)} by {r.receivedBy}</dd></div>
            <div><dt className="text-slate-500">Condition / seal</dt><dd>{r.condition} / {r.sealIntact ? 'intact' : 'broken'}</dd></div>
            <div><dt className="text-slate-500">Temperature on receipt</dt><dd>{r.temperatureC == null ? 'not measured' : `${r.temperatureC} °C`}</dd></div>
            <div><dt className="text-slate-500">Required storage</dt><dd>{r.requiredStorage} ({range(r.requiredTempMin, r.requiredTempMax)})</dd></div>
            <div><dt className="text-slate-500">Manufactured / expires</dt><dd>{r.mfgDate ?? '—'} / {r.expDate ?? '—'}</dd></div>
            {r.notes && <div className="col-span-2"><dt className="text-slate-500">Notes</dt><dd>{r.notes}</dd></div>}
          </dl>
          {r.deviation && (
            <div role={r.deviationAckAt ? undefined : 'alert'} className={`rounded-lg border p-3 ${r.deviationAckAt ? 'border-slate-300 bg-slate-50' : 'border-red-300 bg-red-50 text-red-900'}`}>
              <p className="font-semibold">Receipt deviation: {r.deviationReasons}</p>
              {r.deviationAckAt
                ? <p>Acknowledged by {r.deviationAckBy} on {when(r.deviationAckAt)} (signed).</p>
                : <p>Testing may not start until QA acknowledges this deviation with an e-signature. {r.receivedBy === user.id ? 'You received the sample, so another person must sign.' : ''}</p>}
              {!r.deviationAckAt && can('custody.approve') && r.receivedBy !== user.id && (
                <Button size="sm" variant="primary" className="mt-2" onClick={() => setSigning({ kind: 'ack' })}><ShieldCheck className="w-4 h-4" aria-hidden="true" /> Acknowledge deviation</Button>
              )}
            </div>
          )}
        </div>
      )}

      {data.containers.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-start font-semibold text-slate-700 pb-1">Containers and aliquots</caption>
            <thead><tr className="text-start text-slate-500 border-b"><th scope="col">Container</th><th scope="col">Kind</th><th scope="col">Balance</th><th scope="col">Location</th><th scope="col">Holder</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.containers.map(c => {
                const usable = c.status === 'Active' && can('custody.handle');
                return (
                  <tr key={c.id} className="border-b last:border-0 align-top">
                    <td className="font-mono py-1">{c.id}</td>
                    <td>{c.kind}{c.parentId ? ` of ${c.parentId}` : ''}</td>
                    <td>{c.quantity} {c.unit}</td>
                    <td>{c.locationId ? locName.get(c.locationId) ?? c.locationId : '—'}</td>
                    <td>{c.holderId ?? '—'}</td>
                    <td>{c.status}{c.retained ? ' · retained' : ''}</td>
                    <td className="flex flex-wrap gap-1 py-1">
                      {usable && !c.retained && c.quantity > 0 && <Button size="sm" onClick={() => setAction({ kind: 'aliquot', container: c })}>Aliquot</Button>}
                      {usable && !c.retained && c.quantity > 0 && <Button size="sm" onClick={() => setAction({ kind: 'consume', container: c })}>Use</Button>}
                      {c.status !== 'Disposed' && can('custody.handle') && <Button size="sm" onClick={() => setAction({ kind: 'transfer', container: c })}>Transfer</Button>}
                      {usable && !c.retained && c.quantity > 0 && !data.retains.some(x => x.containerId === c.id) && <Button size="sm" onClick={() => setAction({ kind: 'retain', container: c })}>Retain</Button>}
                      {can('label.print') && <Button size="sm" onClick={() => setLabel({ type: 'Container', id: c.id })}>Label</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data.retains.length > 0 && (
        <div>
          <h4 className="font-semibold text-slate-700 text-sm">Retains</h4>
          <ul className="text-sm">
            {data.retains.map(x => (
              <li key={x.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{x.id}</span> {x.containerId}, kept until {x.retainUntil} · {x.status}
                {x.status === 'Disposed' ? ` on ${when(x.disposedAt)} by ${x.disposedBy} (${x.disposalMethod})` : x.due ? ' · disposal due' : ''}
                {x.status === 'Retained' && x.due && can('custody.approve') && (
                  <Button size="sm" variant="danger" onClick={() => { setDisposalMethod(''); setSigning({ kind: 'dispose', retain: x }); }}>Dispose…</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">Custody ledger ({data.events.length} entries)</summary>
          <div className="overflow-x-auto">
            <table className="w-full text-xs mt-2">
              <thead><tr className="text-start text-slate-500 border-b"><th scope="col">#</th><th scope="col">When</th><th scope="col">Event</th><th scope="col">Container</th><th scope="col">Change</th><th scope="col">Balance</th><th scope="col">From → to</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {data.events.map(e => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td>{e.seq}</td><td>{when(e.at)}</td><td>{e.eventType}</td><td className="font-mono">{e.containerId}</td>
                    <td>{e.qtyDelta > 0 ? '+' : ''}{e.qtyDelta} {e.unit}</td><td>{e.balanceAfter} {e.unit}</td>
                    <td>{[e.fromLocationId && locName.get(e.fromLocationId), e.fromHolderId].filter(Boolean).join(' / ') || '—'} → {[e.toLocationId && locName.get(e.toLocationId), e.toHolderId].filter(Boolean).join(' / ') || '—'}</td>
                    <td>{e.actorId}</td><td>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {data.labels.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">Label log ({data.labels.length})</summary>
          <ul className="text-xs mt-1">{data.labels.map(l => <li key={l.id}>{l.id} · {l.entityId} · {l.symbology} ×{l.copies} · {when(l.printedAt)} by {l.printedBy}{l.isReprint ? ` · reprint: ${l.reason}` : ''}</li>)}</ul>
        </details>
      )}

      {action && <ContainerActionDialog action={action} locations={locations} onClose={() => setAction(null)} onDone={async () => { setAction(null); await changed(); }} />}

      {label && <LabelPrint open entityType={label.type} entityId={label.id} onClose={() => setLabel(null)} onPrinted={() => void load()} />}

      {signing && r && (
        <ElectronicSignatureModal
          user={{ ...user, email: user.email ?? undefined }}
          token={token}
          meaningCode={signing.kind === 'ack' ? 'CUSTODY_DEVIATION_ACK' : 'RETAIN_DISPOSAL'}
          entityName={signing.kind === 'ack' ? `Receipt of ${sampleId}: ${r.deviationReasons}` : `Retain ${signing.retain.id} (${signing.retain.containerId})`}
          recordVersion={signing.kind === 'ack' ? r.version : signing.retain.version}
          requiresReason
          onClose={() => setSigning(null)}
          onSign={async (password, reason, totpCode) => {
            const creds = { password, ...(totpCode ? { totpCode } : {}), reason: reason ?? '' };
            try {
              if (signing.kind === 'ack') {
                await apiFetch(`/custody/samples/${encodeURIComponent(sampleId)}/receipt/acknowledge`, { method: 'POST', body: { ...creds, expectedVersion: r.version } });
              } else {
                if (disposalMethod.trim().length < 3) throw new Error('Say how the retained sample is disposed of (at least 3 characters).');
                await apiFetch(`/custody/retains/${encodeURIComponent(signing.retain.id)}/dispose`, { method: 'POST', body: { ...creds, method: disposalMethod.trim(), expectedVersion: signing.retain.version } });
              }
            } catch (e) { toast.error(errorMessage(e)); throw e; }
            toast.success(signing.kind === 'ack' ? 'Receipt deviation acknowledged and signed: testing may start' : 'Retained sample disposed of (signed)');
            setSigning(null);
            await changed();
          }}
        >
          {signing.kind === 'dispose' && (
            <Field label="Disposal method" required hint="For example: incineration via the approved waste contractor">{p => (
              <input {...p} className={inputClass} value={disposalMethod} onChange={e => setDisposalMethod(e.target.value)} maxLength={300} />)}</Field>
          )}
        </ElectronicSignatureModal>
      )}
    </section>
  );
}

function ReceiptForm({ sampleId, locations, onDone }: { sampleId: string; locations: LocationRow[]; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [f, setF] = useState({
    condition: 'Intact', sealIntact: true, temperatureC: '', requiredStorage: '2-8 °C', requiredTempMin: '2', requiredTempMax: '8',
    mfgDate: '', expDate: '', quantity: '', unit: 'mL', locationId: '', notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF(prev => ({ ...prev, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors({});
    try {
      const body = {
        condition: f.condition, sealIntact: f.sealIntact, temperatureC: num(f.temperatureC), requiredStorage: f.requiredStorage,
        requiredTempMin: num(f.requiredTempMin), requiredTempMax: num(f.requiredTempMax), mfgDate: f.mfgDate || null, expDate: f.expDate || null,
        quantity: Number(f.quantity), unit: f.unit, locationId: f.locationId || null, notes: f.notes.trim() || null,
      };
      const res = await apiFetch<{ receipt: Receipt; container: Container }>(`/custody/samples/${encodeURIComponent(sampleId)}/receipt`, { method: 'POST', body });
      if (res.receipt.deviation) toast.error(`Received with a deviation (${res.receipt.deviationReasons}). Testing is blocked until QA acknowledges it.`);
      else toast.success(`Received; primary container ${res.container.id} (${res.container.quantity} ${res.container.unit}).`);
      await onDone();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err, 'The receipt was not recorded.'));
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-4 text-sm" aria-label="Record the receipt">
      <p className="md:col-span-4 text-amber-800">Not received. Record the receipt before testing starts; a temperature outside the required range, a broken seal or a damaged container is a deviation QA must acknowledge.</p>
      <Field label="Condition" required error={errors.condition}>{p => (
        <select {...p} className={inputClass} value={f.condition} onChange={set('condition')}>{CONDITIONS.map(c => <option key={c}>{c}</option>)}</select>)}</Field>
      <Field label="Seal intact" error={errors.sealIntact}>{p => (
        <input {...p} type="checkbox" className="h-5 w-5" checked={f.sealIntact} onChange={set('sealIntact')} />)}</Field>
      <Field label="Temperature on receipt (°C)" error={errors.temperatureC}>{p => (
        <input {...p} type="number" step="0.1" className={inputClass} value={f.temperatureC} onChange={set('temperatureC')} />)}</Field>
      <Field label="Required storage" required error={errors.requiredStorage}>{p => (
        <input {...p} className={inputClass} value={f.requiredStorage} onChange={set('requiredStorage')} />)}</Field>
      <Field label="Required min (°C)" error={errors.requiredTempMin} hint="Empty: no lower limit">{p => (
        <input {...p} type="number" step="0.1" className={inputClass} value={f.requiredTempMin} onChange={set('requiredTempMin')} />)}</Field>
      <Field label="Required max (°C)" error={errors.requiredTempMax} hint="Empty: no upper limit">{p => (
        <input {...p} type="number" step="0.1" className={inputClass} value={f.requiredTempMax} onChange={set('requiredTempMax')} />)}</Field>
      <Field label="Manufactured" error={errors.mfgDate}>{p => <input {...p} type="date" className={inputClass} value={f.mfgDate} onChange={set('mfgDate')} />}</Field>
      <Field label="Expires" error={errors.expDate}>{p => <input {...p} type="date" className={inputClass} value={f.expDate} onChange={set('expDate')} />}</Field>
      <Field label="Quantity received" required error={errors.quantity}>{p => (
        <input {...p} type="number" step="0.0001" min="0" className={inputClass} value={f.quantity} onChange={set('quantity')} />)}</Field>
      <Field label="Unit" required error={errors.unit}>{p => <input {...p} className={inputClass} value={f.unit} onChange={set('unit')} />}</Field>
      <Field label="Store at" error={errors.locationId}>{p => <LocationSelect id={p.id} locations={locations} value={f.locationId} onChange={v => setF(prev => ({ ...prev, locationId: v }))} />}</Field>
      <Field label="Notes" error={errors.notes}>{p => <input {...p} className={inputClass} value={f.notes} onChange={set('notes')} />}</Field>
      <div className="md:col-span-4"><Button type="submit" variant="primary" busy={busy}>Record receipt</Button></div>
    </form>
  );
}

function ContainerActionDialog({ action, locations, onClose, onDone }: { action: ContainerAction; locations: LocationRow[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const c = action.container;
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState(c.locationId ?? '');
  const [holderId, setHolderId] = useState<string | null>(c.holderId);
  const [retainUntil, setRetainUntil] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const title = { aliquot: `Aliquot from ${c.id}`, consume: `Use from ${c.id}`, transfer: `Transfer ${c.id}`, retain: `Retain ${c.id}` }[action.kind];

  const submit = async () => {
    setBusy(true); setErrors({});
    const base = { reason: reason.trim(), expectedVersion: c.version };
    const path = `/custody/containers/${encodeURIComponent(c.id)}/${action.kind === 'aliquot' ? 'aliquots' : action.kind}`;
    const body = action.kind === 'aliquot' ? { ...base, quantity: Number(quantity), ...(locationId !== (c.locationId ?? '') ? { locationId: locationId || null } : {}) }
      : action.kind === 'consume' ? { ...base, quantity: Number(quantity) }
      : action.kind === 'transfer' ? { ...base, ...(locationId !== (c.locationId ?? '') ? { toLocationId: locationId || null } : {}), ...(holderId && holderId !== c.holderId ? { toHolderId: holderId } : {}) }
      : { ...base, retainUntil };
    try {
      const res = await apiFetch<any>(path, { method: 'POST', body });
      toast.success(action.kind === 'aliquot' ? `Aliquot ${res.child.id} made (${res.child.quantity} ${res.child.unit}); ${c.id} has ${res.parent.quantity} ${c.unit} left.`
        : action.kind === 'consume' ? `${c.id} has ${res.container.quantity} ${c.unit} left.`
        : action.kind === 'transfer' ? `${c.id} transferred.` : `${c.id} is retained until ${res.retain.retainUntil} (${res.retain.id}).`);
      await onDone();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal open title={title} onClose={onClose} dismissible={!busy} description={`Balance ${c.quantity} ${c.unit}. Every step is a row of the custody ledger.`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submit} busy={busy}>Record</Button></>}>
      <div className="grid gap-3">
        {(action.kind === 'aliquot' || action.kind === 'consume') && (
          <Field label={`Quantity (${c.unit})`} required error={errors.quantity} hint={`At most ${c.quantity} ${c.unit}`}>{p => (
            <input {...p} type="number" step="0.0001" min="0" max={c.quantity} className={inputClass} value={quantity} onChange={e => setQuantity(e.target.value)} />)}</Field>
        )}
        {(action.kind === 'aliquot' || action.kind === 'transfer') && (
          <Field label={action.kind === 'aliquot' ? 'Store the aliquot at' : 'New location'} error={errors.locationId ?? errors.toLocationId}>{p => (
            <LocationSelect id={p.id} locations={locations} value={locationId} onChange={setLocationId} />)}</Field>
        )}
        {action.kind === 'transfer' && (
          <EntityPicker kind="users" label="New holder" value={holderId} onChange={(v: string | null) => setHolderId(v)} error={errors.toHolderId} />
        )}
        {action.kind === 'retain' && (
          <Field label="Keep until" required error={errors.retainUntil}>{p => <input {...p} type="date" className={inputClass} value={retainUntil} onChange={e => setRetainUntil(e.target.value)} />}</Field>
        )}
        <Field label="Reason" required error={errors.reason} hint="At least 5 characters">{p => (
          <input {...p} className={inputClass} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} />)}</Field>
      </div>
    </Modal>
  );
}

// ---- the custody screen -------------------------------------------------------------------------------------------------------

export function CustodyScreen({ user, token, segments }: { user: SelfUser; token?: string; segments: string[] }) {
  const tab = segments[0] === 'retains' || segments[0] === 'verify' || segments[0] === 'samples' ? segments[0] : 'locations';
  const tabs: Array<[string, string]> = [['locations', 'Storage locations'], ['retains', 'Retain register'], ['verify', 'Ledger check']];
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-slate-800">Sample custody</h2>
      <nav aria-label="Custody sections" className="flex gap-2">
        {tabs.map(([id, text]) => (
          <a key={id} href={formatHash('custody', [id])} aria-current={tab === id ? 'page' : undefined}
            className={`px-3 py-1.5 rounded-lg text-sm border ${tab === id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-300 text-slate-700'}`}>{text}</a>
        ))}
      </nav>
      {tab === 'locations' && <LocationsTab focusId={segments[1] ?? null} />}
      {tab === 'retains' && <RetainRegister />}
      {tab === 'verify' && <LedgerCheck />}
      {tab === 'samples' && segments[1] && <CustodyPanel sampleId={segments[1]} user={user} token={token} />}
    </div>
  );
}

function LocationsTab({ focusId }: { focusId: string | null }) {
  const { toast } = useToast();
  const can = usePermissions();
  const { locations, reload } = useLocations();
  const [form, setForm] = useState({ code: '', name: '', kind: 'Storage unit', parentId: '', tempMin: '', tempMax: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const byParent = useMemo(() => {
    const m = new Map<string | null, LocationRow[]>();
    for (const l of locations) m.set(l.parentId, [...(m.get(l.parentId) ?? []), l]);
    return m;
  }, [locations]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors({});
    try {
      const loc = await apiFetch<LocationRow>('/custody/locations', { method: 'POST', body: {
        code: form.code.trim(), name: form.name.trim(), kind: form.kind, parentId: form.parentId || null, tempMin: num(form.tempMin), tempMax: num(form.tempMax),
      } });
      toast.success(`Storage location ${loc.code} defined (${loc.id}).`);
      setForm(f => ({ ...f, code: '', name: '' }));
      await reload();
    } catch (err) { setErrors(fieldErrors(err)); toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const [toggling, setToggling] = useState<LocationRow | null>(null);
  const [toggleReason, setToggleReason] = useState('');
  const toggle = async () => {
    const l = toggling!;
    setBusy(true);
    try {
      await apiFetch(`/custody/locations/${encodeURIComponent(l.id)}`, { method: 'PUT', body: { status: l.status === 'Active' ? 'Inactive' : 'Active', reason: toggleReason.trim(), expectedVersion: l.version } });
      toast.success(`${l.code} is now ${l.status === 'Active' ? 'inactive' : 'active'}.`);
      setToggling(null);
      await reload();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const tree = (parent: string | null, depth: number): React.ReactNode[] => (byParent.get(parent) ?? []).flatMap(l => [
    <li key={l.id} style={{ paddingLeft: `${depth * 1.25}rem` }} className={`flex flex-wrap items-center gap-2 py-1 ${focusId === l.id ? 'bg-amber-50' : ''}`}>
      <MapPin className="w-4 h-4 text-slate-400" aria-hidden="true" />
      <span className="font-mono">{l.code}</span> {l.name} · {l.kind} · {range(l.tempMin, l.tempMax)} · <Badge tone={l.status === 'Active' ? 'success' : 'neutral'}>{l.status}</Badge>
      <span className="text-xs text-slate-500">{l.id}</span>
      <Button size="sm" onClick={() => setLabel(l.id)}>Label</Button>
      {can('custody.locations') && <Button size="sm" onClick={() => { setToggleReason(''); setToggling(l); }}>{l.status === 'Active' ? 'Deactivate' : 'Reactivate'}</Button>}
    </li>,
    ...tree(l.id, depth + 1),
  ]);

  return (
    <div className="grid gap-4">
      <ul aria-label="Storage locations" className="text-sm rounded-xl border border-slate-200 bg-white p-3">
        {locations.length ? tree(null, 0) : <li className="text-slate-600">No storage locations are defined yet.</li>}
      </ul>
      {can('custody.locations') && (
        <form onSubmit={create} className="grid gap-3 md:grid-cols-6 text-sm rounded-xl border border-slate-200 bg-white p-3" aria-label="New storage location">
          <Field label="Code" required error={errors.code}>{p => <input {...p} className={inputClass} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />}</Field>
          <Field label="Name" required error={errors.name}>{p => <input {...p} className={inputClass} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Kind" error={errors.kind}>{p => (
            <select {...p} className={inputClass} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>{LOCATION_KINDS.map(k => <option key={k}>{k}</option>)}</select>)}</Field>
          <Field label="Inside" error={errors.parentId}>{p => <LocationSelect id={p.id} locations={locations} value={form.parentId} onChange={v => setForm({ ...form, parentId: v })} />}</Field>
          <Field label="Min (°C)" error={errors.tempMin}>{p => <input {...p} type="number" step="0.1" className={inputClass} value={form.tempMin} onChange={e => setForm({ ...form, tempMin: e.target.value })} />}</Field>
          <Field label="Max (°C)" error={errors.tempMax}>{p => <input {...p} type="number" step="0.1" className={inputClass} value={form.tempMax} onChange={e => setForm({ ...form, tempMax: e.target.value })} />}</Field>
          <div className="md:col-span-6"><Button type="submit" variant="primary" busy={busy}>Define location</Button></div>
        </form>
      )}
      {label && <LabelPrint open entityType="Location" entityId={label} onClose={() => setLabel(null)} />}
      {toggling && (
        <Modal open title={`${toggling.status === 'Active' ? 'Deactivate' : 'Reactivate'} ${toggling.code}`} onClose={() => setToggling(null)} dismissible={!busy}
          description={toggling.status === 'Active' ? 'An inactive location receives no container; one that still holds a container cannot be deactivated.' : undefined}
          footer={<><Button onClick={() => setToggling(null)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void toggle()} busy={busy}>Confirm</Button></>}>
          <Field label="Reason" required hint="At least 5 characters">{p => <input {...p} className={inputClass} value={toggleReason} onChange={e => setToggleReason(e.target.value)} maxLength={1000} />}</Field>
        </Modal>
      )}
    </div>
  );
}

function RetainRegister() {
  const { toast } = useToast();
  const [rows, setRows] = useState<RetainRow[] | null>(null);
  const [dueOnly, setDueOnly] = useState(false);
  useEffect(() => {
    setRows(null);
    apiFetch<RetainRow[]>(`/custody/retains${dueOnly ? '?due=true' : ''}`).then(setRows)
      .catch(e => { setRows([]); toast.error(`The retain register could not be loaded: ${errorMessage(e)}`); });
  }, [dueOnly, toast]);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={dueOnly} onChange={e => setDueOnly(e.target.checked)} /> Disposal due only</label>
      {rows === null ? <p aria-busy="true">Loading…</p> : rows.length === 0 ? <p className="text-slate-600">{dueOnly ? 'No retained sample is due for disposal.' : 'The retain register is empty.'}</p> : (
        <table className="w-full">
          <thead><tr className="text-start text-slate-500 border-b"><th scope="col">Retain</th><th scope="col">Sample</th><th scope="col">Container</th><th scope="col">Quantity</th><th scope="col">Keep until</th><th scope="col">Status</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id} className="border-b last:border-0">
              <td className="font-mono">{r.id}</td>
              <td><a className="text-blue-700 underline" href={formatHash('samples', [r.sampleId])}>{r.sampleId}</a></td>
              <td className="font-mono">{r.containerId}</td><td>{r.quantity} {r.unit}</td><td>{r.retainUntil}</td>
              <td>{r.status}{r.due ? <Badge tone="warning" className="ms-1">disposal due</Badge> : null}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500 mt-2">A retained sample is disposed of from its sample page, with an e-signature, once its retention period has ended.</p>
    </div>
  );
}

function LedgerCheck() {
  const { toast } = useToast();
  const [result, setResult] = useState<{ ledger: { valid: boolean; count: number; brokenAt: number | null; problem: string | null }; labels: { valid: boolean; count: number; brokenAt: number | null; problem: string | null } } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<NonNullable<typeof result>>('/custody/verify');
      setResult(r);
      if (r.ledger.valid && r.labels.valid) toast.success('The custody ledger and the label log are intact.');
      else toast.error('The custody ledger or the label log does not verify: see the result.');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const line = (name: string, c: { valid: boolean; count: number; brokenAt: number | null; problem: string | null }) => (
    <p className={c.valid ? 'text-emerald-800' : 'text-red-800 font-semibold'} role={c.valid ? undefined : 'alert'}>
      {name}: {c.valid ? `${c.count} entries, every link and hash verifies` : `broken at entry ${c.brokenAt}: ${c.problem}`}
    </p>
  );
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm space-y-2">
      <p>Recomputes the hash chain of the custody ledger (and its balances) and of the label log from the first entry.</p>
      <Button variant="primary" onClick={run} busy={busy}>Verify</Button>
      {result && <>{line('Custody ledger', result.ledger)}{line('Label log', result.labels)}</>}
    </div>
  );
}
