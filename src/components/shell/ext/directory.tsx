import { lazy } from 'react';
import { KeyRound } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const DirectorySettings = lazy(() => import('../../DirectorySettings').then(m => ({ default: m.DirectorySettings })));

/** Directory sign-on (r3-directory, roadmap M41): the LDAPS / StartTLS connection, the QA-approved group to role mapping and the break-glass accounts.
 *  Administrator and QA only (the server refuses everyone else; the screen says so). */
const directory: ShellExtension = {
  id: 'directory-sign-on',
  label: 'Directory Sign-on',
  section: 'Regulatory & Governance',
  icon: KeyRound,
  order: 96,
  render: ({ token, user }) => <DirectorySettings token={token} user={user} />,
};
export default directory;
