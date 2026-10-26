/**
 * THE ROUTE TABLE (roadmap M09). Every route of the API is listed here, once, as "METHOD /path" (relative to /api, as the route
 * module registers it), with who may call it:
 *
 *   perm(code, ...)  the signed-in user's role must hold the permission `code` (src/lib/permissions.ts, table role_permissions);
 *   self             the account's own data: the route authenticates itself, no privilege is needed;
 *   PUBLIC           no sign-in: the sign-in routes and the health probes.
 *
 * and, for a route that changes data, `body`: the keys it accepts. Any other key is a 400 before the handler runs (AGENTS.md
 * section 3). Beyond that a rule may name a state guard (the record must be editable, or the move legal: 423 / 409), an
 * independence rule (the signer did not author the record: 403) and a custom guard.
 *
 * This table is applied by the middleware in ./middleware.ts as a whole, in front of the route modules, so the route files are
 * not edited. A request whose route has no entry never reaches a handler, and the server does not start when a registered route
 * has no entry (./contract.ts, checked by tests/api/route-contract.test.ts): a new route is unusable until someone has decided
 * who may call it.
 *
 * To add a route: add its line here (and its permission code to src/lib/permissions.ts with a migration if it is new). Where the
 * route module already has a strict Zod schema, give the same schema as `body` so the two cannot drift.
 */
import { preferencesSchema } from '../../i18n/server/routes';
import { auditExportBody, emptyBody } from '../audit/schemas';
import { AUDIT_REVIEW_KEYS, auditReviewSettingsBody, clockAcknowledgeBody } from '../routes/audit-review';
import { aiIntegrationSchema, broadcastSchema, createUserSchema, settingsUpdateSchema, updateUserSchema, userActionSchema } from '../../lib/validations/admin';
import { capaAnalysisSchema, elnProtocolSchema, transcribeSchema } from '../../lib/validations/ai';
import { changePasswordSchema, loginSchema, passwordOnlySchema, reauthSchema, totpConfirmSchema, totpSetupSchema, totpVerifySchema } from '../../lib/validations/auth';
import { elnCreateSchema, elnSignSchema, elnUpdateSchema, notebookEntrySchema, notebookTemplateSchema } from '../../lib/validations/eln';
import { envRecordSchema, envRecordUpdateSchema } from '../../lib/validations/env';
import {
  batchRoomCreateSchema, batchRoomUpdateSchema, emptyBodySchema as emEmptyBody, identificationSchema, pointCreateSchema, pointRetireSchema, pointUpdateSchema,
  profileApproveSchema, profileCreateSchema, profileUpdateSchema, resultCorrectionSchema, resultCreateSchema, trendAcknowledgeSchema,
} from '../em/schemas';
import { calibrateSchema, instrumentSchema } from '../../lib/validations/instruments';
import { batchCreateSchema, batchSampleSchema, batchStatusSchema, batchUpdateSchema, customerCreateSchema, customerStatusSchema, customerUpdateSchema, productCreateSchema, productStatusSchema, productUpdateSchema } from '../../lib/validations/master';
import {
  calcEntrySchema, calcEvaluateSchema, configApproveSchema, formulaCreateSchema, formulaUpdateSchema, methodCreateSchema, methodUpdateSchema,
  reviseSchema, sstRunSchema, testPlanCreateSchema, testPlanUpdateSchema,
} from '../../lib/validations/methods';
import {
  closeOosSchema, oosAssignableCauseSchema, oosChecklistTemplateSchema, oosConfirmCauseSchema, oosOpenSchema, oosRetestPlanSchema, oosRetestSchema,
  oosSettingsSchema, oosTaskCreateSchema, oosTaskUpdateSchema, oosUpdateSchema,
} from '../../lib/validations/oos';
import { batchReleaseSchema } from '../../lib/validations/release';
import {
  qmsActionCancelSchema, qmsActionCompleteSchema, qmsActionCreateSchema, qmsActionUpdateSchema, qmsCommentSchema, qmsCreateSchema, qmsEffectivenessSchema,
  qmsLinkSchema, qmsSettingsSchema, qmsSignSchema, qmsTransitionSchema, qmsUpdateSchema,
} from '../qms/schemas';
import { importAcceptSchema, importRejectSchema } from '../routes/instrument-files';
import { instrumentProfileApproveSchema, instrumentProfileCreateSchema, instrumentProfileDryRunSchema, instrumentProfileRetireSchema, instrumentProfileUpdateSchema } from '../routes/instrument-profiles';
import { reagentSchema } from '../../lib/validations/reagents';
import {
  preparedSolutionSchema, reagentCloseSchema, reagentConsumeSchema, reagentItemCreateSchema, reagentItemUpdateSchema, reagentLotOpenSchema,
  reagentLotReceiptSchema, reagentLotRejectSchema, reagentLotRetestSchema, reagentLotSignSchema, resultMaterialLinkSchema, resultMaterialWithdrawSchema,
} from '../routes/reagents';
import { coaCopySchema, coaIssueSchema, coaReissueSchema, coaVoidSchema } from '../reports/schemas';
import {
  aliquotSchema, consumeSchema, disposeSchema, labelPrintSchema, locationCreateSchema, locationUpdateSchema, receiptAckSchema, receiptSchema,
  retainSchema, transferSchema,
} from '../custody/schemas';
import {
  cancelSchema as worklistCancelSchema, completeSchema as worklistCompleteSchema, gridSaveSchema, itemAddSchema, itemRemoveSchema, itemUpdateSchema,
  releaseSchema as worklistReleaseSchema, reorderSchema, worklistCreateSchema, worklistUpdateSchema,
} from '../worklists/schemas';
import { resultUpdateSchema } from '../../lib/validations/results';
import { resultsBatchSchema } from '../../lib/validations/results-batch';
import { bulkImportSchema, sampleRegistrationSchema, transitionSchema } from '../../lib/validations/samples';
import { specificationApproveSchema, specificationSchema, specificationUpdateSchema } from '../../lib/validations/specifications';
import { chamberCreateSchema, chamberUpdateSchema, conditionCreateSchema, conditionUpdateSchema, protocolApproveSchema, protocolCreateSchema, protocolReviseSchema, protocolUpdateSchema, pullSchema, studyCloseSchema, studyCreateSchema } from '../stability/schemas';
import {
  assignmentCreateSchema, assignmentSignSchema, certifySchema, curriculumCreateSchema, curriculumUpdateSchema, documentCreateSchema, documentReviseSchema,
  overrideRevokeSchema, overrideSchema, versionObsoleteSchema, versionPrintSchema, versionReturnSchema, versionSignSchema, versionUpdateSchema,
} from '../training/schemas';
import type { PermissionCode } from '../../lib/permissions';
import { decideRoleChangeSchema, requestRoleChangeSchema, withdrawRoleChangeSchema } from './schemas';
import { forbidUnapprovedPrivilegedRoleChange } from './roleGrant';
import { sampleExportSchema } from '../routes/lookup';
import { reintegrationSignSchema, reviewChecklistSchema } from '../routes/review';
import { apiClientCreateSchema, apiClientRevokeSchema } from '../routes/api-clients';
import { deliveryRetrySchema, subscriptionCreateSchema, subscriptionStatusSchema } from '../routes/subscriptions';
import { qualifiedStatusSchema } from '../qualified';
import { alertAcknowledgeSchema, baselineCreateSchema, emptyBodySchema as spcEmptyBody } from '../stats/schemas';
import { buildSchema, decideSchema } from '../archive';
import { planCreateSchema, planUpdateSchema, reviewCancelSchema, reviewCompleteSchema, reviewDraftSchema } from '../periodic';
import { flagSchema, flagWithdrawSchema, holdPlaceSchema, holdReleaseSchema, policySchema } from '../retention';
import { breakGlassSchema, directorySettingsSchema, directoryTestSchema, mappingCreateSchema, mappingDecisionSchema } from '../routes/directory';
import { calendarSchema, holidayCreateSchema, holidayRemoveSchema, sampleTatSchema, slaSchema } from '../routes/metrics';
import type { BodySpec, RouteRule } from './types';

const perm = (permission: PermissionCode, extra: Omit<Extract<RouteRule, { kind: 'perm' }>, 'kind' | 'permission'> = {}): RouteRule => ({ kind: 'perm', permission, ...extra });
const SELF = (body?: BodySpec): RouteRule => ({ kind: 'self', body });
const PUBLIC = (body?: BodySpec): RouteRule => ({ kind: 'public', body });
/** A route that changes data and takes no body. */
const NO_BODY: BodySpec = [];

export const ROUTE_RULES: Readonly<Record<string, RouteRule>> = {
  // --- sign-in and the account's own session ------------------------------------------------------------------------------
  'GET /health': PUBLIC(),
  'GET /ready': PUBLIC(),
  'POST /auth/login-local': PUBLIC(loginSchema),
  'POST /auth/totp-setup': PUBLIC(totpSetupSchema),
  'POST /auth/totp-verify': PUBLIC(totpVerifySchema),
  'GET /auth/me': SELF(),
  'POST /auth/logout': SELF(NO_BODY),
  'POST /auth/reauth': SELF(reauthSchema),
  'POST /auth/change-password': SELF(changePasswordSchema),
  'POST /auth/totp-enroll': SELF(passwordOnlySchema),
  'POST /auth/totp-confirm': SELF(totpConfirmSchema),
  'POST /auth/recovery-codes': SELF(passwordOnlySchema),
  // Display language and digit style of the signed-in user (r3-i18n, roadmap M38): the caller's own row only; no GxP data depends on it.
  'GET /me/preferences': SELF(),
  'PUT /me/preferences': SELF(preferencesSchema),

  // --- samples and results ----------------------------------------------------------------------------------------------
  'GET /samples': perm('sample.view'),
  'POST /samples': perm('sample.register', { body: sampleRegistrationSchema }),
  'POST /samples/bulk-import': perm('sample.register', { body: bulkImportSchema }),
  'GET /samples/:id': perm('sample.view'),
  // The role allowed for each step (submit, review, approve, reject) is the workflow's: src/server/workflow/transitions.ts.
  'POST /samples/:id/transition': perm('sample.transition', { body: transitionSchema }),
  'POST /samples/:id/notebook': perm('sample.notebook.add', { body: notebookEntrySchema }),
  'PUT /samples/:id/results/:resultId': perm('result.enter', { body: resultUpdateSchema }),
  // The bench workbench (r2-result-ui, roadmap M19): every changed row of one sample in one transaction; each row as the line above.
  'PUT /samples/:id/results-batch': perm('result.enter', { body: resultsBatchSchema }),
  // Raw data (r2-raw-data, roadmap M20). The file is the body (application/octet-stream): no JSON key is accepted. The handlers keep
  // the entry roles (Analyst, Admin) and the sample state; the review checklist is recorded by the workflow's reviewers.
  'POST /samples/:id/attachments': perm('result.enter', { body: NO_BODY }),
  'GET /samples/:id/attachments': perm('sample.view'),
  'GET /attachments/:id/content': perm('sample.view'),
  'GET /samples/:id/result-versions': perm('sample.view'),
  'POST /result-versions/:id/sign': perm('result.reintegration.approve', { body: reintegrationSignSchema }),
  'GET /samples/:id/review-checklist': perm('sample.view'),
  'POST /samples/:id/review-checklist': perm('sample.transition', { body: reviewChecklistSchema }),

  // --- OOS investigations -----------------------------------------------------------------------------------------------
  'GET /oos': perm('oos.view'),
  'POST /oos': perm('oos.open', { body: oosOpenSchema }),
  // No `status` key: the status moves only when the closure is signed. A closed investigation is frozen (423).
  'PUT /oos/:id': perm('oos.edit', { body: oosUpdateSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'POST /oos/:id/close': perm('oos.close', { body: closeOosSchema, state: { entity: 'oos', param: 'id', require: 'transition', to: 'Closed' } }),
  // r2-oos-workflow (roadmap M26, src/server/oos/routes.ts): due dates, tasks, assignable cause, retests, settings.
  'GET /oos/overdue': perm('oos.view'),
  'GET /oos/settings': perm('oos.view'),
  'POST /oos/settings': perm('oos.settings', { body: oosSettingsSchema }),
  'GET /oos/checklist-templates': perm('oos.view'),
  'POST /oos/checklist-templates': perm('oos.settings', { body: oosChecklistTemplateSchema }),
  'GET /oos/:id': perm('oos.view'),
  'POST /oos/:id/tasks': perm('oos.edit', { body: oosTaskCreateSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'PUT /oos/:id/tasks/:taskId': perm('oos.edit', { body: oosTaskUpdateSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'PUT /oos/:id/assignable-cause': perm('oos.edit', { body: oosAssignableCauseSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'POST /oos/:id/assignable-cause/confirm': perm('oos.approve', { body: oosConfirmCauseSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'POST /oos/:id/retest-plan': perm('oos.approve', { body: oosRetestPlanSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),
  'POST /oos/:id/retests': perm('oos.edit', { body: oosRetestSchema, state: { entity: 'oos', param: 'id', require: 'editable' } }),

  // --- specifications ---------------------------------------------------------------------------------------------------
  'GET /specifications': perm('spec.view'),
  'POST /specifications': perm('spec.create', { body: specificationSchema }),
  'PUT /specifications/:id': perm('spec.edit', { body: specificationUpdateSchema, state: { entity: 'specification', param: 'id', require: 'editable' } }),
  'POST /specifications/:id/approve': perm('spec.approve', {
    body: specificationApproveSchema,
    state: { entity: 'specification', param: 'id', require: 'transition', to: 'Active' },
    sod: { rule: 'spec.approve', param: 'id' },
  }),

  // --- batch records and traceability -----------------------------------------------------------------------------------
  'GET /traceability/batches': perm('trace.view'),
  'GET /traceability/batch/:batch': perm('trace.view'),
  // r1-quality-fixes: `verifier` is the second person ({ email, password, totpCode? }); the route's strict schema is batchMaterialSchema.
  'POST /traceability/batch/:batch/material': perm('trace.dispense', {
    body: ['materialName', 'materialType', 'lotNumber', 'manufacturer', 'coaNumber', 'coaStatus', 'quantityDispensed', 'potencyAssay', 'lossOnDrying', 'verifier'],
  }),
  'POST /traceability/batch/:batch/release': perm('batch.release', {
    body: batchReleaseSchema,
    state: { entity: 'batchRelease', param: 'batch', require: 'transition', to: 'Released' },
  }),
  'GET /traceability/batch/:batch/verify-chain': perm('record.verify'),

  // --- master data: products, batches, customers (r2-master-data, roadmap M17) ------------------------------------------
  'GET /products': perm('master.view'),
  'GET /products/:id': perm('master.view'),
  'POST /products': perm('master.manage', { body: productCreateSchema }),
  'PUT /products/:id': perm('master.manage', { body: productUpdateSchema }),
  'POST /products/:id/status': perm('master.status', { body: productStatusSchema }),
  'GET /batches': perm('master.view'),
  'GET /batches/:id': perm('master.view'),
  'POST /batches': perm('master.manage', { body: batchCreateSchema }),
  'PUT /batches/:id': perm('master.manage', { body: batchUpdateSchema }),
  'POST /batches/:id/status': perm('master.status', { body: batchStatusSchema }),
  // A registration: the same permission as POST /samples (Analyst, Admin).
  'POST /batches/:id/samples': perm('sample.register', { body: batchSampleSchema }),
  'GET /customers': perm('master.view'),
  'POST /customers': perm('master.manage', { body: customerCreateSchema }),
  'PUT /customers/:id': perm('master.manage', { body: customerUpdateSchema }),
  'POST /customers/:id/status': perm('master.manage', { body: customerStatusSchema }),

  // --- quality management: deviations, CAPA, change control, audit findings (r2-qms, roadmap M27) -----------------------
  // Raising and working a record is open to every role; triage, signed approval, closure, rejection, effectiveness and the
  // change-control setting are the quality unit's (qms.approve, qms.settings). The engine checks the per-step rules.
  'GET /qms/records': perm('qms.view'),
  'GET /qms/records/:id': perm('qms.view'),
  'POST /qms/records': perm('qms.create', { body: qmsCreateSchema }),
  'PUT /qms/records/:id': perm('qms.edit', { body: qmsUpdateSchema }),
  'POST /qms/records/:id/transition': perm('qms.edit', { body: qmsTransitionSchema }),
  'POST /qms/records/:id/sign': perm('qms.approve', { body: qmsSignSchema }),
  'POST /qms/records/:id/effectiveness': perm('qms.approve', { body: qmsEffectivenessSchema }),
  'POST /qms/records/:id/links': perm('qms.edit', { body: qmsLinkSchema }),
  'POST /qms/records/:id/comments': perm('qms.edit', { body: qmsCommentSchema }),
  'POST /qms/records/:id/actions': perm('qms.edit', { body: qmsActionCreateSchema }),
  'GET /qms/actions': perm('qms.view'),
  'PUT /qms/actions/:id': perm('qms.edit', { body: qmsActionUpdateSchema }),
  // Completion is signed by the action's owner (any role); the engine refuses anyone else but the quality unit.
  'POST /qms/actions/:id/complete': perm('qms.edit', { body: qmsActionCompleteSchema }),
  'POST /qms/actions/:id/cancel': perm('qms.approve', { body: qmsActionCancelSchema }),
  'GET /qms/settings': perm('qms.view'),
  'PUT /qms/settings': perm('qms.settings', { body: qmsSettingsSchema }),
  'GET /signatures/verify/:id': perm('record.verify'),
  'GET /signatures/meanings': perm('record.verify'), // r1-esign: the catalog the signature dialog offers
  'GET /signatures/entity/:type/:id': perm('record.verify'), // r1-esign: the signatures of one record

  // --- laboratory notebook ----------------------------------------------------------------------------------------------
  'GET /eln': perm('eln.view'),
  'POST /eln': perm('eln.create', { body: elnCreateSchema }),
  'GET /eln/:id': perm('eln.view'),
  'PUT /eln/:id': perm('eln.edit', {
    body: elnUpdateSchema,
    state: { entity: 'eln', param: 'id', require: 'editable' },
  }),
  'POST /eln/:id/sign': perm('eln.sign', { body: elnSignSchema, state: { entity: 'eln', param: 'id', require: 'transition', to: 'Signed' } }),
  'GET /eln/:id/verify': perm('record.verify'),
  'GET /notebook-templates': perm('eln.view'),
  'POST /notebook-templates': perm('eln.create', { body: notebookTemplateSchema }),

  // --- methods, calculation formulas, test plans, calculated results, system suitability (r2-methods-calc, roadmap M18) -------
  'GET /methods': perm('method.view'),
  'POST /methods': perm('method.manage', { body: methodCreateSchema }),
  'PUT /methods/:id': perm('method.manage', { body: methodUpdateSchema }),
  'POST /methods/:id/revise': perm('method.manage', { body: reviseSchema }),
  'POST /methods/:id/approve': perm('method.approve', { body: configApproveSchema }),
  'GET /calc/formulas': perm('method.view'),
  'POST /calc/formulas': perm('method.manage', { body: formulaCreateSchema }),
  'PUT /calc/formulas/:id': perm('method.manage', { body: formulaUpdateSchema }),
  'POST /calc/formulas/:id/revise': perm('method.manage', { body: reviseSchema }),
  'POST /calc/formulas/:id/approve': perm('method.approve', { body: configApproveSchema }),
  'POST /calc/evaluate': perm('method.view', { body: calcEvaluateSchema }),
  'GET /test-plans': perm('method.view'),
  'POST /test-plans': perm('method.manage', { body: testPlanCreateSchema }),
  'PUT /test-plans/:id': perm('method.manage', { body: testPlanUpdateSchema }),
  'POST /test-plans/:id/revise': perm('method.manage', { body: reviseSchema }),
  'POST /test-plans/:id/approve': perm('method.approve', { body: configApproveSchema }),
  // A calculated result and an SST run are result entry: the handlers also refuse anyone but an Analyst or Admin (like PUT results).
  'GET /calc/samples/:id': perm('sample.view'),
  'POST /calc/samples/:id/results/:resultId': perm('result.enter', { body: calcEntrySchema }),
  'POST /calc/samples/:id/sst': perm('result.enter', { body: sstRunSchema }),

  // --- equipment, reagents, monitoring, stability -----------------------------------------------------------------------
  'GET /instruments': perm('instrument.view'),
  'POST /instruments': perm('instrument.register', { body: instrumentSchema }),
  'POST /instruments/:id/calibrate': perm('instrument.calibrate', { body: calibrateSchema, state: { entity: 'instrument', param: 'id', require: 'editable' } }),
  // r2-instrument-integration (roadmap M21): capture profiles (the mapping is approved with an e-signature, never by its author), the
  // files the folder agent or an upload registers, and the staged values an analyst accepts (saveResult) or rejects. The file is the
  // body of POST /instrument-files (application/octet-stream).
  'GET /instrument-parsers': perm('instrument.view'),
  'GET /instrument-profiles': perm('instrument.view'),
  'POST /instrument-profiles': perm('instrument.profile.manage', { body: instrumentProfileCreateSchema }),
  'POST /instrument-profiles/dry-run': perm('instrument.profile.manage', { body: instrumentProfileDryRunSchema }),
  'PUT /instrument-profiles/:id': perm('instrument.profile.manage', { body: instrumentProfileUpdateSchema }),
  'POST /instrument-profiles/:id/approve': perm('instrument.profile.approve', { body: instrumentProfileApproveSchema }),
  'POST /instrument-profiles/:id/retire': perm('instrument.profile.manage', { body: instrumentProfileRetireSchema }),
  'POST /instrument-files': perm('result.enter', { body: NO_BODY }),
  'GET /instrument-files': perm('instrument.view'),
  'GET /instrument-files/:id': perm('instrument.view'),
  'GET /instrument-files/:id/content': perm('instrument.view'),
  'GET /instrument-imports': perm('instrument.view'),
  'POST /instrument-imports/:id/accept': perm('result.enter', { body: importAcceptSchema }),
  'POST /instrument-imports/:id/reject': perm('result.enter', { body: importRejectSchema }),
  'GET /instruments/:id/usage-log': perm('instrument.view'),
  'GET /samples/:id/result-sources': perm('sample.view'),
  'GET /reagents': perm('reagent.view'),
  'POST /reagents': perm('reagent.receive', { body: reagentSchema }),
  // r2-reagents (roadmap M30): item master, lots (receipt, release, rejection and retest are e-signed; release and rejection never by
  // the receiver), prepared solutions, the consumption ledger and the usage-to-result link. The link routes are result entry: the
  // handlers also keep the entry roles and the Testing state, like PUT results.
  'GET /reagent-items': perm('reagent.view'),
  'POST /reagent-items': perm('reagent.manage', { body: reagentItemCreateSchema }),
  'PUT /reagent-items/:id': perm('reagent.manage', { body: reagentItemUpdateSchema }),
  'GET /reagent-lots': perm('reagent.view'),
  'POST /reagent-lots': perm('reagent.receive', { body: reagentLotReceiptSchema }),
  'GET /reagent-lots/:id': perm('reagent.view'),
  'POST /reagent-lots/:id/release': perm('reagent.approve', { body: reagentLotSignSchema }),
  'POST /reagent-lots/:id/reject': perm('reagent.approve', { body: reagentLotRejectSchema }),
  'POST /reagent-lots/:id/retest': perm('reagent.approve', { body: reagentLotRetestSchema }),
  'POST /reagent-lots/:id/open': perm('reagent.use', { body: reagentLotOpenSchema }),
  'POST /reagent-lots/:id/consume': perm('reagent.use', { body: reagentConsumeSchema }),
  'POST /reagent-lots/:id/dispose': perm('reagent.use', { body: reagentCloseSchema }),
  'GET /reagent-lots/:id/traceback': perm('reagent.view'),
  'GET /prepared-solutions': perm('reagent.view'),
  'POST /prepared-solutions': perm('reagent.use', { body: preparedSolutionSchema }),
  'GET /prepared-solutions/:id': perm('reagent.view'),
  'POST /prepared-solutions/:id/consume': perm('reagent.use', { body: reagentConsumeSchema }),
  'POST /prepared-solutions/:id/discard': perm('reagent.use', { body: reagentCloseSchema }),
  'GET /prepared-solutions/:id/traceback': perm('reagent.view'),
  'GET /reagent-materials': perm('reagent.view'),
  'GET /samples/:id/materials': perm('sample.view'),
  'POST /samples/:id/results/:resultId/materials': perm('result.enter', { body: resultMaterialLinkSchema }),
  'POST /result-materials/:id/withdraw': perm('result.enter', { body: resultMaterialWithdrawSchema }),
  'GET /env-records': perm('env.view'),
  'POST /env-records': perm('env.record', { body: envRecordSchema }),
  'PUT /env-records/:id': perm('env.edit', { body: envRecordUpdateSchema }),
  // The environmental monitoring programme (r2-em, roadmap M32, src/server/em/routes.ts). Reading and recording are everyone's; correcting a
  // recorded result (env.correct) and the site map, limit profiles, batch room windows and trend acknowledgement (env.manage) are QA's.
  'GET /em/points': perm('env.view'),
  'POST /em/points': perm('env.manage', { body: pointCreateSchema }),
  'PUT /em/points/:id': perm('env.manage', { body: pointUpdateSchema }),
  'POST /em/points/:id/retire': perm('env.manage', { body: pointRetireSchema }),
  'GET /em/limit-profiles': perm('env.view'),
  'POST /em/limit-profiles': perm('env.manage', { body: profileCreateSchema }),
  'PUT /em/limit-profiles/:id': perm('env.manage', { body: profileUpdateSchema }),
  // Signed EM_LIMIT_APPROVAL (QA, Admin); the approver did not write or edit the profile (403 SOD_VIOLATION, checked by the handler).
  'POST /em/limit-profiles/:id/approve': perm('env.manage', { body: profileApproveSchema }),
  'GET /em/results': perm('env.view'),
  'POST /em/results': perm('env.record', { body: resultCreateSchema }),
  'PUT /em/results/:id': perm('env.correct', { body: resultCorrectionSchema }),
  'POST /em/results/:id/identification': perm('env.record', { body: identificationSchema }),
  'GET /em/excursions': perm('env.view'),
  'GET /em/batch-impact/:batch': perm('env.view'),
  'GET /em/batch-rooms': perm('env.view'),
  'POST /em/batch-rooms': perm('env.manage', { body: batchRoomCreateSchema }),
  'PUT /em/batch-rooms/:id': perm('env.manage', { body: batchRoomUpdateSchema }),
  'GET /em/trends': perm('env.view'),
  'POST /em/trends/evaluate': perm('env.manage', { body: emEmptyBody }),
  'POST /em/trends/:id/acknowledge': perm('env.manage', { body: trendAcknowledgeSchema }),
  'GET /em/heatmap': perm('env.view'),
  'GET /stability': perm('stability.view'),
  'POST /stability': perm('stability.create', { body: studyCreateSchema }),
  'PUT /stability/:id': perm('stability.edit', { body: studyCloseSchema }),
  // r2-stability (M31): the programme (src/server/stability/routes.ts). The pull registers a sample: the registration permission.
  'GET /stability/studies/:id': perm('stability.view'),
  'GET /stability/timepoints': perm('stability.view'),
  'POST /stability/timepoints/:id/pull': perm('sample.register', { body: pullSchema }),
  'GET /stability/protocols': perm('stability.view'),
  'POST /stability/protocols': perm('stability.manage', { body: protocolCreateSchema }),
  'PUT /stability/protocols/:id': perm('stability.manage', { body: protocolUpdateSchema }),
  'POST /stability/protocols/:id/revise': perm('stability.manage', { body: protocolReviseSchema }),
  'POST /stability/protocols/:id/approve': perm('stability.approve', { body: protocolApproveSchema }),
  'GET /stability/conditions': perm('stability.view'),
  'POST /stability/conditions': perm('stability.manage', { body: conditionCreateSchema }),
  'PUT /stability/conditions/:id': perm('stability.manage', { body: conditionUpdateSchema }),
  'GET /stability/chambers': perm('stability.view'),
  'POST /stability/chambers': perm('stability.manage', { body: chamberCreateSchema }),
  'PUT /stability/chambers/:id': perm('stability.manage', { body: chamberUpdateSchema }),

  // --- dashboard, reports -----------------------------------------------------------------------------------------------
  'GET /dashboard': perm('report.view'),
  // r2-tat-kpi (M34): turnaround statistics and the role-based key figures read like any report; the business calendar, holidays and SLA
  // rules are master data (master.manage, QA and Admin); the priority of a sample is set by whoever may move it through its states.
  'GET /metrics/tat': perm('report.view'),
  'GET /metrics/kpi': perm('report.view'),
  'GET /metrics/kpi/:key': perm('report.view'),
  'GET /tat/settings': perm('report.view'),
  'PUT /tat/calendar': perm('master.manage', { body: calendarSchema }),
  'POST /tat/holidays': perm('master.manage', { body: holidayCreateSchema }),
  'POST /tat/holidays/:id/remove': perm('master.manage', { body: holidayRemoveSchema }),
  'PUT /tat/sla/:priority': perm('master.manage', { body: slaSchema }),
  'GET /tat/samples/:id': perm('sample.view'),
  'PUT /tat/samples/:id': perm('sample.transition', { body: sampleTatSchema }),
  'GET /reports/batch/:batch': perm('report.view'),
  'GET /reports/filters': perm('report.view'),
  'GET /reports/metrics': perm('report.view'),
  'GET /reports/trends': perm('report.view'),
  'POST /reports/generate': perm('report.generate', { body: ['sampleId'] }),
  'GET /reports/status/:jobId': perm('report.generate'),
  'GET /reports/artifact/:jobId': perm('report.generate'),
  // --- the controlled Certificate of Analysis and the register of generated documents (r2-coa-reports, roadmap M25) -----------
  // Issuing, re-issuing and voiding are the quality unit's (coa.issue), signed; anyone who reads reports reads the register and asks for
  // a controlled copy of their own; verification is record.verify, like signatures.
  'GET /coa/documents': perm('report.view'),
  'GET /coa/documents/:id': perm('report.view'),
  'POST /coa/documents/:id/reissue': perm('coa.issue', { body: coaReissueSchema }),
  'POST /coa/documents/:id/void': perm('coa.issue', { body: coaVoidSchema }),
  'POST /coa/documents/:id/copies': perm('report.generate', { body: coaCopySchema }),
  'GET /coa/:sampleId': perm('report.view'),
  'POST /coa/:sampleId': perm('coa.issue', { body: coaIssueSchema }),
  'GET /reports/runs/:id': perm('report.view'),
  'GET /reports/runs/:id/pdf': perm('report.generate'),
  'GET /reports/runs/:id/verify': perm('record.verify'),

  // --- training, AI -----------------------------------------------------------------------------------------------------
  'GET /training': perm('training.view'),
  'POST /training/:userId/certify': perm('training.certify', { body: certifySchema }),
  // Curricula, assignments and qualification (r2-docs-training, roadmap M28). Who signs what is checked again by the handler.
  'GET /training/curricula': perm('training.view'),
  'POST /training/curricula': perm('training.manage', { body: curriculumCreateSchema }),
  'PUT /training/curricula/:id': perm('training.manage', { body: curriculumUpdateSchema }),
  'GET /training/assignments': perm('training.view'),
  'POST /training/assignments': perm('training.manage', { body: assignmentCreateSchema }),
  'POST /training/assignments/:id/acknowledge': perm('training.acknowledge', { body: assignmentSignSchema }),
  'POST /training/assignments/:id/certify': perm('training.certify', { body: assignmentSignSchema }),
  'GET /training/qualifications': perm('training.view'),
  'POST /training/qualifications/override': perm('training.override', { body: overrideSchema }),
  'POST /training/qualifications/:id/revoke': perm('training.override', { body: overrideRevokeSchema }),

  // --- controlled documents (r2-docs-training, roadmap M28). Independence and the signers' roles are checked by the handler ------
  'GET /documents': perm('doc.view'),
  'POST /documents': perm('doc.author', { body: documentCreateSchema }),
  'GET /documents/:id': perm('doc.view'),
  'POST /documents/:id/revise': perm('doc.author', { body: documentReviseSchema }),
  'PUT /document-versions/:id': perm('doc.author', { body: versionUpdateSchema }),
  'PUT /document-versions/:id/file': perm('doc.author', { body: NO_BODY }),
  'POST /document-versions/:id/submit': perm('doc.author', { body: versionSignSchema }),
  'POST /document-versions/:id/review': perm('doc.review', { body: versionSignSchema }),
  'POST /document-versions/:id/return': perm('doc.review', { body: versionReturnSchema }),
  'POST /document-versions/:id/approve': perm('doc.approve', { body: versionSignSchema }),
  'POST /document-versions/:id/effective': perm('doc.approve', { body: versionSignSchema }),
  'POST /document-versions/:id/obsolete': perm('doc.approve', { body: versionObsoleteSchema }),
  'GET /document-versions/:id/content': perm('doc.view'),
  'POST /document-versions/:id/print': perm('doc.print', { body: versionPrintSchema }),
  'GET /document-versions/:id/prints': perm('doc.view'),
  'POST /transcribe': perm('ai.use', { body: transcribeSchema }),
  'POST /ai/capa-analysis': perm('ai.use', { body: capaAnalysisSchema }),
  'POST /ai/eln-protocol': perm('ai.use', { body: elnProtocolSchema }),

  // --- audit and security events ----------------------------------------------------------------------------------------
  'GET /audit': perm('audit.view'),
  'GET /audit/head': perm('audit.view'),
  'GET /audit/history': perm('audit.history.view'),
  'POST /audit/verify': perm('audit.verify', { body: emptyBody }),
  'POST /audit/export': perm('audit.export', { body: auditExportBody }),
  'GET /security-events': perm('security.view'),
  'GET /security-events/types': perm('security.view'),
  'POST /security-events/verify': perm('security.verify', { body: emptyBody }),
  // audit-trail review and tamper evidence (r2-audit-tamper, roadmap M35)
  'GET /audit/exceptions': perm('audit.view'),
  'GET /audit/reviews': perm('audit.view'),
  'POST /audit/reviews': perm('audit.review', { body: AUDIT_REVIEW_KEYS }),
  'GET /audit/review-settings': perm('audit.view'),
  'PUT /audit/review-settings': perm('audit.review.settings', { body: auditReviewSettingsBody }),
  'GET /audit/anchors': perm('audit.view'),
  'POST /audit/anchors': perm('audit.verify', { body: emptyBody }),
  'POST /audit/anchors/verify': perm('audit.verify', { body: emptyBody }),
  'GET /audit/clock': perm('audit.view'),
  'POST /audit/clock-anomalies/:id/acknowledge': perm('clock.acknowledge', { body: clockAcknowledgeBody }),

  // --- administration ---------------------------------------------------------------------------------------------------
  'GET /admin/activity-heatmap': perm('admin.activity.view'),
  'GET /admin/settings': perm('admin.settings.view'),
  'PUT /admin/settings': perm('admin.settings.manage', { body: settingsUpdateSchema }),
  'GET /admin/users': perm('admin.users.view'),
  // Granting or removing a privileged role (Admin, QA) is the two-person flow of /permissions/role-changes, not these routes.
  'POST /admin/users': perm('admin.users.manage', { body: createUserSchema, guard: forbidUnapprovedPrivilegedRoleChange }),
  'PUT /admin/users/:id': perm('admin.users.manage', { body: updateUserSchema, guard: forbidUnapprovedPrivilegedRoleChange }),
  'POST /admin/users/:id/reset-password': perm('admin.users.manage', { body: userActionSchema }),
  'POST /admin/users/:id/reset-mfa': perm('admin.users.manage', { body: userActionSchema }),
  'POST /admin/users/:id/unlock': perm('admin.users.manage', { body: userActionSchema }),
  'POST /admin/broadcast': perm('admin.broadcast', { body: broadcastSchema }),
  'GET /admin/integrations': perm('admin.integrations.view'),
  'PUT /admin/integrations/ai': perm('admin.integrations.manage', { body: aiIntegrationSchema }),
  // API clients of the machine integration API (r2-api-v1): external integrations, so the integration permissions (Admin only).
  'GET /api-clients': perm('admin.integrations.view'),
  'POST /api-clients': perm('admin.integrations.manage', { body: apiClientCreateSchema }),
  'POST /api-clients/:id/revoke': perm('admin.integrations.manage', { body: apiClientRevokeSchema }),
  // Outbound event subscriptions (r2-events, roadmap M23): external integrations, so the integration permissions (Admin only).
  'GET /event-subscriptions': perm('admin.integrations.view'),
  'POST /event-subscriptions': perm('admin.integrations.manage', { body: subscriptionCreateSchema }),
  'POST /event-subscriptions/:id/status': perm('admin.integrations.manage', { body: subscriptionStatusSchema }),
  'GET /event-subscriptions/:id/deliveries': perm('admin.integrations.view'),
  'POST /event-deliveries/:id/retry': perm('admin.integrations.manage', { body: deliveryRetrySchema }),
  'POST /admin/backup': perm('admin.backup.run', { body: ['password', 'passphrase'] }),
  'POST /admin/backup/verify': perm('admin.backup.run', { body: ['password', 'passphrase', 'file'] }),
  'POST /admin/backup/drill': perm('admin.backup.run', { body: ['password'] }),
  'GET /admin/backup/status': perm('admin.backup.view'),
  'GET /admin/jobs': perm('admin.jobs.view'),
  'GET /system/info': perm('system.info.view'),

  // --- the screens' lookups, lists and inbox (r2-ui-foundation, roadmap M24) --------------------------------------------
  // A picker or a list shows what the role may already read; the export is the list as a file, audited (user, filter, rows, sha256).
  // Users: the name and role of active accounts only, which the training matrix already shows to every holder of training.view.
  'GET /inbox': SELF(),
  // The user's own notifications (r2-events): the handler reads and changes only rows of req.user.
  'GET /notifications': SELF(),
  'POST /notifications/read-all': SELF(NO_BODY),
  'POST /notifications/:id/read': SELF(NO_BODY),
  // Global search (r3-search-perf, roadmap M43): the permission is per entity, checked inside the handler; a role without any sees no group.
  'GET /search': SELF(),
  'GET /lookup/samples': perm('sample.view'),
  'GET /lookup/results': perm('sample.view'),
  'GET /lookup/users': perm('training.view'),
  'GET /lookup/specifications': perm('spec.view'),
  'GET /lookup/instruments': perm('instrument.view'),
  'GET /lists/samples': perm('sample.view'),
  'POST /lists/samples/export': perm('sample.view', { body: sampleExportSchema }),

  // r2-custody-labels (roadmap M29, src/server/routes/custody.ts and resolve.ts): receipt, containers, ledger, retains, labels, scan lookup.
  'GET /custody/samples/:id': perm('custody.view'),
  'POST /custody/samples/:id/receipt': perm('custody.handle', { body: receiptSchema }),
  'POST /custody/samples/:id/receipt/acknowledge': perm('custody.approve', { body: receiptAckSchema }),
  'POST /custody/containers/:id/aliquots': perm('custody.handle', { body: aliquotSchema }),
  'POST /custody/containers/:id/consume': perm('custody.handle', { body: consumeSchema }),
  'POST /custody/containers/:id/transfer': perm('custody.handle', { body: transferSchema }),
  'POST /custody/containers/:id/retain': perm('custody.handle', { body: retainSchema }),
  'GET /custody/retains': perm('custody.view'),
  'POST /custody/retains/:id/dispose': perm('custody.approve', { body: disposeSchema }),
  'GET /custody/locations': perm('custody.view'),
  'POST /custody/locations': perm('custody.locations', { body: locationCreateSchema }),
  'PUT /custody/locations/:id': perm('custody.locations', { body: locationUpdateSchema }),
  'POST /custody/labels': perm('label.print', { body: labelPrintSchema }),
  'GET /custody/labels': perm('custody.view'),
  'GET /custody/verify': perm('record.verify'),

  // r2-validation (roadmap M37, src/server/qualified.ts): the validated-scope register; declaring a status is QA-signed (MODULE_QUALIFICATION).
  'GET /validation/modules': perm('validation.view'),
  'POST /validation/modules/:module/status': perm('validation.scope', { body: qualifiedStatusSchema }),
  // r3-directory (roadmap M41, src/server/routes/directory.ts, src/server/auth/ldap.ts): directory sign-on administration; mapping decisions are QA-signed (DIRECTORY_MAPPING).
  'GET /directory/settings': perm('directory.view'),
  'PUT /directory/settings': perm('directory.manage', { body: directorySettingsSchema }),
  'POST /directory/test': perm('directory.manage', { body: directoryTestSchema }),
  'GET /directory/mappings': perm('directory.view'),
  'POST /directory/mappings': perm('directory.manage', { body: mappingCreateSchema }),
  'POST /directory/mappings/:id/approve': perm('directory.approve', { body: mappingDecisionSchema }),
  'POST /directory/mappings/:id/retire': perm('directory.approve', { body: mappingDecisionSchema }),
  'GET /directory/accounts': perm('directory.view'),
  'POST /directory/accounts/:userId/break-glass': perm('directory.manage', { body: breakGlassSchema }),
  // r3-spc (roadmap M39, src/server/routes/trending.ts and stability-trend.ts): advisory trending; a baseline is computed by the server and e-signed.
  'GET /trending/parameters': perm('spc.view'),
  'GET /trending/series': perm('spc.view'),
  'GET /trending/baselines': perm('spc.view'),
  'POST /trending/baselines': perm('spc.manage', { body: baselineCreateSchema }),
  'GET /trending/alerts': perm('spc.view'),
  'POST /trending/alerts/evaluate': perm('spc.manage', { body: spcEmptyBody }),
  'POST /trending/alerts/:id/acknowledge': perm('spc.manage', { body: alertAcknowledgeSchema }),
  'GET /stability-trend': perm('spc.view'),
  // r3-periodic-archive (roadmap M42): periodic review, retention and legal hold, batch archive. Signatures: PERIODIC_REVIEW, ARCHIVE_DECISION, RETENTION_POLICY, LEGAL_HOLD (QA).
  'GET /periodic-reviews/plans': perm('periodic.view'),
  'POST /periodic-reviews/plans': perm('periodic.manage', { body: planCreateSchema }),
  'PUT /periodic-reviews/plans/:id': perm('periodic.manage', { body: planUpdateSchema }),
  'POST /periodic-reviews/plans/:id/open': perm('periodic.manage', { body: NO_BODY }),
  'GET /periodic-reviews/due': perm('periodic.view'),
  'GET /periodic-reviews': perm('periodic.view'),
  'GET /periodic-reviews/:id': perm('periodic.view'),
  'PUT /periodic-reviews/:id': perm('periodic.manage', { body: reviewDraftSchema }),
  'POST /periodic-reviews/:id/complete': perm('periodic.sign', { body: reviewCompleteSchema }),
  'POST /periodic-reviews/:id/cancel': perm('periodic.manage', { body: reviewCancelSchema }),
  'GET /retention/policies': perm('archive.view'),
  'PUT /retention/policies/:recordClass': perm('retention.manage', { body: policySchema }),
  'GET /retention/holds': perm('archive.view'),
  'POST /retention/holds': perm('retention.manage', { body: holdPlaceSchema }),
  'POST /retention/holds/:id/release': perm('retention.manage', { body: holdReleaseSchema }),
  'GET /retention/candidates': perm('archive.view'),
  'GET /retention/flags': perm('archive.view'),
  'POST /retention/flags': perm('retention.manage', { body: flagSchema }),
  'POST /retention/flags/:id/withdraw': perm('retention.manage', { body: flagWithdrawSchema }),
  'GET /archive/bundles': perm('archive.view'),
  'GET /archive/bundles/:id': perm('archive.view'),
  'POST /archive/bundles': perm('archive.manage', { body: buildSchema }),
  'POST /archive/bundles/:id/verify': perm('archive.manage', { body: NO_BODY }),
  'POST /archive/bundles/:id/restore-check': perm('archive.manage', { body: NO_BODY }),
  'POST /archive/bundles/:id/decision': perm('archive.manage', { body: decideSchema }),
  'GET /archive/records/:entityType/:entityId': perm('archive.view'),
  // r2-worklists (roadmap M33, src/server/routes/worklists.ts): worklists by method and instrument, assignment, run sequence, workload.
  'GET /worklists': perm('worklist.view'),
  'GET /worklists/workload': perm('worklist.view'),
  'GET /worklists/candidates': perm('worklist.view'),
  'GET /worklists/bench-sheets/:jobId': perm('worklist.view'),
  'GET /worklists/:id': perm('worklist.view'),
  'GET /worklists/:id/run-sequence.csv': perm('worklist.view'),
  'POST /worklists': perm('worklist.manage', { body: worklistCreateSchema }),
  'PUT /worklists/:id': perm('worklist.manage', { body: worklistUpdateSchema }),
  'POST /worklists/:id/items': perm('worklist.manage', { body: itemAddSchema }),
  'PUT /worklists/:id/items/:itemId': perm('worklist.manage', { body: itemUpdateSchema }),
  'POST /worklists/:id/items/:itemId/remove': perm('worklist.manage', { body: itemRemoveSchema }),
  'POST /worklists/:id/reorder': perm('worklist.manage', { body: reorderSchema }),
  'POST /worklists/:id/release': perm('worklist.manage', { body: worklistReleaseSchema }),
  'POST /worklists/:id/complete': perm('worklist.manage', { body: worklistCompleteSchema }),
  'POST /worklists/:id/cancel': perm('worklist.manage', { body: worklistCancelSchema }),
  'POST /worklists/:id/bench-sheet': perm('worklist.manage', { body: NO_BODY }),
  // Cell by cell through saveResult, which keeps every result rule (role, state, version, guards incl. the assignee).
  'PUT /worklists/:id/grid': perm('result.enter', { body: gridSaveSchema }),
  'GET /resolve': perm('sample.view'),

  // --- authorisation (this track) ---------------------------------------------------------------------------------------
  'GET /permissions/me': SELF(),
  'GET /permissions/matrix': perm('authz.view'),
  'GET /permissions/role-changes': perm('authz.view'),
  'POST /permissions/role-changes': perm('authz.role.request', { body: requestRoleChangeSchema }),
  'POST /permissions/role-changes/:id/approve': perm('authz.role.approve', { body: decideRoleChangeSchema, sod: { rule: 'role.grant', param: 'id' } }),
  'POST /permissions/role-changes/:id/reject': perm('authz.role.approve', { body: decideRoleChangeSchema }),
  'POST /permissions/role-changes/:id/cancel': perm('authz.role.request', { body: withdrawRoleChangeSchema }),
};
