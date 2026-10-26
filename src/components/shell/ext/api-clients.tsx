import { lazy } from 'react';
import { KeyRound } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const ApiClients = lazy(() => import('../../ApiClients').then(m => ({ default: m.ApiClients })));

/** API clients of the machine integration API, /api/v1 (r2-api-v1, roadmap M22). Administrators only; the server checks again. */
const apiClients: ShellExtension = {
  id: 'api-clients',
  label: 'API Clients',
  section: 'Regulatory & Governance',
  icon: KeyRound,
  order: 90,
  adminOnly: true,
  render: ({ token, user }) => <ApiClients token={token} user={user} />,
};
export default apiClients;
