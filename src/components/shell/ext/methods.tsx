import { lazy } from 'react';
import { FlaskConical } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Methods = lazy(() => import('../../Methods').then(m => ({ default: m.Methods })));

/** Methods, calculation formulas and test plans (r2-methods-calc, roadmap M18). The screen asks the server what the user may change. */
const methods: ShellExtension = {
  id: 'methods',
  label: 'Methods & Calculations',
  section: 'Quality Assurance',
  icon: FlaskConical,
  order: 45,
  render: ({ token, user }) => <Methods token={token} user={user} />,
};
export default methods;
