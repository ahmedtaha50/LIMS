/// <reference types="vite/client" />
/**
 * The shell extension registry (roadmap M24). A screen joins the application by adding ONE file, src/components/shell/ext/<id>.tsx,
 * whose default export is a ShellExtension: the navigation entry (Layout) and the page (App) come from it, so App.tsx and Layout.tsx
 * are not edited by every track that adds a screen.
 *
 *   // src/components/shell/ext/worklists.tsx
 *   import { ListChecks } from 'lucide-react';
 *   import { Worklists } from '../../Worklists';
 *   export default { id: 'worklists', label: 'Worklists', section: 'Operations', icon: ListChecks, order: 30,
 *                    render: ({ user, route }) => <Worklists user={user} recordId={route.segments[0]} /> } satisfies ShellExtension;
 *
 * The address of the page is #/<id>[/<segments>] (src/lib/router.ts). Showing an entry is not permission: the server decides what
 * the user may read or do. `adminOnly` hides an entry from roles other than Admin.
 */
import type React from 'react';
import type { SelfUser } from '../../lib/api';
import type { Route } from '../../lib/router';

export const NAV_SECTION_TITLES = ['Operations', 'Quality Assurance', 'Laboratory Controls', 'Regulatory & Governance'] as const;
export type NavSectionTitle = (typeof NAV_SECTION_TITLES)[number];

export interface ShellViewProps {
  /** The session's stable view token (lib/api.ts); new screens call apiFetch and do not need it. */
  token: string;
  user: SelfUser;
  route: Route;
}

export interface ShellExtension {
  id: string;
  label: string;
  section: NavSectionTitle;
  icon: React.ComponentType<{ className?: string }>;
  /** Position inside the section; built-in entries count 10, 20, 30 ... and an extension without `order` comes last. */
  order?: number;
  adminOnly?: boolean;
  render: (props: ShellViewProps) => React.ReactNode;
}

const modules = import.meta.glob('./ext/*.tsx', { eager: true }) as Record<string, { default?: ShellExtension }>;

export const SHELL_EXTENSIONS: readonly ShellExtension[] = Object.entries(modules)
  .map(([file, m]) => {
    const ext = m.default;
    if (!ext || typeof ext.id !== 'string' || typeof ext.render !== 'function') throw new Error(`${file}: the default export must be a ShellExtension.`);
    return ext;
  })
  .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));

export const extensionFor = (id: string) => SHELL_EXTENSIONS.find(e => e.id === id);
