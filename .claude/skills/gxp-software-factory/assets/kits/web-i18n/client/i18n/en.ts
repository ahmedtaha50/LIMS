/**
 * English for the keys made from codes the server sends (a signature meaning, a record status, a role). Every other English
 * text is its own key and is not listed. Each key here must also be in ar.ts (tests/unit/i18n.test.ts).
 * A screen writes t(`status.${row.status}`): the test finds the prefix "status" and requires keys for it here.
 */
export const en: Record<string, string> = {
  'meaning.authored': 'authored', 'meaning.performed': 'performed', 'meaning.verified': 'verified', 'meaning.approved': 'approved',
  'status.draft': 'draft', 'status.approved': 'approved',
};
