/**
 * The Arabic interface. The key is the English text of the screen (or a key made from a server code, see en.ts).
 * tests/unit/i18n.test.ts checks that every key the screens use is here, that nothing here is unused, and that every value
 * is Arabic with the same {placeholders}. Codes, units and product names stay as they are written.
 * Keys "error.<code>" give the sentence for an error code of the server.
 */
export const ar: Record<string, string> = {
  'Sign in': 'تسجيل الدخول',
  'Version {n}': 'الإصدار {n}',
  'meaning.authored': 'أعدّ', 'meaning.performed': 'نفّذ', 'meaning.verified': 'تحقق', 'meaning.approved': 'اعتمد',
  'status.draft': 'مسودة', 'status.approved': 'معتمد',
  'error.stale': 'غيّر شخص آخر هذا السجل؛ أعد تحميله ثم حاول مرة أخرى.',
};
