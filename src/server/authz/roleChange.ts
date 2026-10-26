/**
 * The role-change flow (roadmap M09): a role is granted or removed by two people. The first signs a request, a second, independent
 * person signs the approval, and only then does users.role change. Each signature is the signer re-entering their password
 * (counted toward the signing lock like every e-signature), it has a fixed meaning, and it is tied to the record version the signer
 * saw: the user's version at the request, the version the change produced at the approval.
 *
 * Every step writes its audit entry in the transaction of the step. The ledger is table user_roles (src/db/schema/authz.ts).
 * Routes: src/server/routes/permissions.ts. The signature rows of the common e-signature service (r1-esign) cover samples, specs
 * and the like; these two signatures are kept with the request itself until that service takes users as an entity.
 */
import { createHash, randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { roles, userRoles } from '../../db/schema/authz';
import { users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { assertActorPassword } from '../auth/credentials';
import { securityEventContext } from '../auth/events';
import { revokeUserSessions, type UserRow } from '../auth/sessions';
import type { Db } from '../core/context';
import { assertChangeAuthorised, consumeChange } from '../qms';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { recordDenied } from './denied';
import { assertIndependent, loadSodRule, SodViolationError } from './sod';

export const ROLE_CHANGE_MEANINGS = {
  request: 'Authorship: I request this change of role and confirm the reason given.',
  approve: 'Approval: as an independent person I authorise this change of role.',
} as const;

export type RoleChangeRow = typeof userRoles.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** SHA-256 over the facts a signature stands for, in a fixed order. Printed with the request so a reviewer can recompute it. */
export function roleChangeSignatureHash(p: {
  stage: 'request' | 'approve'; requestId: string; userId: string; fromRole: string; toRole: string; meaning: string; signerId: string; recordVersion: number; signedAt: Date;
}): string {
  return createHash('sha256').update(JSON.stringify([p.stage, p.requestId, p.userId, p.fromRole, p.toRole, p.meaning, p.signerId, p.recordVersion, p.signedAt.toISOString()])).digest('hex');
}

export function roleChangeView(r: RoleChangeRow, extra: { userName?: string | null; toRole: string }) {
  return {
    id: r.id, userId: r.userId, userName: extra.userName ?? null, fromRole: r.previousRole, toRole: extra.toRole, status: r.status,
    requestedBy: r.requestedBy, requestedAt: iso(r.requestedAt), requestReason: r.requestReason, requestMeaning: r.requestMeaning,
    requestRecordVersion: r.requestRecordVersion, requestSignatureHash: r.requestSignatureHash,
    decidedBy: r.decidedBy, decidedAt: iso(r.decidedAt), decisionReason: r.decisionReason, decisionMeaning: r.decisionMeaning,
    decisionRecordVersion: r.decisionRecordVersion, decisionSignatureHash: r.decisionSignatureHash,
    version: r.version,
  };
}

function requireTraining(actor: UserRow) {
  if (!actor.hasCompletedSoftwareTraining) {
    throw new AppError(403, 'TRAINING_REQUIRED', 'GxP Guardrail: Electronic signatures are disabled because you have not completed the required Software Training. Please contact QA.');
  }
}

async function roleByName(tx: Tx, name: string) {
  const [role] = await tx.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (!role || !role.active) throw new AppError(400, 'UNKNOWN_ROLE', `There is no active role named "${name}".`);
  return role;
}

/** Leaving the system without an active Administrator is never allowed. The active Administrators are locked while it is decided. */
async function assertAnotherAdministrator(tx: Tx, targetId: string) {
  const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'Admin'), eq(users.active, true))).for('update');
  if (!admins.some(a => a.id !== targetId)) throw new AppError(409, 'LAST_ADMIN', 'This is the last active Administrator: the role cannot be removed.');
}

export async function requestRoleChange(db: Db, actor: UserRow, req: Request, input: { userId: string; role: string; reason: string; expectedVersion: number; password: string }) {
  requireTraining(actor);
  if (input.userId === actor.id) {
    throw new AppError(403, 'SELF_CHANGE_FORBIDDEN', 'You cannot change your own role. Ask another Administrator.');
  }
  await assertActorPassword(db, actor, input.password, { entity: 'UserRole', entityId: input.userId, what: 'a role change request' }, securityEventContext(req));

  try {
    return await withTransaction(db, async tx => {
      const target = await lockRow(tx, users, input.userId); // 404 when there is no such user; serialises requests for the same user
      if (target.role === input.role) throw new AppError(400, 'NO_CHANGE', `The user already has the role ${input.role}.`);
      if (target.version !== input.expectedVersion) throw new ConflictError();
      const role = await roleByName(tx, input.role);
      if (target.role === 'Admin' && input.role !== 'Admin') await assertAnotherAdministrator(tx, target.id);
      const [pending] = await tx.select({ id: userRoles.id }).from(userRoles).where(and(eq(userRoles.userId, target.id), eq(userRoles.status, 'Pending'))).limit(1);
      if (pending) throw new AppError(409, 'REQUEST_PENDING', `A role change for this user is already waiting for approval (${pending.id}). Approve, reject or withdraw it first.`);

      const id = `urq-${randomBytes(8).toString('hex')}`;
      const signedAt = new Date();
      const meaning = ROLE_CHANGE_MEANINGS.request;
      const [row] = await tx.insert(userRoles).values({
        id, userId: target.id, roleId: role.id, previousRole: target.role, status: 'Pending',
        requestedBy: actor.id, requestedAt: signedAt, requestReason: input.reason, requestMeaning: meaning, requestRecordVersion: target.version,
        requestSignatureHash: roleChangeSignatureHash({ stage: 'request', requestId: id, userId: target.id, fromRole: target.role, toRole: input.role, meaning, signerId: actor.id, recordVersion: target.version, signedAt }),
      }).returning();
      await writeAudit(tx, actor.id, 'RoleChangeRequested', 'UserRole', id, 'role', target.role, input.role, input.reason);
      return roleChangeView(row, { userName: target.name, toRole: input.role });
    });
  } catch (e: any) {
    // Two requests for the same user at the same moment: the partial unique index decides.
    if ((e?.cause?.code ?? e?.code) === '23505') throw new AppError(409, 'REQUEST_PENDING', 'A role change for this user is already waiting for approval.');
    throw e;
  }
}

async function loadRequest(tx: Tx, id: string) {
  const row = await lockRow(tx, userRoles, id).catch(e => { throw e instanceof NotFoundError ? new NotFoundError('Role change request not found.') : e; });
  const [role] = await tx.select().from(roles).where(eq(roles.id, row.roleId)).limit(1);
  return { row, toRole: role.name };
}

function assertPending(row: RoleChangeRow, expectedVersion: number) {
  if (row.status !== 'Pending') throw new AppError(409, 'REQUEST_NOT_PENDING', `This request is already ${row.status}.`);
  if (row.version !== expectedVersion) throw new ConflictError();
}

/** Both the people the request involves are excluded from deciding it. The requester is checked in front of the route (sod_rules, audit trail); the person it is for here. */
async function assertNotTheTarget(db: Db, req: Request, actor: UserRow, row: RoleChangeRow) {
  const rule = await loadSodRule(db, 'role.grant');
  try {
    assertIndependent([row.userId, row.requestedBy], actor.id, rule, { entity: rule.entity, entityId: row.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, actor, { route: req.route?.path, ...(e.details as object) });
    throw e;
  }
}

export async function approveRoleChange(db: Db, actor: UserRow, req: Request, id: string, input: { password: string; reason?: string; expectedVersion: number }) {
  requireTraining(actor);
  const [before] = await db.select().from(userRoles).where(eq(userRoles.id, id)).limit(1);
  if (!before) throw new NotFoundError('Role change request not found.');
  await assertNotTheTarget(db, req, actor, before);
  // Change control (r2-qms): with the setting on, an Approved change control must affect this user (409 CHANGE_REQUIRED).
  await assertChangeAuthorised(db, { type: 'User', id: before.userId });
  await assertActorPassword(db, actor, input.password, { entity: 'UserRole', entityId: id, what: 'approval of a role change' }, securityEventContext(req));

  return withTransaction(db, async tx => {
    const { row, toRole } = await loadRequest(tx, id);
    assertPending(row, input.expectedVersion);
    const target = await lockRow(tx, users, row.userId);
    if (target.role !== row.previousRole) throw new ConflictError('Conflict: the user\'s role changed after this request was made. Withdraw it and request the change again.');
    if (target.role === 'Admin' && toRole !== 'Admin') await assertAnotherAdministrator(tx, target.id);

    // The version the first signer saw is the predicate: any change to the user since the request is a conflict.
    const changed = await updateVersioned(tx, users, target.id, row.requestRecordVersion, { role: toRole });
    const ended = await revokeUserSessions(tx, target.id, 'role changed');
    await consumeChange(tx, actor.id, { type: 'User', id: target.id }, `Role change ${row.previousRole} to ${toRole} (request ${id})`);

    const signedAt = new Date();
    const meaning = ROLE_CHANGE_MEANINGS.approve;
    const decided = await updateVersioned(tx, userRoles, id, row.version, {
      status: 'Approved', decidedBy: actor.id, decidedAt: signedAt, decisionReason: input.reason ?? null, decisionMeaning: meaning, decisionRecordVersion: changed.version,
      decisionSignatureHash: roleChangeSignatureHash({ stage: 'approve', requestId: id, userId: target.id, fromRole: row.previousRole, toRole, meaning, signerId: actor.id, recordVersion: changed.version, signedAt }),
    });
    const why = `Role change ${row.previousRole} to ${toRole} approved (request ${id}, requested by ${row.requestedBy}: ${row.requestReason})${input.reason ? `. Approver: ${input.reason}` : ''}`;
    await writeAudit(tx, actor.id, 'RoleChangeApproved', 'UserRole', id, 'status', 'Pending', 'Approved', why);
    await writeAudit(tx, actor.id, 'RoleChange', 'User', target.id, 'role', row.previousRole, toRole, `${why}; ${ended} session(s) ended`);
    return { request: roleChangeView(decided, { userName: target.name, toRole }), user: { id: changed.id, role: changed.role, version: changed.version } };
  });
}

async function closeRequest(tx: Tx, actor: UserRow, id: string, status: 'Rejected' | 'Cancelled', input: { reason: string; expectedVersion: number }, check?: (row: RoleChangeRow) => void) {
  const { row, toRole } = await loadRequest(tx, id);
  check?.(row);
  assertPending(row, input.expectedVersion);
  const decided = await updateVersioned(tx, userRoles, id, row.version, { status, decidedBy: actor.id, decidedAt: new Date(), decisionReason: input.reason });
  await writeAudit(tx, actor.id, status === 'Rejected' ? 'RoleChangeRejected' : 'RoleChangeCancelled', 'UserRole', id, 'status', 'Pending', status, input.reason);
  const [target] = await tx.select({ name: users.name }).from(users).where(eq(users.id, row.userId)).limit(1);
  return roleChangeView(decided, { userName: target?.name, toRole });
}

/** A second person declines the request. Signed like an approval: the decision is a decision. The requester withdraws with cancelRoleChange. */
export async function rejectRoleChange(db: Db, actor: UserRow, req: Request, id: string, input: { password: string; reason?: string; expectedVersion: number }) {
  requireTraining(actor);
  if (!input.reason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to reject a request.');
  const reason = input.reason;
  const [before] = await db.select().from(userRoles).where(eq(userRoles.id, id)).limit(1);
  if (!before) throw new NotFoundError('Role change request not found.');
  await assertNotTheTarget(db, req, actor, before);
  await assertActorPassword(db, actor, input.password, { entity: 'UserRole', entityId: id, what: 'rejection of a role change' }, securityEventContext(req));
  return withTransaction(db, tx => closeRequest(tx, actor, id, 'Rejected', { reason, expectedVersion: input.expectedVersion }));
}

/** Only the person who asked can withdraw a pending request. */
export async function cancelRoleChange(db: Db, actor: UserRow, id: string, input: { reason: string; expectedVersion: number }) {
  return withTransaction(db, tx => closeRequest(tx, actor, id, 'Cancelled', input, row => {
    if (row.requestedBy !== actor.id) throw new AppError(403, 'NOT_REQUESTER', 'Only the person who made the request can withdraw it.');
  }));
}

export async function listRoleChanges(db: Db, limit = 200) {
  const rows = await db.select({ r: userRoles, toRole: roles.name, userName: users.name })
    .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).innerJoin(users, eq(users.id, userRoles.userId))
    .orderBy(desc(userRoles.requestedAt)).limit(limit);
  return rows.map(x => roleChangeView(x.r, { userName: x.userName, toRole: x.toRole }));
}
