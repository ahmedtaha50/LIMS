// Server copy of the language and digit choice (GET/PUT /api/me/preferences, migration 0350). The local copy (store.ts) paints the first
// screen; once signed in, the server's copy wins, so the choice follows the user to another PC and survives the desktop build's changing
// port (which empties localStorage at every launch). A failed save is reported, never swallowed: the choice then holds on this computer only.
import { ApiError, apiFetch } from '../lib/api';
import { isDigitMode, isLang, type DigitMode, type Lang } from './languages';
import { getI18n, setI18n } from './store';

export interface Preferences { language: Lang; digits: DigitMode; version: number }

let serverVersion = 0;

function readPreferences(body: unknown): Preferences | null {
  const b = body as Partial<Preferences> | null;
  return b && isLang(b.language) && isDigitMode(b.digits) && typeof b.version === 'number' ? { language: b.language, digits: b.digits, version: b.version } : null;
}

/**
 * Called once after sign-in. The server's choice is applied; if the user never chose on the server (version 0) but chose on this computer
 * before signing in (the sign-in screen has the switch), that choice is saved to the server instead. Resolves false if the server could not be read.
 */
export async function syncPreferencesAfterSignIn(): Promise<{ ok: boolean; error?: unknown }> {
  try {
    const prefs = readPreferences(await apiFetch('/me/preferences'));
    if (!prefs) throw new Error('The server sent preferences the application cannot read.');
    serverVersion = prefs.version;
    const local = getI18n();
    if (prefs.version === 0) {
      if (local.lang !== 'en' || local.digits !== 'latin') return await savePreferences({ language: local.lang, digits: local.digits });
      return { ok: true };
    }
    setI18n({ lang: prefs.language, digits: prefs.digits });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Saves the choice on the server. On a version conflict (another window changed it) the server's newer choice is applied and ok is false with a CONFLICT error. */
export async function savePreferences(next: { language: Lang; digits: DigitMode }): Promise<{ ok: boolean; error?: unknown }> {
  try {
    const saved = readPreferences(await apiFetch('/me/preferences', { method: 'PUT', body: { ...next, expectedVersion: serverVersion }, replay: 'never' }));
    if (saved) serverVersion = saved.version;
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const fresh = readPreferences(await apiFetch('/me/preferences').catch(() => null));
      if (fresh) { serverVersion = fresh.version; setI18n({ lang: fresh.language, digits: fresh.digits }); }
    }
    return { ok: false, error };
  }
}
