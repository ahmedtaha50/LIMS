/**
 * Directory registry: who can vouch for a person. Each resolver turns an e-mail address and a password into a local user row;
 * every authorisation decision afterwards (role, active, locks, sessions) is made on that row, whatever resolver found it.
 * The local account store, and the directory (src/server/auth/ldap.ts).
 */
import type { Db } from '../../core/context';
import type { UserRow } from '../sessions';
import type { EventContext } from '../events';
import { ldapDirectory } from '../ldap';
import { localDirectory } from './local';

export type PrincipalResult =
  | { kind: 'ok'; user: UserRow }
  | { kind: 'bad-password'; user: UserRow }
  | { kind: 'unknown' }
  /** The resolver knows the person and decided not to let them in; the answer (status, code, message) is final and counts nothing. */
  | { kind: 'refused'; status: number; code: string; message: string };

export interface PrincipalResolver {
  id: string;
  /** Never throws for bad credentials. Takes about the same time whether or not the address exists. */
  authenticate(db: Db, email: string, password: string, context?: Partial<EventContext>): Promise<PrincipalResult>;
}

/** The directory goes first: it answers 'unknown' at once while directory sign-on is switched off, and for any local account that is not break-glass. */
export const principalResolvers: PrincipalResolver[] = [ldapDirectory, localDirectory];

export async function authenticatePrincipal(db: Db, email: string, password: string, context?: Partial<EventContext>): Promise<PrincipalResult> {
  for (const resolver of principalResolvers) {
    const result = await resolver.authenticate(db, email, password, context);
    if (result.kind !== 'unknown') return result; // found by this resolver, right password or wrong: no other resolver gets a second try
  }
  return { kind: 'unknown' };
}
