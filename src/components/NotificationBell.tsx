// Notifications and event subscriptions (roadmap M23, r2-events).
//
//   NotificationBell     the bell of the shell: the unread count, the list of the user's persistent notifications (a user who was away
//                        sees what happened at the next sign-in), mark read, and the live push over an authenticated socket. A pushed
//                        notification is also shown as a toast; the bell keeps it after the toast is gone.
//   EventSubscriptions   the Administrators' screen of outbound subscriptions (signed webhook, e-mail, file drop): create, disable and
//                        re-enable with an e-signature, the deliveries of each, and requeueing a dead delivery with a reason.
//
// A notification is not a GxP record and never replaces a signature; it links to the record, where the server checks permissions again.
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Bell, CheckCheck, Copy, Plus, Power, RotateCcw, Send } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { apiFetch, errorMessage, useSessionState, type SelfUser } from '../lib/api';

export interface NotificationItem {
  id: string; eventId: string; type: string; title: string; message: string; href: string | null; createdAt: string; readAt: string | null;
}

export interface SubscriptionRow {
  id: string; name: string; sink: 'webhook' | 'email' | 'file'; target: string; eventTypes: string[]; status: 'Active' | 'Disabled' | string;
  secretFingerprint: string | null; createdBy: string; createdAt: string; version: number;
  deliveries: { pending: number; delivered: number; dead: number };
}

interface DeliveryRow {
  id: string; eventId: string; eventType: string | null; status: 'pending' | 'sending' | 'delivered' | 'dead'; attempts: number; maxAttempts: number;
  nextAttemptAt: string; lastStatusCode: number | null; lastError: string | null; deliveredAt: string | null; createdAt: string; version: number;
}
interface CatalogEntry { type: string; version: number; description: string; audience: string }
interface SinkInfo { webhook: { configured: boolean; allowList: string[] }; email: { configured: boolean; problem: string | null }; file: { configured: boolean } }

const when = (iso: string | null) => (iso ? formatDateTime(iso) : '-');

// ---- presentational parts (rendered on the server in tests/api/events-ui.test.ts) ----------------------------------------------

export function BellButton({ unread, open, onClick }: { unread: number; open: boolean; onClick: () => void }) {
  const label = unread === 0 ? 'Notifications, none unread' : `Notifications, ${unread} unread`;
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog"
      className="ui-control relative inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
      <Bell className="w-5 h-5" aria-hidden="true" />
      {unread > 0 && (
        <span aria-hidden="true" className="absolute -top-1 -end-1 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-bold leading-5 text-center">{unread > 99 ? '99+' : unread}</span>
      )}
    </button>
  );
}

export function NotificationList({ items, onRead, onReadAll, onOpen }: {
  items: NotificationItem[]; onRead: (n: NotificationItem) => void; onReadAll: () => void; onOpen: (n: NotificationItem) => void;
}) {
  if (items.length === 0) return <p className="px-3 py-4 text-sm text-slate-600">No notifications.</p>;
  return (
    <div>
      <div className="flex justify-end px-3 py-2 border-b border-slate-100">
        <Button size="sm" onClick={onReadAll}><CheckCheck className="w-4 h-4" aria-hidden="true" /> Mark all read</Button>
      </div>
      <ul className="divide-y divide-slate-100">
        {items.map(n => (
          <li key={n.id} className={`px-3 py-2 text-sm ${n.readAt ? 'bg-white' : 'bg-blue-50'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-slate-800 flex items-center gap-2">
                  {!n.readAt && <span className="inline-block px-1.5 py-0.5 rounded bg-blue-700 text-white text-[10px] font-bold uppercase">Unread</span>}
                  {n.title}
                </div>
                {n.href
                  ? <a href={n.href} onClick={() => onOpen(n)} className="block text-slate-700 underline decoration-slate-300 hover:text-blue-800 break-words">{n.message}</a>
                  : <p className="text-slate-700 break-words">{n.message}</p>}
                <div className="text-xs text-slate-600 mt-0.5"><time dateTime={n.createdAt}>{when(n.createdAt)}</time></div>
              </div>
              {!n.readAt && <Button size="sm" variant="ghost" onClick={() => onRead(n)} aria-label={`Mark "${n.title}" read`}>Mark read</Button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SubscriptionTable({ rows, onStatus, onDeliveries }: {
  rows: SubscriptionRow[]; onStatus: (s: SubscriptionRow) => void; onDeliveries: (s: SubscriptionRow) => void;
}) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <caption className="sr-only">Event subscriptions</caption>
        <thead className="bg-slate-50 text-start">
          <tr>
            <th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Sink</th><th scope="col" className="px-3 py-2">Target</th>
            <th scope="col" className="px-3 py-2">Events</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Deliveries</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-slate-600">No subscription yet.</td></tr>}
          {rows.map(s => (
            <tr key={s.id} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2"><div className="font-medium text-slate-800">{s.name}</div><div className="text-xs text-slate-600 font-mono">{s.id}</div></td>
              <td className="px-3 py-2">{s.sink}{s.secretFingerprint && <div className="text-xs text-slate-600">secret <span className="font-mono">{s.secretFingerprint}</span></div>}</td>
              <td className="px-3 py-2 font-mono text-xs break-all">{s.target}</td>
              <td className="px-3 py-2 font-mono text-xs">{s.eventTypes.join(', ')}</td>
              <td className="px-3 py-2">
                <span className={`inline-block px-2 py-0.5 text-xs border rounded ${s.status === 'Active' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-300'}`}>{s.status}</span>
              </td>
              <td className="px-3 py-2 text-xs">
                {s.deliveries.delivered} delivered, {s.deliveries.pending} pending, <span className={s.deliveries.dead ? 'text-red-700 font-semibold' : ''}>{s.deliveries.dead} dead</span>
              </td>
              <td className="px-3 py-2 text-end whitespace-nowrap">
                <Button size="sm" onClick={() => onDeliveries(s)}><Send className="w-4 h-4" aria-hidden="true" /> Deliveries</Button>{' '}
                <Button size="sm" onClick={() => onStatus(s)}><Power className="w-4 h-4" aria-hidden="true" /> {s.status === 'Active' ? 'Disable' : 'Enable'}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- the bell ----------------------------------------------------------------------------------------------------------------------

export function NotificationBell() {
  const { toast } = useToast();
  const { token, status } = useSessionState();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const failed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ items: NotificationItem[]; unread: number }>('/notifications?limit=50');
      setItems(r.items); setUnread(r.unread);
      failed.current = false;
    } catch (err) {
      if (!failed.current) toast.error(errorMessage(err, 'Your notifications could not be loaded.'));
      failed.current = true; // one message, not one per retry
    }
  }, [toast]);

  // The list at sign-in (what happened while the user was away) and the live push. The socket uses the current token, so it is opened
  // again after a re-authentication; the server refuses a socket without a valid session and closes it when the session ends.
  useEffect(() => {
    if (!token || status !== 'active') return;
    void refresh();
    let socket: Socket | null = io({ auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('notification', (n: NotificationItem) => {
      setItems(prev => [n, ...prev.filter(p => p.id !== n.id)].slice(0, 50));
      setUnread(u => u + 1);
      if (n.type === 'result.oos_detected') toast.error(`${n.title}: ${n.message}`);
      else toast.info(`${n.title}: ${n.message}`);
    });
    socket.on('connect', () => { void refresh(); }); // after a reconnect, catch up on what was missed
    return () => { socket?.disconnect(); socket = null; };
  }, [token, status, refresh, toast]);

  const markRead = async (n: NotificationItem) => {
    try {
      const r = await apiFetch<NotificationItem>(`/notifications/${encodeURIComponent(n.id)}/read`, { body: {} });
      setItems(prev => prev.map(p => (p.id === n.id ? { ...p, readAt: r.readAt } : p)));
      setUnread(u => Math.max(0, u - (n.readAt ? 0 : 1)));
    } catch (err) {
      toast.error(errorMessage(err, 'The notification could not be marked read.'));
    }
  };
  const markAll = async () => {
    try {
      await apiFetch('/notifications/read-all', { body: {} });
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'The notifications could not be marked read.'));
    }
  };

  return (
    <div className="relative">
      <BellButton unread={unread} open={open} onClick={() => setOpen(o => !o)} />
      <Modal open={open} title="Notifications" onClose={() => setOpen(false)} size="md" variant="drawer"
        description="What happened in the records you work with. A notification is not a record: open the record to act on it.">
        <NotificationList items={items} onRead={n => { void markRead(n); }} onReadAll={() => { void markAll(); }}
          onOpen={n => { setOpen(false); if (!n.readAt) void markRead(n); }} />
      </Modal>
    </div>
  );
}

// ---- the subscriptions screen ----------------------------------------------------------------------------------------------------

type Draft = { name: string; sink: SubscriptionRow['sink']; target: string; eventTypes: string[] };
const EMPTY: Draft = { name: '', sink: 'webhook', target: '', eventTypes: [] };
const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';

/** What is wrong with a draft before it goes to the signature dialog (the server checks the same and more). */
export function subscriptionDraftProblem(d: Draft): string | null {
  if (d.name.trim().length < 3) return 'The name needs at least 3 characters.';
  if (!d.target.trim()) return d.sink === 'webhook' ? 'Enter the webhook address.' : d.sink === 'email' ? 'Enter the e-mail address.' : 'Enter the folder name.';
  if (d.eventTypes.length === 0) return 'Choose at least one event type.';
  return null;
}

export function EventSubscriptions({ token, user }: { token: string; user: SelfUser }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [sinks, setSinks] = useState<SinkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [signing, setSigning] = useState<{ kind: 'create'; draft: Draft } | { kind: 'status'; sub: SubscriptionRow } | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [deliveries, setDeliveries] = useState<{ sub: SubscriptionRow; rows: DeliveryRow[] } | null>(null);
  const [requeue, setRequeue] = useState<{ delivery: DeliveryRow; reason: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ subscriptions: SubscriptionRow[]; catalog: CatalogEntry[]; sinks: SinkInfo }>('/event-subscriptions');
      setRows(r.subscriptions); setCatalog(r.catalog); setSinks(r.sinks);
    } catch (err) {
      toast.error(errorMessage(err, 'The subscriptions could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void refresh(); }, [refresh]);

  const loadDeliveries = async (sub: SubscriptionRow) => {
    try {
      const r = await apiFetch<{ deliveries: DeliveryRow[] }>(`/event-subscriptions/${encodeURIComponent(sub.id)}/deliveries`);
      setDeliveries({ sub, rows: r.deliveries });
    } catch (err) {
      toast.error(errorMessage(err, 'The deliveries could not be loaded.'));
    }
  };

  const startCreate = () => {
    if (!draft) return;
    const problem = subscriptionDraftProblem(draft);
    if (problem) { toast.error(problem); return; }
    setSigning({ kind: 'create', draft });
  };

  // When the call throws, the dialog shows the server's message and stays open so the signer can correct the entry.
  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, reason: reason ?? '', ...(totpCode ? { totpCode } : {}) };
    if (signing.kind === 'create') {
      const d = signing.draft;
      const r = await apiFetch<{ subscription: SubscriptionRow; secret?: string }>('/event-subscriptions', {
        body: { name: d.name.trim(), sink: d.sink, target: d.target.trim(), eventTypes: d.eventTypes, ...cred }, replay: 'never',
      });
      if (r.secret) setSecret({ name: r.subscription.name, secret: r.secret });
      setDraft(null);
      toast.success(`Subscription ${r.subscription.name} created, signed (audit logged)`);
    } else {
      const next = signing.sub.status === 'Active' ? 'Disabled' : 'Active';
      const r = await apiFetch<SubscriptionRow>(`/event-subscriptions/${encodeURIComponent(signing.sub.id)}/status`, {
        body: { status: next, expectedVersion: signing.sub.version, ...cred }, replay: 'never',
      });
      toast.success(`Subscription ${r.name} is ${r.status}, signed (audit logged)`);
    }
    setSigning(null);
    await refresh();
  };

  const doRequeue = async () => {
    if (!requeue || !deliveries) return;
    if (requeue.reason.trim().length < 5) { toast.error('A reason of at least 5 characters is required.'); return; }
    try {
      await apiFetch(`/event-deliveries/${encodeURIComponent(requeue.delivery.id)}/retry`, { body: { reason: requeue.reason.trim(), expectedVersion: requeue.delivery.version } });
      toast.success('The delivery is queued again (audit logged).');
      setRequeue(null);
      await loadDeliveries(deliveries.sub);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'The delivery could not be queued again.'));
    }
  };

  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.secret); toast.success('Secret copied to the clipboard.'); } catch {
      toast.error('The clipboard is not available here: select the secret and copy it by hand.');
    }
  };

  const toggleType = (type: string) => setDraft(d => (d ? { ...d, eventTypes: d.eventTypes.includes(type) ? d.eventTypes.filter(t => t !== type) : [...d.eventTypes, type] } : d));
  const sinkUnavailable = (sink: Draft['sink']): string | null => {
    if (!sinks) return null;
    if (sink === 'webhook' && !sinks.webhook.configured) return 'No webhook destination is allowed on this server (EVENTS_WEBHOOK_ALLOWLIST is empty).';
    if (sink === 'email' && !sinks.email.configured) return sinks.email.problem;
    if (sink === 'file' && !sinks.file.configured) return 'File delivery is not configured on this server (EVENTS_DROP_DIR is not set).';
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><Send className="w-5 h-5" aria-hidden="true" /> Event subscriptions</h1>
        <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}><Plus className="w-4 h-4" aria-hidden="true" /> New subscription</Button>
      </div>
      <p className="text-sm text-slate-600">
        Other systems learn about OOS results, batch releases, calibrations due and system alerts here. A delivery names the record; it never
        carries a result value. A webhook is signed with its own secret (header X-LIMS-Signature) and retried up to 5 times.
        {sinks?.webhook.configured && <> Allowed webhook networks: <span className="font-mono">{sinks.webhook.allowList.join(', ')}</span>.</>}
      </p>

      {loading ? <p className="text-sm text-slate-600">Loading...</p> : (
        <SubscriptionTable rows={rows} onStatus={s => setSigning({ kind: 'status', sub: s })} onDeliveries={s => { void loadDeliveries(s); }} />
      )}

      <Modal open={!!draft && !signing} title="New subscription" onClose={() => setDraft(null)} size="lg"
        description="What a subscription sends and where cannot be changed later: create another one instead."
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" onClick={startCreate}>Sign and create</Button></>}>
        {draft && (
          <div className="space-y-3">
            <Field label="Name" required>{p => <input {...p} className={`${input} w-full`} value={draft.name} maxLength={100} onChange={e => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Sink" required hint={sinkUnavailable(draft.sink) ?? undefined}>{p => (
              <select {...p} className={`${input} w-full`} value={draft.sink} onChange={e => setDraft({ ...draft, sink: e.target.value as Draft['sink'] })}>
                <option value="webhook">Signed webhook (HTTP POST)</option>
                <option value="email">E-mail</option>
                <option value="file">File drop (ERP folder)</option>
              </select>
            )}</Field>
            <Field label={draft.sink === 'webhook' ? 'Webhook address' : draft.sink === 'email' ? 'E-mail address' : 'Folder name'} required
              hint={draft.sink === 'webhook' ? 'http(s) address on the allowed network, for example https://erp.lan/hooks/lims' : draft.sink === 'file' ? 'One folder name inside the drop directory.' : undefined}>
              {p => <input {...p} className={`${input} w-full font-mono`} value={draft.target} maxLength={500} onChange={e => setDraft({ ...draft, target: e.target.value })} />}
            </Field>
            <fieldset>
              <legend className="text-sm font-medium text-slate-700">Event types</legend>
              {catalog.map(c => (
                <label key={c.type} className="flex items-start gap-2 mt-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={draft.eventTypes.includes(c.type)} onChange={() => toggleType(c.type)} />
                  <span><code className="font-mono">{c.type}</code> <span className="text-xs text-slate-600">v{c.version}</span><span className="block text-xs text-slate-600">{c.description}</span></span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </Modal>

      <Modal open={!!secret} title="Copy the webhook secret now" onClose={() => setSecret(null)} role="alertdialog"
        description="This is the only time the secret is shown. The receiver uses it to check the X-LIMS-Signature header; if it is lost, disable this subscription and create a new one."
        footer={<><Button onClick={copy}><Copy className="w-4 h-4" aria-hidden="true" /> Copy</Button><Button variant="primary" onClick={() => setSecret(null)}>I have stored it</Button></>}>
        {secret && (
          <div className="space-y-2">
            <p className="text-sm text-slate-700">Secret of <strong>{secret.name}</strong>:</p>
            <input readOnly aria-label="Webhook secret" className={`${input} w-full font-mono`} value={secret.secret} onFocus={e => e.currentTarget.select()} />
          </div>
        )}
      </Modal>

      <Modal open={!!deliveries && !requeue} title={deliveries ? `Deliveries of ${deliveries.sub.name}` : 'Deliveries'} onClose={() => setDeliveries(null)} size="xl">
        {deliveries && (deliveries.rows.length === 0 ? <p className="text-sm text-slate-600">No delivery yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Deliveries</caption>
              <thead className="text-start bg-slate-50"><tr>
                <th scope="col" className="px-2 py-1">Event</th><th scope="col" className="px-2 py-1">Status</th><th scope="col" className="px-2 py-1">Attempts</th>
                <th scope="col" className="px-2 py-1">Last answer</th><th scope="col" className="px-2 py-1">Time</th><th scope="col" className="px-2 py-1"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {deliveries.rows.map(d => (
                  <tr key={d.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-1 font-mono text-xs">{d.eventType}<div className="text-slate-600">{d.eventId}</div></td>
                    <td className="px-2 py-1">{d.status}</td>
                    <td className="px-2 py-1">{d.attempts} of {d.maxAttempts}</td>
                    <td className="px-2 py-1 text-xs break-words">{d.lastStatusCode ?? ''} {d.lastError ?? ''}</td>
                    <td className="px-2 py-1 text-xs">{d.status === 'delivered' ? when(d.deliveredAt) : `next ${when(d.nextAttemptAt)}`}</td>
                    <td className="px-2 py-1 text-end">{d.status === 'dead' && <Button size="sm" onClick={() => setRequeue({ delivery: d, reason: '' })}><RotateCcw className="w-4 h-4" aria-hidden="true" /> Requeue</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Modal>

      <Modal open={!!requeue} title="Queue the delivery again" onClose={() => setRequeue(null)}
        description="The event is sent again with the same id, so the receiver can recognise a duplicate. The requeue is recorded in the audit trail."
        footer={<><Button onClick={() => setRequeue(null)}>Cancel</Button><Button variant="primary" onClick={() => { void doRequeue(); }}>Requeue</Button></>}>
        {requeue && (
          <Field label="Reason" required hint="For example: the receiver was repaired.">{p => (
            <input {...p} className={`${input} w-full`} value={requeue.reason} maxLength={500} onChange={e => setRequeue({ ...requeue, reason: e.target.value })} />
          )}</Field>
        )}
      </Modal>

      {signing && (
        <ElectronicSignatureModal
          user={{ ...user, email: user.email ?? undefined }}
          token={token}
          meaningCode="ADMIN_AUTHORISATION"
          action={signing.kind === 'create' ? 'create event subscription' : signing.sub.status === 'Active' ? 'disable event subscription' : 'enable event subscription'}
          entityName={signing.kind === 'create' ? signing.draft.name : signing.sub.name}
          recordVersion={signing.kind === 'create' ? 1 : signing.sub.version}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
