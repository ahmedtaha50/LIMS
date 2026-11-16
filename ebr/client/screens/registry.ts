import type { ComponentType } from 'react';

/**
 * A screen is a folder client/screens/<name>/ whose index.tsx exports `screen`. The shell finds them by directory, so a
 * track adds a folder and edits no shared list.
 */
export type Screen = { id: string; title: string; order: number; permission: string; Component: ComponentType };

const modules = import.meta.glob<{ screen: Screen }>('./*/index.tsx', { eager: true });
export const screens: Screen[] = Object.values(modules).map(m => m.screen).filter(Boolean).sort((a, b) => a.order - b.order);
