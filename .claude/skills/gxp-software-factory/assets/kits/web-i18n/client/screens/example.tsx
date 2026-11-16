import { errorText, formatWhen, useI18n } from '../i18n/index.js';

/** An example screen: how texts reach the dictionary. Delete it once a real screen uses t(). (kit web-i18n) */
export function Example({ version, meaning, status, at, error }: { version: number; meaning: string; status: string; at: string; error?: unknown }) {
  const { lang, t } = useI18n();
  return (
    <section className="ps-4 text-start">
      <h1>{t('Sign in')}</h1>
      <p>{t('Version {n}', { n: version })} · {t(`meaning.${meaning}`)} · {t(`status.${status}`)} · {formatWhen(lang, at)}</p>
      {error ? <p role="alert">{errorText(t, error, 'Sign in')}</p> : null}
    </section>
  );
}
