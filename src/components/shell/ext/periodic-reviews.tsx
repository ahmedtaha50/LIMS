import { lazy } from 'react';
import { Archive } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const PeriodicReviews = lazy(() => import('../../PeriodicReviews').then(m => ({ default: m.PeriodicReviews })));

/** Periodic review, retention and archive (r3-periodic-archive, roadmap M42). Everyone with periodic.view may read; QA signs.
 *  The label avoids the words "Validated" and "Compliant": the shell shows no static claim of either (tests/unit/client/screens.test.ts). */
const periodicReviews: ShellExtension = {
  id: 'periodic-reviews',
  label: 'Periodic Review & Archive',
  section: 'Regulatory & Governance',
  icon: Archive,
  order: 96,
  render: ({ token, user }) => <PeriodicReviews token={token} user={user} />,
};
export default periodicReviews;
