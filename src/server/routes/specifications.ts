/**
 * Domain: specifications (roadmap M11; parameters bound to methods and formulas, roadmap M18). Owned by r2-methods-calc, which took it
 * over from r1-spec.
 *
 *   GET  /specifications               every revision, with its revision number, author, approver, what it is today (effectiveness)
 *                                      and, for a Draft, what approving it would replace and how many samples that touches
 *   POST /specifications               a Draft: revision 1 of a new material, or (reviseFrom) the next revision of an Active one,
 *                                      cloned from it. The revision number and the author are the server's.
 *   PUT  /specifications/:id           the limits and/or the effective date of a Draft (optimistic concurrency on `version`). A
 *                                      parameter may name its method, formula, replicates and stage (M18); the method and the
 *                                      formula must exist. They are kept beside the limit in the signed JSONB, and the database
 *                                      mirrors every parameter into spec_parameters in the same statement (migration 0110).
 *   POST /specifications/:id/approve   the electronic signature SPECIFICATION_APPROVAL through signRecord: never the author or an editor,
 *                                      QA or Admin with the software training; the revisions it replaces become Obsolete in the same
 *                                      transaction. While samples of the material are Logged or Testing, only QA can approve, by signing
 *                                      an exception with a reason.
 *
 * `version` is the optimistic-concurrency counter (every write adds 1); `revisionLabel` is the revision (Rev 1, Rev 2, ...) and never
 * changes after the Draft is created. Who may call what, which body keys reach a route, and the state and independence checks in front
 * of it are in src/server/authz/routeTable.ts; the handlers repeat the checks they depend on.
 */
import { randomBytes } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Request } from 'express';
import { samples, specifications, users } from '../../db/schema';
import { calcFormulas } from '../../db/schema/calc';
import { methods } from '../../db/schema/methods';
import { writeAudit } from '../../db/utils';
import { bindingOf, specificationUpdateWithBindingSchema, type BoundSpecParameter } from '../../lib/validations/methods';
import {
  isEffectiveDate, normalizeParameters, specificationApproveSchema, specificationSchema, specParametersSchema, toStoredParameters,
} from '../../lib/validations/specifications';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, auditParticipants, loadSodRule, SodViolationError } from '../authz/sod';
import { type Db, type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { updateVersioned, withTransaction, type Executor } from '../core/tx';
import { signRecord } from '../esign';
import { assertChangeAuthorised, consumeChange } from '../qms';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { effectivenessOf, materialKey, materialKeySql, todayIso, type Effectiveness } from '../lib/specs';
import { assertEditable, assertTransition } from '../workflow/entityStates';

type SpecRow = typeof specifications.$inferSelect;

/** Sample states in which a sample is still being tested against the specification it was registered under. */
export const IN_PROGRESS_STATES = ['Logged', 'Testing'] as const;

/** The parameters of a stored specification in the current shape, each with its binding (method, formula, replicates, stage) if any. */
function boundParameters(raw: unknown): BoundSpecParameter[] {
  const list = Array.isArray(raw) ? raw : [];
  return normalizeParameters(list).map((p, i) => ({ ...p, ...bindingOf(list[i]) }));
}

/** The API shape of a specification: the limits always in the current shape, whatever shape they were stored in. */
function present(row: SpecRow) {
  return {
    id: row.id, material: row.material, revisionLabel: row.revisionLabel, version: row.version, effectiveDate: row.effectiveDate,
    status: row.status, parameters: boundParameters(row.parameters), createdBy: row.createdBy, approvedBy: row.approvedBy,
  };
}

/** The methods and formulas a parameter names must exist (an approval or an Effective revision is required only to enter results). */
async function assertBindingsExist(ex: Executor, params: readonly BoundSpecParameter[]) {
  const problems: string[] = [];
  for (const p of params) {
    if (p.method_code) {
      const [m] = await ex.select({ id: methods.id }).from(methods).where(sql`lower(${methods.code}) = ${p.method_code.toLowerCase()}`).limit(1);
      if (!m) problems.push(`${p.name}: the method ${p.method_code} does not exist.`);
    }
    if (p.formula_code) {
      const [f] = await ex.select({ id: calcFormulas.id }).from(calcFormulas).where(sql`lower(${calcFormulas.code}) = ${p.formula_code.toLowerCase()}`).limit(1);
      if (!f) problems.push(`${p.name}: the formula ${p.formula_code} does not exist.`);
    }
  }
  if (problems.length) throw new AppError(400, 'BAD_REQUEST', problems.join(' '), problems.map(message => ({ path: 'parameters', message })));
}

/** Holds, until the transaction ends, the right to change the revisions of one material (create, approve). */
const lockMaterial = (tx: Executor, material: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`specifications:${materialKey(material)}`}))`);

const revisionsOf = (ex: Executor, material: string) =>
  ex.select().from(specifications).where(sql`${materialKeySql(specifications.material)} = ${materialKey(material)}`);

async function samplesInProgress(ex: Executor, material: string): Promise<number> {
  const [r] = await ex.select({ n: sql<number>`count(*)::int` }).from(samples)
    .where(and(inArray(samples.state, [...IN_PROGRESS_STATES]), sql`${materialKeySql(samples.material)} = ${materialKey(material)}`));
  return Number(r?.n ?? 0);
}

interface ApprovalPlan {
  /** The Active revisions that approving the Draft makes Obsolete now. */
  supersedes: SpecRow[];
  /** An Active revision dated after the Draft: it would take over from the Draft on its own date. */
  laterScheduled: SpecRow | null;
}

/**
 * What approving `draft` does to the other revisions of its material. A Draft that takes effect today (its date is not in the future:
 * an earlier date is refused) replaces every Active revision dated on or before it. One dated in the future replaces nothing yet:
 * the current revision stays in force until that day (resolveActiveSpec chooses by date).
 */
function planApproval(revisions: readonly SpecRow[], draft: SpecRow, today: string): ApprovalPlan {
  const others = revisions.filter(r => r.id !== draft.id && r.status === 'Active');
  const laterScheduled = others.find(r => isEffectiveDate(r.effectiveDate) && r.effectiveDate > draft.effectiveDate) ?? null;
  const supersedes = draft.effectiveDate <= today
    ? others.filter(r => !isEffectiveDate(r.effectiveDate) || r.effectiveDate <= draft.effectiveDate)
    : [];
  return { supersedes, laterScheduled };
}

/** Refuses an approval that would make something the laboratory cannot test against, or leave two revisions in force. */
function assertApprovable(draft: SpecRow, today: string, plan: ApprovalPlan) {
  const params = normalizeParameters(draft.parameters);
  if (params.length === 0) {
    throw new AppError(400, 'SPEC_INCOMPLETE', `Revision ${draft.revisionLabel} of ${draft.material} has no limits: a specification needs at least one parameter before it can be approved.`);
  }
  const parsed = specParametersSchema.safeParse(params);
  if (!parsed.success) {
    const details = parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'SPEC_INCOMPLETE', `The limits must be corrected before approval: ${details.map(d => d.message).join(' ')}`, details);
  }
  if (!isEffectiveDate(draft.effectiveDate)) {
    throw new AppError(400, 'SPEC_INCOMPLETE', `The effective date "${draft.effectiveDate}" is not a date written YYYY-MM-DD. Correct it before approval.`);
  }
  if (draft.effectiveDate < today) {
    throw new AppError(400, 'SPEC_EFFECTIVE_DATE_PAST',
      `The effective date ${draft.effectiveDate} is in the past. A revision cannot take effect for days on which another one was in use: set today (${today}) or a later date.`);
  }
  if (plan.laterScheduled) {
    const s = plan.laterScheduled;
    throw new AppError(409, 'SPEC_LATER_REVISION_SCHEDULED',
      `Revision ${s.revisionLabel} (${s.id}) is approved to take effect on ${s.effectiveDate}, after this revision's date (${draft.effectiveDate}), and would replace it on that day. Give this revision a date on or after ${s.effectiveDate}.`,
      { scheduled: s.id, effectiveDate: s.effectiveDate });
  }
}

/** Independence of the approver: never the recorded author, never anyone the audit trail shows creating or editing the record. */
async function assertApproverIndependent(db: Db, req: Request, user: { id: string; role: string }, spec: SpecRow) {
  const rule = await loadSodRule(db, 'spec.approve');
  const participants = await auditParticipants(db, rule.entity, spec.id, rule.authorActions);
  try {
    assertIndependent([spec.createdBy, ...participants], user.id, rule, { entity: rule.entity, entityId: spec.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, user, { route: 'POST /specifications/:id/approve', ...(e.details as object) });
    throw e;
  }
}

export const specificationsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/specifications', requireAuth, async (_req, res) => {
    const author = alias(users, 'spec_author');
    const approver = alias(users, 'spec_approver');
    const rows = await db.select({ spec: specifications, createdByName: author.name, approvedByName: approver.name })
      .from(specifications)
      .leftJoin(author, eq(author.id, specifications.createdBy))
      .leftJoin(approver, eq(approver.id, specifications.approvedBy))
      .orderBy(specifications.material, specifications.revisionLabel);
    const inProgress = new Map<string, number>();
    for (const r of await db.select({ key: materialKeySql(samples.material).mapWith(String), n: sql<number>`count(*)::int` })
      .from(samples).where(inArray(samples.state, [...IN_PROGRESS_STATES])).groupBy(materialKeySql(samples.material))) {
      inProgress.set(r.key, Number(r.n));
    }

    const today = todayIso();
    const byMaterial = new Map<string, SpecRow[]>();
    for (const { spec } of rows) {
      const key = materialKey(spec.material);
      byMaterial.set(key, [...(byMaterial.get(key) ?? []), spec]);
    }
    const effectiveness = new Map<string, Effectiveness>();
    for (const list of byMaterial.values()) for (const [id, e] of effectivenessOf(list, today)) effectiveness.set(id, e);

    res.json(rows.map(({ spec, createdByName, approvedByName }) => {
      const out: Record<string, unknown> = { ...present(spec), createdByName, approvedByName, effectiveness: effectiveness.get(spec.id) };
      if (spec.status === 'Draft') {
        const key = materialKey(spec.material);
        const plan = planApproval(byMaterial.get(key)!, spec, today);
        out.approval = { supersedes: plan.supersedes.map(s => s.id), samplesInProgress: plan.supersedes.length > 0 ? (inProgress.get(key) ?? 0) : 0 };
      }
      return out;
    }));
  });

  router.post('/specifications', requireAuth, validate(specificationSchema), async (req, res) => {
    const user = (req as any).user;
    const { material, effectiveDate, reviseFrom } = req.body as { material: string; effectiveDate: string; reviseFrom?: string };

    const created = await withTransaction(db, async (tx) => {
      await lockMaterial(tx, material);
      let source: SpecRow | undefined;
      if (reviseFrom) {
        [source] = await tx.select().from(specifications).where(eq(specifications.id, reviseFrom)).limit(1);
        if (!source) throw new NotFoundError(`Specification ${reviseFrom} was not found.`);
        if (materialKey(source.material) !== materialKey(material)) {
          throw new AppError(409, 'SPEC_REVISE_MATERIAL', `Specification ${source.id} is for ${source.material}, not ${material}. A revision keeps the material of the one it revises.`);
        }
        if (source.status !== 'Active') {
          throw new AppError(409, 'SPEC_REVISE_NOT_ACTIVE', `Specification ${source.id} is ${source.status}. A new revision is drafted from an Active (approved) revision.`);
        }
      }

      const revisions = await revisionsOf(tx, material);
      const spelled = revisions.find(r => r.material !== material);
      if (spelled) {
        throw new AppError(409, 'SPEC_MATERIAL_SPELLING',
          `This material is already registered as "${spelled.material}". Use exactly that name, so that samples and specifications match.`, { material: spelled.material });
      }
      const draft = revisions.find(r => r.status === 'Draft');
      if (draft) {
        throw new AppError(409, 'SPEC_DRAFT_EXISTS',
          `Revision ${draft.revisionLabel} of ${material} (${draft.id}) is already a Draft. Edit and approve it; a material has one Draft at a time.`, { draft: draft.id });
      }
      const active = revisions.filter(r => r.status === 'Active').sort((a, b) => b.revisionLabel - a.revisionLabel);
      if (!source && active.length > 0) {
        throw new AppError(409, 'SPEC_REVISE_REQUIRED',
          `${material} already has an approved specification (${active.map(a => `${a.id}, revision ${a.revisionLabel}`).join('; ')}). Create a new revision of it instead.`,
          { active: active.map(a => a.id) });
      }

      const revisionLabel = revisions.reduce((max, r) => Math.max(max, r.revisionLabel), 0) + 1;
      const row = {
        id: `SPEC-${randomBytes(4).toString('hex')}`, material, version: 1, revisionLabel, effectiveDate, status: 'Draft',
        parameters: source ? toStoredParameters(boundParameters(source.parameters)) : [], createdBy: user.id, approvedBy: null,
      };
      const [inserted] = await tx.insert(specifications).values(row).returning();
      await writeAudit(tx, user.id, 'Create', 'Specification', row.id, 'all', '', JSON.stringify(row),
        source ? `Revision ${revisionLabel} of ${material} drafted from revision ${source.revisionLabel} (${source.id})` : `Revision 1 of ${material} drafted`);
      return inserted;
    });
    res.json(present(created));
  });

  router.put('/specifications/:id', requireAuth, validate(specificationUpdateWithBindingSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { parameters, effectiveDate, expectedVersion } = req.body as { parameters?: BoundSpecParameter[]; effectiveDate?: string; expectedVersion: number };

    const updated = await withTransaction(db, async (tx) => {
      const [existing] = await tx.select().from(specifications).where(eq(specifications.id, id)).limit(1);
      if (!existing) throw new NotFoundError(`Specification ${id} was not found.`);
      assertEditable('specification', existing.status);
      if (existing.version !== expectedVersion) throw new ConflictError();
      if (parameters !== undefined) await assertBindingsExist(tx, parameters);

      const set: Partial<SpecRow> = {};
      const stored = parameters !== undefined ? toStoredParameters(parameters) : undefined;
      if (stored) set.parameters = stored;
      if (effectiveDate !== undefined) set.effectiveDate = effectiveDate;
      const row = await updateVersioned(tx, specifications, id, expectedVersion, set);

      const what = `revision ${existing.revisionLabel} of ${existing.material}`;
      if (stored) {
        await writeAudit(tx, user.id, 'Update', 'Specification', id, 'parameters', JSON.stringify(existing.parameters), JSON.stringify(stored), `Limits of ${what} edited`);
      }
      if (effectiveDate !== undefined) {
        await writeAudit(tx, user.id, 'Update', 'Specification', id, 'effective_date', existing.effectiveDate, effectiveDate, `Effective date of ${what} changed`);
      }
      return row;
    });
    res.json(present(updated));
  });

  router.post('/specifications/:id/approve', requireAuth, validate(specificationApproveSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { password, totpCode, reason, expectedVersion, exceptionReason } = req.body as {
      password: string; totpCode?: string; reason?: string; expectedVersion: number; exceptionReason?: string;
    };

    // Everything that can be decided without the password is decided first: a refusal here costs the signer no attempt.
    const [spec] = await db.select().from(specifications).where(eq(specifications.id, id)).limit(1);
    if (!spec) throw new NotFoundError(`Specification ${id} was not found.`);
    assertTransition('specification', spec.status, 'Active');
    await assertApproverIndependent(db, req, user, spec);
    if (spec.version !== expectedVersion) throw new ConflictError();
    const today = todayIso();

    /** The supersession and the exception rule, decided on what `ex` sees (again inside the signing transaction). */
    const decide = async (ex: Executor, draft: SpecRow) => {
      const plan = planApproval(await revisionsOf(ex, draft.material), draft, today);
      assertApprovable(draft, today, plan);
      const inProgress = plan.supersedes.length > 0 ? await samplesInProgress(ex, draft.material) : 0;
      if (exceptionReason !== undefined) {
        if (inProgress === 0) {
          throw new AppError(400, 'SPEC_EXCEPTION_NOT_NEEDED', 'No sample of this material is in progress under a revision this approval replaces: there is nothing to make an exception for. Remove the exception.');
        }
        if (user.role !== 'QA') {
          throw new AppError(403, 'SPEC_EXCEPTION_ROLE', 'Only the quality unit (QA) can sign an exception for samples in progress.');
        }
      } else if (inProgress > 0) {
        throw new AppError(409, 'SPEC_SAMPLES_IN_PROGRESS',
          `${inProgress} sample(s) of ${draft.material} are Logged or Testing under the revision this approval replaces (${plan.supersedes.map(s => s.id).join(', ')}). Wait until they are finished, or QA can approve with a signed exception.`,
          { samplesInProgress: inProgress, supersedes: plan.supersedes.map(s => s.id) });
      }
      return { plan, inProgress };
    };
    const first = await decide(db, spec);
    // Change control (r2-qms): with the setting on, an Approved change control must affect this revision (409 CHANGE_REQUIRED).
    await assertChangeAuthorised(db, { type: 'Specification', id });

    const parts = [reason?.trim(), exceptionReason ? `QA exception for ${first.inProgress} sample(s) in progress: ${exceptionReason}` : undefined].filter(Boolean);
    const signedReason = parts.join(' | ');
    const label = `revision ${spec.revisionLabel} of ${spec.material}`;

    const { result, signature } = await signRecord({
      db, user, meaningCode: 'SPECIFICATION_APPROVAL', credentials: { password, totpCode }, reason: signedReason || undefined,
      entityType: 'Specification', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        await lockMaterial(tx, spec.material);
        const [current] = await tx.select().from(specifications).where(eq(specifications.id, id)).limit(1);
        if (!current) throw new NotFoundError(`Specification ${id} was not found.`);
        // Decided again under the lock: a sample registered or a revision approved since the check above counts. A concurrent
        // approval or edit of this Draft is caught by the version predicate of the update below (409), which rolls all of this back.
        const { plan } = await decide(tx, current);

        for (const old of plan.supersedes) {
          await updateVersioned(tx, specifications, old.id, old.version, { status: 'Obsolete' });
          await writeAudit(tx, user.id, 'StatusChange', 'Specification', old.id, 'status', 'Active', 'Obsolete',
            `Superseded by revision ${current.revisionLabel} (${id}), effective ${current.effectiveDate}`);
        }
        const row = await updateVersioned(tx, specifications, id, expectedVersion, { status: 'Active', approvedBy: user.id });
        await consumeChange(tx, user.id, { type: 'Specification', id }, `Approval of ${label}`);
        return {
          recordVersion: row.version,
          audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Active', reason: signedReason || `Approved ${label} for use from ${row.effectiveDate}` },
          result: row,
        };
      },
    });
    res.json({ ...present(result), signature });
  });

  return router;
};
