/**
 * English for the keys made from codes the server sends (a signature meaning, a record status). Every other English text
 * is its own key. Each key here must also be in ar.ts (tests/unit/i18n.test.ts).
 */
export const en: Record<string, string> = {
  'meaning.authored': 'authored', 'meaning.performed': 'performed', 'meaning.verified': 'verified', 'meaning.reviewed': 'reviewed',
  'meaning.approved': 'approved', 'meaning.released': 'released', 'meaning.rejected': 'rejected', 'meaning.corrected': 'corrected', 'meaning.retired': 'retired',
  'status.draft': 'draft', 'status.in_review': 'in review', 'status.approved': 'approved', 'status.effective': 'effective', 'status.retired': 'retired',
  'status.created': 'created', 'status.in_progress': 'in progress', 'status.completed': 'completed', 'status.released': 'released', 'status.rejected': 'rejected',
  'status.cancelled': 'cancelled', 'status.quarantine': 'quarantine', 'status.open': 'open', 'status.complete': 'complete', 'status.closed': 'closed',
  'status.deviation': 'handed to deviation', 'status.active': 'active',
  'item.exception': 'exception', 'item.comment': 'comment', 'item.late_verification': 'late verification',
  'fieldType.text': 'text', 'fieldType.number': 'number', 'fieldType.datetime': 'date and time', 'fieldType.choice': 'choice', 'fieldType.boolean': 'yes / no',
  'stepType.instruction': 'Instruction', 'stepType.data': 'Recorded value', 'stepType.signature': 'Signature', 'stepType.verified': 'Verified by a second person',
  'stepType.calculation': 'Calculation', 'stepType.material': 'Material (dispense)', 'stepType.equipment': 'Equipment or room', 'stepType.sample': 'Sample (IPC)',
  'setting.session.idleMinutes': 'Sign-off after this many minutes without activity', 'setting.session.maxHours': 'Longest a session lasts, active or not',
  'setting.signin.maxFailures': 'Failed sign-ins that lock the account', 'setting.signin.windowMinutes': 'Failed sign-ins are counted over this many minutes',
  'setting.signin.lockMinutes': 'A locked account stays locked this many minutes (or until an administrator unlocks it)',
  'setting.yield.minPct': 'Lowest acceptable yield when the recipe sets none', 'setting.yield.maxPct': 'Highest acceptable yield when the recipe sets none',
  'setting.directory.url': 'Directory address (ldaps:// or ldap://); empty: local accounts only', 'setting.directory.baseDn': 'Where users are searched',
  'setting.directory.userFilter': 'Search filter; {username} is replaced (escaped)', 'setting.directory.bindDn': 'Service account that searches',
  'setting.directory.groupRoles': 'Directory group (DN) to role',
  'unit.min': 'min', 'unit.h': 'h', 'unit.%': '%',
  'settingGroup.Sessions': 'Sessions', 'settingGroup.Sign-in': 'Sign-in', 'settingGroup.Yield': 'Yield', 'settingGroup.Directory': 'Directory',
};
