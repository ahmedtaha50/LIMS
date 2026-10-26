// Domain: oos. Written by r1-results-oos (roadmap M10), owned by r2-oos-workflow (roadmap M26). Vocabulary: src/lib/constants/oos.ts
// and src/lib/validations/oos.ts. The workflow routes (detail, tasks, assignable cause, retests, settings) are in src/server/oos/routes.ts.
//
//   GET  /oos              every investigation, newest first, with its closure signature, its stage, its due date and `overdue`
//   POST /oos              open one by hand (an OOS result opens one by itself, src/server/services/saveResult.ts); 409 when the
//                          result already has an open investigation
//   PUT  /oos/:id          findings, assignee and the phase (forward only); never the status. The move to Phase II stores when it
//                          started and the Phase II due date
//   POST /oos/:id/close    QA's signature (signRecord, OOS_CLOSURE): status Closed, root cause, conclusion and the decision (required),
//                          under the closure rule (oosClosureProblems): not by the investigator, no open task, Invalidated only with a
//                          confirmed assignable cause and a retest, Confirmed OOS / Inconclusive only after Phase II. A confirmed OOS
//                          opens a deviation (roadmap M27) in the same transaction
import { desc, eq, inArray } from 'drizzle-orm';
import { oosInvestigations, results, samples, signatures, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { OOS_PHASE_TRANSITIONS, OOS_STATUS, isTerminalOosStatus, oosStage, type OosPhase } from '../../lib/constants/oos';
import { closeOosSchema, oosClosureProblems, oosOpenSchema, oosUpdateSchema, type OosClosureDecision } from '../../lib/validations/oos';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { closureState, getOosSettings, phase2Start, presentOos } from '../oos/workflow';
import { autoOpenQmsRecord } from '../qms';
import { openInvestigation, openInvestigationOf } from '../services/saveResult';
import { assertEditable, assertTransition, IllegalTransitionError } from '../workflow/entityStates';

export const oosRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/oos', requireAuth, async (_req, res) => {
    const allOos = await db.select().from(oosInvestigations).orderBy(desc(oosInvestigations.id));
    const sampleIds = [...new Set(allOos.map(o => o.sampleId))];
    const sigs = sampleIds.length ? await db.select().from(signatures).where(inArray(signatures.sampleId, sampleIds)).orderBy(desc(signatures.timestamp)) : [];
    const signerIds = [...new Set(sigs.map(s => s.signerId))];
    const signers = signerIds.length ? await db.select({ id: users.id, name: users.name, role: users.role, email: users.email }).from(users).where(inArray(users.id, signerIds)) : [];
    const userMap = new Map(signers.map(u => [u.id, u]));
    const settings = await getOosSettings(db);

    res.json(allOos.map(oos => {
      // A closure signed through signRecord names the investigation; a v0.1.0 one is found by its sample and its meaning text.
      const sig = sigs.find(s => s.entityType === 'OOS' && s.entityId === oos.id)
        ?? sigs.find(s => !s.entityId && s.sampleId === oos.sampleId && (s.meaning.toLowerCase().includes('oos') || (!!oos.conclusion && !!s.reason?.includes(oos.conclusion))));
      const signer = sig ? userMap.get(sig.signerId) : null;
      return {
        ...presentOos(oos, settings),
        signature: sig ? {
          ...sig,
          printedName: sig.signerName ?? signer?.name ?? sig.signerId,
          signerRole: sig.signerRole ?? signer?.role ?? 'QA Reviewer',
          signerEmail: signer?.email ?? '',
        } : null,
      };
    }));
  });

  router.post('/oos', requireAuth, validate(oosOpenSchema), async (req, res) => {
    const user = (req as any).user;
    const { sampleId, resultId } = req.body as { sampleId: string; resultId: string };
    const created = await withTransaction(db, async (tx) => {
      // The sample lock serialises this with result entry (which opens investigations too) and with a second person opening one.
      const [sample] = await tx.select({ id: samples.id }).from(samples).where(eq(samples.id, sampleId)).for('update');
      const [result] = await tx.select().from(results).where(eq(results.id, resultId)).limit(1);
      if (!sample || !result || result.sampleId !== sampleId) throw new BadRequestError(`Result ${resultId} is not a result of sample ${sampleId}.`);
      const open = await openInvestigationOf(tx, resultId);
      if (open) throw new ConflictError(`Conflict: result ${resultId} already has an open investigation (${open.id}).`);
      return openInvestigation(tx, user.id, result, 'Opened by hand');
    });
    res.json({ ...created, stage: oosStage(created) });
  });

  router.put('/oos/:id', requireAuth, validate(oosUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const body = req.body as { rootCause?: string | null; conclusion?: string | null; assignedTo?: string | null; phase?: OosPhase; expectedVersion: number };

    const updated = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, oosInvestigations, id);
      assertEditable('oos', existing.status);
      if (existing.version !== body.expectedVersion) throw new ConflictError();
      if (body.assignedTo) {
        const [assignee] = await tx.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, body.assignedTo)).limit(1);
        if (!assignee || !assignee.active) throw new BadRequestError(`assignedTo: ${body.assignedTo} is not an active user.`);
      }
      if (body.phase !== undefined && body.phase !== existing.phase) {
        const from = (existing.phase ?? 'Phase I') as OosPhase;
        if (!(OOS_PHASE_TRANSITIONS[from] ?? []).includes(body.phase)) {
          throw new IllegalTransitionError(`The OOS investigation is in ${from}; it cannot go to ${body.phase}.`);
        }
      }

      const changes: Record<string, unknown> = {};
      for (const k of ['rootCause', 'conclusion', 'assignedTo', 'phase'] as const) {
        if (body[k] !== undefined && body[k] !== (existing as any)[k]) changes[k] = body[k];
      }
      // Phase II starts now: its due date replaces the Phase I one (roadmap M26).
      if (changes.phase === 'Phase II' && !existing.phase2StartedAt) Object.assign(changes, phase2Start(await getOosSettings(tx)));
      if (Object.keys(changes).length === 0) return existing;
      const row = await updateVersioned(tx, oosInvestigations, id, body.expectedVersion, changes);
      const column: Record<string, string> = {
        rootCause: 'root_cause', conclusion: 'conclusion', assignedTo: 'assigned_to', phase: 'phase', phase2StartedAt: 'phase2_started_at', dueDate: 'due_date',
      };
      const text = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));
      for (const [k, v] of Object.entries(changes)) {
        await writeAudit(tx, user.id, 'Update', 'OOS', id, column[k], text((existing as any)[k]), text(v), k === 'dueDate' ? 'Phase II started: due date of Phase II' : 'Investigation update');
      }
      return row;
    });
    res.json(presentOos(updated, await getOosSettings(db)));
  });

  router.post('/oos/:id/close', requireAuth, validate(closeOosSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { rootCause, conclusion, decision, password, totpCode, expectedVersion } = req.body as {
      rootCause: string; conclusion: string; decision: OosClosureDecision; password: string; totpCode?: string; expectedVersion?: number;
    };

    /** The closure rule (src/lib/validations/oos.ts): 403 for the investigator, 409 for what is missing. */
    const refusal = async (ex: Parameters<typeof closureState>[0], row: typeof oosInvestigations.$inferSelect) => {
      const [problem] = oosClosureProblems(await closureState(ex, row), decision, user.id);
      return problem ? new AppError(problem.code === 'SOD_VIOLATION' ? 403 : 409, problem.code, problem.message) : null;
    };

    // Decided before the signature is asked for: a refused closure costs the signer no attempt.
    const oos = await db.query.oosInvestigations.findFirst({ where: eq(oosInvestigations.id, id) });
    if (!oos) throw new NotFoundError('OOS investigation record not found');
    assertTransition('oos', isTerminalOosStatus(oos.status) ? oos.status : 'Open', OOS_STATUS.CLOSED);
    const version = expectedVersion ?? oos.version;
    if (oos.version !== version) throw new ConflictError();
    const refused = await refusal(db, oos);
    if (refused) {
      if (refused.code === 'SOD_VIOLATION') await recordDenied(db, req, user, { rule: 'oos.independent-closure', entity: 'OOS', entityId: id });
      throw refused;
    }

    const reason = `Root Cause: ${rootCause} | CAPA: ${conclusion} | Decision: ${decision}`;
    const { result, signature } = await signRecord({
      db, user, meaningCode: 'OOS_CLOSURE', credentials: { password, totpCode }, reason: conclusion,
      entityType: 'OOS', entityId: id, sampleId: oos.sampleId, context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, oosInvestigations, id);
        assertTransition('oos', isTerminalOosStatus(current.status) ? current.status : 'Open', OOS_STATUS.CLOSED);
        const again = await refusal(tx, current);
        if (again) throw again;
        const row = await updateVersioned(tx, oosInvestigations, id, version, { status: OOS_STATUS.CLOSED, rootCause, conclusion, decision });
        // A confirmed OOS is a quality event: its deviation is opened in the closure's transaction (roadmap M27, r2-qms autoOpen).
        const deviation = decision === 'Confirmed OOS'
          ? await autoOpenQmsRecord(tx, {
            source: 'oos-confirmed', sourceId: id, actorId: user.id, title: `Confirmed OOS ${id}: ${current.parameter} (sample ${current.sampleId})`,
            description: `Root cause: ${rootCause}\nConclusion: ${conclusion}`,
          })
          : null;
        return { recordVersion: row.version, audit: { action: 'Close OOS', field: 'status', oldValue: current.status, newValue: OOS_STATUS.CLOSED, reason }, result: { row, deviationId: deviation?.id ?? null } };
      },
    });
    res.json({
      ...presentOos(result.row, await getOosSettings(db)), deviationId: result.deviationId,
      signature: { ...signature, printedName: signature.signerName, signerEmail: user.email },
    });
  });

  return router;
};
