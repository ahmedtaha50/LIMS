/**
 * The stability programme routes (roadmap M31). Mounted by src/server/routes/index.ts; who may call each one is in
 * src/server/authz/routeTable.ts (the body schemas are ./schemas.ts):
 *
 *   GET  /stability/studies/:id              stability.view     the study, its protocol revision and its timepoints
 *   GET  /stability/timepoints[?status=]     stability.view     the pull calendar of Ongoing studies (status Due, Missed, ..., or overdue)
 *   POST /stability/timepoints/:id/pull      sample.register    registers the pull sample inside the window (./studies.ts)
 *   GET  /stability/protocols                stability.view     every revision, with product, author and approver
 *   POST /stability/protocols                stability.manage   revision 1, a Draft
 *   PUT  /stability/protocols/:id            stability.manage   a Draft only (409 PROTOCOL_LOCKED otherwise)
 *   POST /stability/protocols/:id/revise     stability.manage   the next revision, a Draft cloned from the Approved one
 *   POST /stability/protocols/:id/approve    stability.approve  STABILITY_PROTOCOL_APPROVAL, independent of the author and editors
 *   GET|POST /stability/conditions, PUT /stability/conditions/:id   the storage condition master (view / manage)
 *   GET|POST /stability/chambers,   PUT /stability/chambers/:id     the chambers (view / manage)
 * POST /stability, PUT /stability/:id and GET /stability stay in src/server/routes/stability.ts.
 */
import { z } from 'zod';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { BadRequestError } from '../http/errors';
import { validate } from '../http/validate';
import { STABILITY_TIMEPOINT_STATUSES } from '../../db/schema/stability';
import { approveProtocol, createChamber, createCondition, createProtocol, listChambers, listConditions, listProtocols, reviseProtocol, updateChamber, updateCondition, updateProtocol } from './protocols';
import { chamberCreateSchema, chamberUpdateSchema, conditionCreateSchema, conditionUpdateSchema, protocolApproveSchema, protocolCreateSchema, protocolReviseSchema, protocolUpdateSchema, pullSchema } from './schemas';
import { pullCalendar, pullTimepoint, studyDetail } from './studies';

type Body<S extends z.ZodType> = z.infer<S>;
const CALENDAR_FILTERS = [...STABILITY_TIMEPOINT_STATUSES, 'overdue'];

export const stabilityProgrammeRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const user = (req: any) => req.user as { id: string; role: string };

  router.get('/stability/studies/:id', requireAuth, async (req, res) => {
    res.json(await studyDetail(db, String(req.params.id)));
  });

  router.get('/stability/timepoints', requireAuth, async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined;
    if (status && !CALENDAR_FILTERS.includes(status)) throw new BadRequestError(`status must be one of ${CALENDAR_FILTERS.join(', ')}.`);
    res.json(await pullCalendar(db, status));
  });

  router.post('/stability/timepoints/:id/pull', requireAuth, validate(pullSchema), async (req, res) => {
    const { expectedVersion } = req.body as Body<typeof pullSchema>;
    res.json(await pullTimepoint(db, user(req), String(req.params.id), expectedVersion));
  });

  router.get('/stability/protocols', requireAuth, async (_req, res) => { res.json(await listProtocols(db)); });
  router.post('/stability/protocols', requireAuth, validate(protocolCreateSchema), async (req, res) => {
    res.json(await createProtocol(db, user(req), req.body as Body<typeof protocolCreateSchema>));
  });
  router.put('/stability/protocols/:id', requireAuth, validate(protocolUpdateSchema), async (req, res) => {
    res.json(await updateProtocol(db, user(req), String(req.params.id), req.body as Body<typeof protocolUpdateSchema>));
  });
  router.post('/stability/protocols/:id/revise', requireAuth, validate(protocolReviseSchema), async (req, res) => {
    res.json(await reviseProtocol(db, user(req), String(req.params.id)));
  });
  router.post('/stability/protocols/:id/approve', requireAuth, validate(protocolApproveSchema), async (req, res) => {
    const { password, totpCode, reason, expectedVersion } = req.body as Body<typeof protocolApproveSchema>;
    const { result, signature } = await approveProtocol({ db, req, user: user(req), id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason });
    res.json({ protocol: result, signature });
  });

  router.get('/stability/conditions', requireAuth, async (_req, res) => { res.json(await listConditions(db)); });
  router.post('/stability/conditions', requireAuth, validate(conditionCreateSchema), async (req, res) => {
    res.json(await createCondition(db, user(req), req.body as Body<typeof conditionCreateSchema>));
  });
  router.put('/stability/conditions/:id', requireAuth, validate(conditionUpdateSchema), async (req, res) => {
    res.json(await updateCondition(db, user(req), String(req.params.id), req.body as Body<typeof conditionUpdateSchema>));
  });

  router.get('/stability/chambers', requireAuth, async (_req, res) => { res.json(await listChambers(db)); });
  router.post('/stability/chambers', requireAuth, validate(chamberCreateSchema), async (req, res) => {
    res.json(await createChamber(db, user(req), req.body as Body<typeof chamberCreateSchema>));
  });
  router.put('/stability/chambers/:id', requireAuth, validate(chamberUpdateSchema), async (req, res) => {
    res.json(await updateChamber(db, user(req), String(req.params.id), req.body as Body<typeof chamberUpdateSchema>));
  });

  return router;
};
