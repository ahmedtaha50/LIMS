import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDateTime } from './format';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "13 Oct 2026, 12:12:00 GMT+3": Gregorian, month as a word, time zone shown, the same in every language (src/lib/format.ts). */
export function formatDate(isoString: string): string {
  if (!isoString) return '';
  return formatDateTime(isoString);
}
