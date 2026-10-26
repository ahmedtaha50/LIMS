// /api/v1: what a connected system reads before and after testing (roadmap M22): the specification in force for a material, and the
// disposition of a batch. Both read the same functions the session API uses (resolveActiveSpec, findReleaseBlockers), so a machine and a
// person see the same answer.
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { batchReleases, samples, specifications } from '../../../db/schema';
import { inForce, materialKey, resolveActiveSpec, type ResolvedSpec } from '../../lib/specs';
import { normalizeParameters } from '../../../lib/validations/specifications';
import { findReleaseBlockers } from '../../release-blockers';
import { specificationDto, toSpecification } from '../dto';
import { ProblemError } from '../problem';
import { defineRoute } from '../registry';
import { todayIso } from '../../lib/specs';

const activeQuery = z.object({
  material: z.string().trim().min(1).max(200).optional().meta({ description: 'Material name; case and spacing do not matter. Without it, every material with a specification in force.' }),
}).strict();

defineRoute({
  method: 'GET', path: '/specifications/active', operationId: 'listActiveSpecifications', scope: 'specifications:read',
  summary: 'The specification in force today, for one material or for all',
  query: activeQuery,
  responses: { 200: { description: 'The revisions in force (empty when none is)', schema: z.object({ data: z.array(specificationDto) }).strict() } },
  errors: [400],
  async handler({ db, query }) {
    const { material } = query as z.infer<typeof activeQuery>;
    if (material) {
      const spec = await resolveActiveSpec(db, material);
      return { status: 200, body: { data: spec ? [toSpecification(spec)] : [] } };
    }
    const rows = await db.select().from(specifications).where(eq(specifications.status, 'Active')).orderBy(asc(specifications.material), asc(specifications.id));
    const byMaterial = new Map<string, typeof rows>();
    for (const r of rows) byMaterial.set(materialKey(r.material), [...(byMaterial.get(materialKey(r.material)) ?? []), r]);
    const day = todayIso();
    const data: ResolvedSpec[] = [];
    for (const revisions of byMaterial.values()) {
      const chosen = inForce(revisions, day);
      if (chosen) data.push({ id: chosen.id, material: chosen.material, revision: chosen.revisionLabel, effectiveDate: chosen.effectiveDate, parameters: normalizeParameters(chosen.parameters) });
    }
    return { status: 200, body: { data: data.map(toSpecification) } };
  },
});

const batchParams = z.object({ batch: z.string().min(1).max(100) }).strict();

defineRoute({
  method: 'GET', path: '/batches/{batch}/disposition', operationId: 'getBatchDisposition', scope: 'batches:read',
  summary: 'The disposition of a batch: released, rejected or on hold, and what blocks its release',
  description: '`releasable` is true when the batch is on hold and nothing blocks its release. The release itself is an e-signature by a person.',
  params: batchParams,
  responses: {
    200: {
      description: 'The disposition',
      schema: z.object({
        batch: z.string(),
        status: z.string().meta({ description: 'Quarantine Hold (no release record yet), Released or Rejected' }),
        decidedAt: z.string().meta({ format: 'date-time' }).nullable(),
        releasable: z.boolean(),
        blockers: z.array(z.string()),
        samples: z.array(z.object({ id: z.string(), state: z.string() }).strict()),
      }).strict(),
    },
  },
  errors: [404],
  async handler({ db, params }) {
    const { batch } = params as z.infer<typeof batchParams>;
    const [release] = await db.select().from(batchReleases).where(eq(batchReleases.batch, batch)).limit(1);
    const batchSamples = await db.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.batch, batch)).orderBy(asc(samples.id));
    if (!release && batchSamples.length === 0) throw new ProblemError(404, 'NOT_FOUND', `Batch ${batch} has no samples and no disposition.`);
    const status = release?.status ?? 'Quarantine Hold';
    const blockers = status === 'Quarantine Hold' ? await findReleaseBlockers(db, batch) : [];
    return {
      status: 200,
      body: { batch, status, decidedAt: release?.releasedAt?.toISOString() ?? null, releasable: status === 'Quarantine Hold' && blockers.length === 0, blockers, samples: batchSamples },
    };
  },
});
