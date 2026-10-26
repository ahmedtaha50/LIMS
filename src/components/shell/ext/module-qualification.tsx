import { lazy } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const ModuleQualification = lazy(() => import('../../ModuleQualification').then(m => ({ default: m.ModuleQualification })));

/** The module qualification register (r2-validation, roadmap M37): which modules QA has declared Qualified or NotQualified. Everyone may read it; QA declares.
 *  The label avoids the words "Validated" and "Compliant": the shell shows no static claim of either (tests/unit/client/screens.test.ts). */
const moduleQualification: ShellExtension = {
  id: 'module-qualification',
  label: 'Module Qualification',
  section: 'Regulatory & Governance',
  icon: ShieldCheck,
  order: 95,
  render: ({ token, user }) => <ModuleQualification token={token} user={user} />,
};
export default moduleQualification;
