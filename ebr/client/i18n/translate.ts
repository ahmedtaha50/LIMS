import { ar } from './ar.js';
import { en } from './en.js';

/** The two languages and t(): English is the key itself, except the keys made from codes, which en.ts spells out (E26). */
export type Lang = 'en' | 'ar';
export type T = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

const fill = (s: string, vars?: Record<string, string | number | null | undefined>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m)) : s);
export const translate = (lang: Lang): T => (key, vars) => fill((lang === 'ar' ? ar[key] : undefined) ?? en[key] ?? key, vars);
