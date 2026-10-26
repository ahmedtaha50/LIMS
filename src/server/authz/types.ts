import type { Request } from 'express';
import type { Db } from '../core/context';
import type { UserRow } from '../auth/sessions';
import type { PermissionCode, SodRuleCode } from '../../lib/permissions';
import type { EntityType } from '../workflow/entityStates';

/** The keys a mutating route accepts: a Zod object (its keys are used) or a plain list. An empty list means "no body". */
export type BodySpec = { readonly shape: Readonly<Record<string, unknown>> } | readonly string[];

/** The record's status must allow the action. `editable`: a field edit or an action on the record. `transition`: the move to `to`. */
export type StateGuard =
  | { entity: EntityType; param: string; require: 'editable' }
  | { entity: EntityType; param: string; require: 'transition'; to: string };

/** The signer must be independent of the record (a rule of sod_rules). `param` names the path parameter that holds the record id. */
export interface SodGuard { rule: SodRuleCode; param: string }

export interface GuardContext {
  db: Db;
  req: Request;
  user: UserRow;
  params: Record<string, string>;
  body: Record<string, unknown>;
}
/** Anything a rule cannot say declaratively. Throws an AppError to refuse. */
export type Guard = (ctx: GuardContext) => Promise<void> | void;

interface Common { body?: BodySpec }

export type RouteRule =
  /** No authentication: sign-in and the health probes. */
  | (Common & { kind: 'public' })
  /** Authenticated by the route itself with its own session options (password change pending, idle session), and no privilege needed: the account's own data. */
  | (Common & { kind: 'self' })
  /** Authenticated here, then the role must hold `permission`; the guards run in the order state, independence, custom. */
  | (Common & { kind: 'perm'; permission: PermissionCode; state?: StateGuard; sod?: SodGuard; guard?: Guard });

export type RuleKind = RouteRule['kind'];
