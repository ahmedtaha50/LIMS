import { lazy } from 'react';
import { Cable } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const ImportsReview = lazy(() => import('../../ImportsReview').then(m => ({ default: m.ImportsReview })));

/** Instrument data capture (r2-instrument-integration, roadmap M21): captured files, values waiting for acceptance, capture profiles. */
const imports: ShellExtension = {
  id: 'imports',
  label: 'Instrument Imports',
  section: 'Laboratory Controls',
  icon: Cable,
  order: 12,
  render: ({ user }) => <ImportsReview user={user} />,
};
export default imports;
