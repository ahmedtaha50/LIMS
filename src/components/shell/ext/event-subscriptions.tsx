import { lazy } from 'react';
import { Send } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const EventSubscriptions = lazy(() => import('../../NotificationBell').then(m => ({ default: m.EventSubscriptions })));

/** Outbound event subscriptions: signed webhooks, e-mail, file drop (r2-events, roadmap M23). Administrators only; the server checks again. */
const eventSubscriptions: ShellExtension = {
  id: 'event-subscriptions',
  label: 'Event Subscriptions',
  section: 'Regulatory & Governance',
  icon: Send,
  order: 91,
  adminOnly: true,
  render: ({ token, user }) => <EventSubscriptions token={token} user={user} />,
};
export default eventSubscriptions;
