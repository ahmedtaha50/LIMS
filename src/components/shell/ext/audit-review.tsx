import { lazy } from 'react';
import { FileSearch } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const AuditReview = lazy(() => import('../../AuditReview').then(m => ({ default: m.AuditReview })));

/** Audit-trail review by exception, anchors and the clock guard (r2-audit-tamper, roadmap M35). */
const auditReview: ShellExtension = {
  id: 'audit-review',
  label: 'Audit Review',
  section: 'Quality Assurance',
  icon: FileSearch,
  order: 27,
  render: ({ token, user }) => <AuditReview token={token} user={user} />,
};
export default auditReview;
