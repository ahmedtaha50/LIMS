import { createRouter } from '../core/router';
import type { RouteContext } from '../core/context';
import { adminRoutes } from './admin';
import { aiRoutes } from './ai';
import { apiClientsRoutes } from './api-clients';
import { attachmentsRoutes } from './attachments';
import { auditRoutes } from './audit';
import { auditReviewRoutes } from './audit-review';
import { authRoutes } from './auth';
import { backupRoutes } from './backup';
import { batchesRoutes } from './batches';
import { calcRoutes } from './calc';
import { coaRoutes } from './coa';
import { custodyRoutes } from './custody';
import { customersRoutes } from './customers';
import { dashboardRoutes } from './dashboard';
import { directoryRoutes } from './directory';
import { documentsRoutes } from './documents';
import { elnRoutes } from './eln';
import { envRoutes } from './env';
import { i18nRoutes } from '../../i18n/server/routes';
import { inboxRoutes } from './inbox';
import { instrumentFilesRoutes } from './instrument-files';
import { instrumentProfilesRoutes } from './instrument-profiles';
import { instrumentsRoutes } from './instruments';
import { lookupRoutes } from './lookup';
import { methodsRoutes } from './methods';
import { notificationsRoutes } from './notifications';
import { notebookTemplatesRoutes } from './notebook-templates';
import { oosRoutes } from './oos';
import { oosWorkflowRoutes } from '../oos/routes';
import { periodicRoutes } from './periodic-reviews';
import { productsRoutes } from './products';
import { qualifiedRoutes } from '../qualified';
import { qmsRoutes } from './qms';
import { reagentInventoryRoutes, reagentsRoutes } from './reagents';
import { releaseRoutes } from './release';
import { reportsRoutes } from './reports';
import { resolveRoutes } from './resolve';
import { resultsRoutes } from './results';
import { resultsBatchRoutes } from './results-batch';
import { reviewRoutes } from './review';
import { samplesRoutes } from './samples';
import { searchRoutes } from './search';
import { signaturesRoutes } from './signatures';
import { specificationsRoutes } from './specifications';
import { stabilityRoutes } from './stability';
import { stabilityProgrammeRoutes } from '../stability/routes';
import { stabilityTrendRoutes } from './stability-trend';
import { subscriptionsRoutes } from './subscriptions';
import { systemRoutes } from './system';
import { testPlansRoutes } from './test-plans';
import { traceabilityRoutes } from './traceability';
import { trendingRoutes } from './trending';
import { trainingRoutes } from './training';
import { worklistsRoutes } from './worklists';

/**
 * Registry of route modules. A module is a function (ctx) => Router; the domain's owning track edits its own file,
 * and a new domain adds one import and one entry below. tests/route-table.json must change in the same commit.
 */
const modules = [
  adminRoutes,
  aiRoutes,
  apiClientsRoutes,
  attachmentsRoutes,
  auditRoutes,
  auditReviewRoutes,
  authRoutes,
  backupRoutes,
  batchesRoutes,
  calcRoutes,
  coaRoutes,
  custodyRoutes,
  customersRoutes,
  dashboardRoutes,
  directoryRoutes,
  documentsRoutes,
  elnRoutes,
  envRoutes,
  i18nRoutes,
  inboxRoutes,
  instrumentFilesRoutes,
  instrumentProfilesRoutes,
  instrumentsRoutes,
  lookupRoutes,
  methodsRoutes,
  notificationsRoutes,
  notebookTemplatesRoutes,
  oosRoutes,
  oosWorkflowRoutes,
  periodicRoutes,
  productsRoutes,
  qualifiedRoutes,
  qmsRoutes,
  reagentsRoutes,
  reagentInventoryRoutes,
  releaseRoutes,
  reportsRoutes,
  resolveRoutes,
  resultsRoutes,
  resultsBatchRoutes,
  reviewRoutes,
  samplesRoutes,
  searchRoutes,
  signaturesRoutes,
  specificationsRoutes,
  stabilityRoutes,
  stabilityProgrammeRoutes,
  stabilityTrendRoutes,
  subscriptionsRoutes,
  systemRoutes,
  testPlansRoutes,
  traceabilityRoutes,
  trainingRoutes,
  trendingRoutes,
  worklistsRoutes,
];

export function createApiRouter(ctx: RouteContext) {
  const api = createRouter();
  for (const mount of modules) api.use(mount(ctx));
  return api;
}
