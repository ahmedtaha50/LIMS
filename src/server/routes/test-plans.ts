/**
 * Domain: test plans (roadmap M18). Owned by r2-methods-calc.
 *
 *   GET  /test-plans[?material=]        every revision (of one material: matched like specifications, ignoring case and spacing)
 *   POST /test-plans                    revision 1, a Draft: which parameters of the material's specification a kind of sample
 *                                       (purpose: release, stability, ...) is tested for
 *   PUT  /test-plans/:id                a Draft only (423), version predicate (409)
 *   POST /test-plans/:id/revise         the next revision, cloned from the Effective one
 *   POST /test-plans/:id/approve        TEST_PLAN_APPROVAL, never by the author or an editor. Refused (400) when the material has no
 *                                       specification in force or a parameter the plan names is not in it
 */
import { eq, sql } from 'drizzle-orm';
import { testPlans } from '../../db/schema/methods';
import { configApproveSchema, reviseSchema, testPlanCreateSchema, testPlanUpdateSchema } from '../../lib/validations/methods';
import { parameterKey } from '../../lib/validations/specifications';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import type { Executor } from '../core/tx';
import { asSigned, registerSignable } from '../esign';
import { BadRequestError } from '../http/errors';
import { validate } from '../http/validate';
import { materialKey, materialKeySql, resolveActiveSpec } from '../lib/specs';
import { approveConfig, createConfig, listConfig, reviseConfig, updateConfig } from './methods';

type PlanRow = typeof testPlans.$inferSelect;

registerSignable({
  type: 'TestPlan',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(testPlans).where(eq(testPlans.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, code: row.code, name: row.name, material: row.material, purpose: row.purpose, parameters: row.parameters,
      revision: row.revision, status: asSigned(change, ['status'], row.status),
    };
  },
});

/** Every parameter the plan names is a parameter of the specification in force for its material. */
async function assertPlanMatchesSpec(ex: Executor, plan: PlanRow) {
  const spec = await resolveActiveSpec(ex, plan.material);
  if (!spec) throw new BadRequestError(`${plan.material} has no specification in force: a test plan is approved against the specification it selects from.`);
  const known = new Set(spec.parameters.map(p => parameterKey(p.name)));
  const missing = (plan.parameters ?? []).filter(p => !known.has(parameterKey(p)));
  if (missing.length) {
    throw new BadRequestError(`Not a parameter of ${spec.id} (revision ${spec.revision}) for ${plan.material}: ${missing.join(', ')}.`);
  }
}

export const testPlansRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/test-plans', requireAuth, async (req, res) => {
    const material = typeof req.query.material === 'string' && req.query.material.trim() ? req.query.material : null;
    res.json(await listConfig(db, 'TestPlan', material ? sql`${materialKeySql(testPlans.material)} = ${materialKey(material)}` : undefined));
  });

  router.post('/test-plans', requireAuth, validate(testPlanCreateSchema), async (req, res) => {
    const user = (req as any).user;
    res.json(await createConfig<PlanRow>(db, user, 'TestPlan', req.body));
  });

  router.put('/test-plans/:id', requireAuth, validate(testPlanUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const { expectedVersion, ...changes } = req.body as Record<string, unknown> & { expectedVersion: number };
    res.json(await updateConfig<PlanRow>(db, user, 'TestPlan', String(req.params.id), expectedVersion, changes));
  });

  router.post('/test-plans/:id/revise', requireAuth, validate(reviseSchema), async (req, res) => {
    const user = (req as any).user;
    res.json(await reviseConfig<PlanRow>(db, user, 'TestPlan', String(req.params.id), r => ({
      name: r.name, material: r.material, purpose: r.purpose, parameters: r.parameters,
    })));
  });

  router.post('/test-plans/:id/approve', requireAuth, validate(configApproveSchema), async (req, res) => {
    const user = (req as any).user;
    const { password, totpCode, reason, expectedVersion } = req.body as { password: string; totpCode?: string; reason?: string; expectedVersion: number };
    const { result, signature } = await approveConfig<PlanRow>({
      db, req, user, kind: 'TestPlan', id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason,
      precheck: assertPlanMatchesSpec,
    });
    res.json({ plan: result, signature });
  });

  return router;
};
