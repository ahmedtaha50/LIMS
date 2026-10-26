import React from 'react';
import { Languages } from 'lucide-react';
import { isDraftLanguage, setI18n, t, useLang, type DigitMode, type Lang } from './index';
import { savePreferences } from './preferences';
import { useToast } from '../components/ui/Toast';

/**
 * The language switch, in the header and on the sign-in screen. English and Arabic are written in their own language and script, so a
 * person who cannot read the current one can still find theirs. In Arabic a second control chooses the digits shown (Latin 0-9 or
 * Arabic-Indic); it changes the display only, and the label says so.
 *
 * `signedIn` decides whether the choice is also saved on the server (the sign-in screen has no session to save it under; the choice is
 * saved on the first screen after signing in, see syncPreferencesAfterSignIn).
 */
export function LanguageSwitch({ signedIn, className = '' }: { signedIn: boolean; className?: string }) {
  const { lang, digits } = useLang();
  const { toast } = useToast();

  const choose = async (next: { lang?: Lang; digits?: DigitMode }) => {
    setI18n(next);
    if (!signedIn) return;
    const result = await savePreferences({ language: next.lang ?? lang, digits: next.digits ?? digits });
    if (!result.ok) toast.error(t('lang.saveFailed'));
  };

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700">
        <Languages className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t('lang.label')}</span>
        <select
          value={lang}
          onChange={e => void choose({ lang: e.target.value as Lang })}
          aria-label={t('lang.label')}
          title={isDraftLanguage('ar') ? t('lang.draftNote') : undefined}
          className="ui-control rounded-lg border border-slate-300 bg-white py-1.5 ps-2 pe-7 text-xs font-medium text-slate-800"
        >
          {/* Each language is named in itself and in its own script, whatever the current language is. */}
          <option value="en" lang="en" dir="ltr">English</option>
          <option value="ar" lang="ar" dir="rtl">العربية (مسودة)</option>
        </select>
      </label>
      {lang === 'ar' && (
        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700" title={t('lang.digitsHelp')}>
          <span>{t('lang.digits')}</span>
          <select
            value={digits}
            onChange={e => void choose({ digits: e.target.value as DigitMode })}
            aria-label={t('lang.digitsHelp')}
            className="ui-control rounded-lg border border-slate-300 bg-white py-1.5 ps-2 pe-7 text-xs font-medium text-slate-800"
          >
            <option value="latin">{t('lang.digits.latin')}</option>
            <option value="arabic-indic">{t('lang.digits.arabicIndic')}</option>
          </select>
        </label>
      )}
    </div>
  );
}
