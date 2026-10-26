// Domain: the OOS investigation workflow (roadmap M26). Owned by r2-oos-workflow; registered in src/server/routes/index.ts and given its
// rules in src/server/authz/routeTable.ts by the wave gate. The investigation's own routes (list, open, edit, close) are in
// src/server/routes/oos.ts.
//
//   GET  /oos/overdue                          open investigations past their due date, most overdue first        oos.view
//   GET  /oos/settings                         retest rules and phase periods                                       oos.view
//   POST /oos/settings                         change them: e-signed (OOS_SETTING_CHANGE, reason)                   oos.settings
//   GET  /oos/checklist-templates              the checklists, every version                                        oos.view
//   POST /oos/checklist-templates              a new version of a checklist                                         oos.settings
//   GET  /oos/:id                              the investigation with due date, tasks, plan, retests, links, signatures  oos.view
//   POST /oos/:id/tasks                        apply a checklist (templateId) or add one task (title)               oos.edit
//   PUT  /oos/:id/tasks/:taskId                reassign, reschedule, or complete with the finding                   oos.edit
//   PUT  /oos/:id/assignable-cause             the investigator's Phase I finding                                   oos.edit
//   POST /oos/:id/assignable-cause/confirm     QA invalidates the original result: e-signed (OOS_INVALIDATION)      oos.approve
//   POST /oos/:id/retest-plan                  QA authorises the retests: e-signed (OOS_RETEST_AUTHORISATION)       oos.approve
//   POST /oos/:id/retests                      one retest under the plan                                            oos.edit
// The rules are in src/server/oos/workflow.ts.
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import {
  oosAssignableCauseSchema, oosChecklistTemplateSchema, oosConfirmCauseSchema, oosRetestPlanSchema, oosRetestSchema, oosSettingsSchema,
  oosTaskCreateSchema, oosTaskUpdateSchema,
} from '../../lib/validations/oos';
import {
  addTasks, addTemplate, authoriseRetests, confirmCause, getDetail, getOosSettings, listOverdue, listTemplates, recordCause, recordRetest,
  updateSettings, updateTask,
} from './workflow';

export const oosWorkflowRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user as { id: string; role: string; email?: string };

  // The fixed paths come before /oos/:id.
  router.get('/oos/overdue', requireAuth, async (_req, res) => {
    res.json(await listOverdue(db));
  });

  router.get('/oos/settings', requireAuth, async (_req, res) => {
    res.json(await getOosSettings(db));
  });

  router.post('/oos/settings', requireAuth, validate(oosSettingsSchema), async (req, res) => {
    res.json(await updateSettings(db, req, actor(req), req.body));
  });

  router.get('/oos/checklist-templates', requireAuth, async (_req, res) => {
    res.json(await listTemplates(db));
  });

  router.post('/oos/checklist-templates', requireAuth, validate(oosChecklistTemplateSchema), async (req, res) => {
    res.json(await addTemplate(db, actor(req), req.body));
  });

  router.get('/oos/:id', requireAuth, async (req, res) => {
    res.json(await getDetail(db, String(req.params.id)));
  });

  router.post('/oos/:id/tasks', requireAuth, validate(oosTaskCreateSchema), async (req, res) => {
    res.json(await addTasks(db, actor(req), String(req.params.id), req.body));
  });

  router.put('/oos/:id/tasks/:taskId', requireAuth, validate(oosTaskUpdateSchema), async (req, res) => {
    res.json(await updateTask(db, actor(req), String(req.params.id), String(req.params.taskId), req.body));
  });

  router.put('/oos/:id/assignable-cause', requireAuth, validate(oosAssignableCauseSchema), async (req, res) => {
    res.json(await recordCause(db, actor(req), String(req.params.id), req.body));
  });

  router.post('/oos/:id/assignable-cause/confirm', requireAuth, validate(oosConfirmCauseSchema), async (req, res) => {
    const user = actor(req);
    const { result, signature } = await confirmCause(db, req, user, String(req.params.id), req.body);
    res.json({ investigation: result, signature: { ...signature, printedName: signature.signerName, signerEmail: user.email } });
  });

  router.post('/oos/:id/retest-plan', requireAuth, validate(oosRetestPlanSchema), async (req, res) => {
    const user = actor(req);
    const { plan, signature } = await authoriseRetests(db, req, user, String(req.params.id), req.body);
    res.json({ plan, signature: { ...signature, printedName: signature.signerName, signerEmail: user.email } });
  });

  router.post('/oos/:id/retests', requireAuth, validate(oosRetestSchema), async (req, res) => {
    res.json(await recordRetest(db, req, actor(req), String(req.params.id), req.body));
  });

  return router;
};
