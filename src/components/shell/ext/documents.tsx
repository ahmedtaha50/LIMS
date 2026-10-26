import { lazy } from 'react';
import { BookOpen } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Documents = lazy(() => import('../../Documents').then(m => ({ default: m.Documents })));

/** Controlled documents (SOPs) and their signed lifecycle (r2-docs-training, roadmap M28). #/documents/<document id> opens one. */
const documents: ShellExtension = {
  id: 'documents',
  label: 'Controlled Documents',
  section: 'Laboratory Controls',
  icon: BookOpen,
  order: 35,
  render: ({ token, user, route }) => <Documents token={token} user={user} documentId={route.segments[0]} />,
};
export default documents;
