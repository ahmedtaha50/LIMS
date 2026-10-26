/**
 * Security events of the sign-in code (sign-in, failures, lockouts, logout, re-authentication, external AI calls) go to the
 * security-event chain of the audit track, src/server/audit/securityEvents.ts. This file is the one place the identity code
 * imports it from, with the event types it uses.
 *
 * Which of the two records an action belongs in: a change to a record or a setting (an account created, a password reset, an
 * unlock, a policy or integration change, a key rotation, a failed e-signature) is an AUDIT ENTRY (writeAudit), written in the
 * transaction of the change. What was attempted or what happened to a session (a failed sign-in, a lockout, a logout, a call
 * that left the machine) is a SECURITY EVENT. Where one transaction writes both, the audit entry goes first: the two chains
 * take their own advisory locks and one order everywhere cannot deadlock.
 *
 * recordSecurityEvent opens its own transaction and commits before the caller answers, which is what a failure path needs;
 * writeSecurityEvent joins the caller's transaction. A security event that cannot be written throws.
 */
export { recordSecurityEvent, securityEventContext, writeSecurityEvent } from '../audit/securityEvents';
export type { SecurityEventInput } from '../audit/securityEvents';

import type { securityEventContext } from '../audit/securityEvents';

/** ip, user agent, request id and session of the request, as securityEventContext(req) returns them. */
export type EventContext = ReturnType<typeof securityEventContext>;

export const SecurityEventType = {
  LOGIN: 'AUTH_LOGIN',
  LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  MFA_FAILED: 'AUTH_MFA_FAILED',
  RECOVERY_CODE_USED: 'AUTH_RECOVERY_CODE_USED',
  REAUTH: 'AUTH_REAUTH',
  LOGOUT: 'AUTH_LOGOUT',
  PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',
  LOCKOUT: 'LOCKOUT',
  EXTERNAL_CALL: 'EXTERNAL_CALL',
} as const;
