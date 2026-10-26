// Domain: quality management, deviations, CAPA, change control and audit findings (roadmap M27). Owned by r2-qms.
//
//   GET  /qms/records[?type&state&open&overdue]   the records, newest first, each with `overdue` and the moves it can make next
//   GET  /qms/records/:id                         one record with its actions, links (both ways), comments and effectiveness checks
//   POST /qms/records                             raise a record (number from the server, initial state of its type)
//   PUT  /qms/records/:id                         edit: content while the record is editable, owner and due date until it is final
//   POST /qms/records/:id/transition              an unsigned step of the lifecycle
//   POST /qms/records/:id/sign                    a signed step (approval, closure, rejection, emergency change)
//   POST /qms/records/:id/effectiveness           a signed effectiveness check of a CAPA
//   POST /qms/records/:id/links                   link a CAPA, an affected record, a batch, a sample ...
//   POST /qms/records/:id/comments                append a comment
//   POST /qms/records/:id/actions                 add an action
//   GET  /qms/actions[?overdue&mine&status]       actions across records (the overdue list)
//   PUT  /qms/actions/:id                         edit an open action
//   POST /qms/actions/:id/complete                complete an action: e-signed, with evidence
//   POST /qms/actions/:id/cancel                  cancel an open action (quality unit)
//   GET  /qms/settings, PUT /qms/settings         the change-control requirement; changing it is e-signed
// The rules are in src/server/qms/engine.ts; who may call what is in src/server/authz/routeTable.ts (qms.*).
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import {
  addComment, addLink, cancelAction, completeAction, createAction, createRecord, getRecordDetail, getSettings, listActions, listRecords,
  recordEffectiveness, signRecordStep, transitionRecord, updateAction, updateRecord, updateSettings,
} from '../qms/engine';
import {
  qmsActionCancelSchema, qmsActionCompleteSchema, qmsActionCreateSchema, qmsActionQuerySchema, qmsActionUpdateSchema, qmsCommentSchema,
  qmsCreateSchema, qmsEffectivenessSchema, qmsLinkSchema, qmsRecordQuerySchema, qmsSettingsSchema, qmsSignSchema, qmsTransitionSchema, qmsUpdateSchema,
} from '../qms/schemas';

const flag = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : undefined);

export const qmsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user;

  router.get('/qms/records', requireAuth, validate(qmsRecordQuerySchema, 'query'), async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await listRecords(db, { type: q.type, state: q.state, open: flag(q.open), overdue: flag(q.overdue) }));
  });

  router.get('/qms/records/:id', requireAuth, async (req, res) => {
    res.json(await getRecordDetail(db, String(req.params.id)));
  });

  router.post('/qms/records', requireAuth, validate(qmsCreateSchema), async (req, res) => {
    res.json(await createRecord(db, actor(req), req.body));
  });

  router.put('/qms/records/:id', requireAuth, validate(qmsUpdateSchema), async (req, res) => {
    res.json(await updateRecord(db, req, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/records/:id/transition', requireAuth, validate(qmsTransitionSchema), async (req, res) => {
    res.json(await transitionRecord(db, req, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/records/:id/sign', requireAuth, validate(qmsSignSchema), async (req, res) => {
    res.json(await signRecordStep(db, req, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/records/:id/effectiveness', requireAuth, validate(qmsEffectivenessSchema), async (req, res) => {
    res.json(await recordEffectiveness(db, req, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/records/:id/links', requireAuth, validate(qmsLinkSchema), async (req, res) => {
    res.json(await addLink(db, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/records/:id/comments', requireAuth, validate(qmsCommentSchema), async (req, res) => {
    res.json(await addComment(db, actor(req), String(req.params.id), req.body.text));
  });

  router.post('/qms/records/:id/actions', requireAuth, validate(qmsActionCreateSchema), async (req, res) => {
    res.json(await createAction(db, actor(req), String(req.params.id), req.body));
  });

  router.get('/qms/actions', requireAuth, validate(qmsActionQuerySchema, 'query'), async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(await listActions(db, { ownerId: flag(q.mine) ? actor(req).id : undefined, status: q.status, overdue: flag(q.overdue) }));
  });

  router.put('/qms/actions/:id', requireAuth, validate(qmsActionUpdateSchema), async (req, res) => {
    res.json(await updateAction(db, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/actions/:id/complete', requireAuth, validate(qmsActionCompleteSchema), async (req, res) => {
    res.json(await completeAction(db, req, actor(req), String(req.params.id), req.body));
  });

  router.post('/qms/actions/:id/cancel', requireAuth, validate(qmsActionCancelSchema), async (req, res) => {
    res.json(await cancelAction(db, actor(req), String(req.params.id), req.body));
  });

  router.get('/qms/settings', requireAuth, async (_req, res) => {
    const s = await getSettings(db);
    res.json({ changeControlRequired: s.changeControlRequired, updatedBy: s.updatedBy, updatedAt: s.updatedAt, version: s.version });
  });

  router.put('/qms/settings', requireAuth, validate(qmsSettingsSchema), async (req, res) => {
    res.json(await updateSettings(db, req, actor(req), req.body));
  });

  return router;
};
