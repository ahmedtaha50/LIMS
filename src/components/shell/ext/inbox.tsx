import { lazy } from 'react';
import { Inbox as InboxIcon } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Inbox = lazy(() => import('../../Inbox').then(m => ({ default: m.Inbox })));

/** "My Tasks": what is waiting for the signed-in user (GET /api/inbox). */
const inbox: ShellExtension = {
  id: 'inbox',
  label: 'My Tasks',
  section: 'Operations',
  icon: InboxIcon,
  order: 0,
  render: () => <Inbox />,
};
export default inbox;
