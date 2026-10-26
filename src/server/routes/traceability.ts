// Domain: traceability. Moved from src/server/api.ts by r1-core; r1-quality-fixes (roadmap M13): material dispensing records only
// what the dispenser states and needs a second person's verification signature. r2-master-data (M17) owns it now: the batch list
// and the dossier show the master batch (product, dates, size, status) and name nothing the records do not hold.
import { randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { batchMaterials, batchReleases, oosInvestigations, results, samples, signatures, users } from '../../db/schema';
import { productBatches, products } from '../../db/schema/master';
import { writeAudit } from '../../db/utils';
import { signatureFields } from '../../lib/validations/signatures';
import { verifyAuditChain } from '../audit/chain';
import { findBatchDeviations } from '../release-blockers/qms';
import { findBatchEmResults } from '../em';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { registerSignable, signRecord } from '../esign';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';

/** CoA status vocabulary (batch_materials.coa_status). */
export const COA_STATUSES = ['Verified Pass', 'Quarantined', 'Rejected'] as const;

const stated = (label: string, max = 200) => z.string({ error: `${label} must be text.` }).trim().min(1, `${label} is required.`).max(max);
/** A percentage as the CoA states it ("99.8 %"), or "N/A" typed explicitly where the test does not apply. */
const percentOrNa = (label: string) => stated(label, 30).regex(/^(N\/A|\d{1,3}(\.\d{1,4})?\s?%)$/i, `${label} must be a percentage such as "99.8 %", or "N/A" where it does not apply.`);

/** POST /traceability/batch/:batch/material. Nothing is defaulted: a missing value is a 400. dispensedBy/verifiedBy are the server's. */
export const batchMaterialSchema = z.object({
  materialName: stated('Material name'),
  materialType: stated('Material type', 100),
  lotNumber: stated('Lot number'),
  manufacturer: stated('Manufacturer'),
  coaNumber: stated('CoA number'),
  coaStatus: z.enum(COA_STATUSES, { error: `CoA status must be one of ${COA_STATUSES.join(', ')}.` }),
  quantityDispensed: stated('Quantity dispensed', 100),
  potencyAssay: percentOrNa('Potency (assay)'),
  lossOnDrying: percentOrNa('Loss on drying'),
  verifier: z.object({
    email: z.string({ error: 'The verifier is identified by e-mail.' }).trim().min(3).max(320),
    password: signatureFields.password,
    totpCode: signatureFields.totpCode,
  }, { error: 'A verifier (a second person: e-mail and password) is required.' }).strict(),
}).strict();

// A dispensing is created once and never edited: the verification signature covers the whole record.
registerSignable({
  type: 'BatchMaterial',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(batchMaterials).where(eq(batchMaterials.id, id)).limit(1);
    if (!row) return null;
    const { version: _v, dispensedAt, ...rest } = row;
    return { ...rest, dispensedAt: dispensedAt.toISOString() };
  },
});

export const traceabilityRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/traceability/batches', requireAuth, async (req, res) => {
    try {
      const allSamples = await db.query.samples.findMany();
      const allBM = await db.query.batchMaterials.findMany();
      const allReleases = await db.query.batchReleases.findMany();
      const allOos = await db.query.oosInvestigations.findMany();
      // r2-master-data: the master batches (a batch number may belong to more than one product).
      const allMaster = await db.select({ batchNo: productBatches.batchNo, status: productBatches.status, productName: products.name })
        .from(productBatches).innerJoin(products, eq(products.id, productBatches.productId)).orderBy(products.name);

      // Unique batch names across samples, batch_materials, releases and the master data
      const batchNames = [...new Set([
        ...allSamples.map(s => s.batch),
        ...allBM.map(bm => bm.batch),
        ...allReleases.map(r => r.batch),
        ...allMaster.map(m => m.batchNo),
      ])].filter(Boolean);

      const batchesSummary = batchNames.map(b => {
        const bSamples = allSamples.filter(s => s.batch === b);
        const bMaterials = allBM.filter(bm => bm.batch === b);
        const bRelease = allReleases.find(r => r.batch === b);
        const bMaster = allMaster.filter(m => m.batchNo === b);
        const masterStatuses = [...new Set(bMaster.map(m => m.status))];
        const sampleIds = new Set(bSamples.map(s => s.id));
        const bOos = allOos.filter(o => sampleIds.has(o.sampleId));

        const hasOosOpen = bOos.some(o => o.status === 'Open');
        const allSamplesApproved = bSamples.length > 0 && bSamples.every(s => s.state === 'Approved');

        let status = 'In Progress';
        if (bRelease && bRelease.status === 'Released') status = 'Released';
        else if (hasOosOpen) status = 'Hold (OOS)';
        else if (allSamplesApproved && bMaterials.length > 0) status = 'Ready for Release';

        return {
          batch: b,
          // What the records say, or nothing: no invented product name.
          material: bSamples[0]?.material || bMaster[0]?.productName || null,
          products: bMaster.map(m => m.productName),
          masterStatus: masterStatuses.length === 1 ? masterStatuses[0] : null,
          status,
          samplesCount: bSamples.length,
          materialsCount: bMaterials.length,
          oosCount: bOos.length,
          releasedAt: bRelease?.releasedAt || null,
          releasedBy: bRelease?.releasedBy || null
        };
      });

      res.json(batchesSummary);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/traceability/batch/:batch', requireAuth, async (req, res) => {
    try {
      const batch = String(req.params.batch);

      // Stage 1: Raw Materials Dispensing & CoA Verification
      const materials = await db.query.batchMaterials.findMany({
        where: eq(batchMaterials.batch, batch),
        orderBy: (bm, { asc }) => [asc(bm.dispensedAt)]
      });

      // Stage 2: environmental monitoring (r2-em, roadmap M32): only the results of sampling points in the batch's rooms, sampled
      // inside the windows the batch was there (em_batch_rooms). A batch with no window recorded has none.
      const em = await findBatchEmResults(db, batch);

      // Stage 3: Analytical QC Testing
      const batchSamples = await db.query.samples.findMany({ where: eq(samples.batch, batch) });
      const sampleIds = batchSamples.map(s => s.id);

      const batchResults = [];
      for (const sid of sampleIds) {
        const sr = await db.query.results.findMany({ where: eq(results.sampleId, sid) });
        batchResults.push(...sr);
      }

      // Stage 4: Deviations & OOS
      const batchOos = [];
      for (const sid of sampleIds) {
        const oos = await db.query.oosInvestigations.findMany({ where: eq(oosInvestigations.sampleId, sid) });
        batchOos.push(...oos);
      }

      // r2-qms: the deviations about this batch (linked to it, to one of its samples or to an OOS of one), open and closed.
      const deviations = await findBatchDeviations(db, batch, sampleIds);

      // The master record(s) of this batch number: product, dates, size, status (r2-master-data).
      const master = (await db.select({ batch: productBatches, productName: products.name }).from(productBatches)
        .innerJoin(products, eq(products.id, productBatches.productId)).where(eq(productBatches.batchNo, batch)).orderBy(products.name))
        .map(r => ({ ...r.batch, productName: r.productName }));

      // Stage 5: Final Release Record
      const releaseRecord = await db.query.batchReleases.findFirst({
        where: eq(batchReleases.batch, batch)
      });

      // Associated Signatures
      const batchSignatures: (typeof signatures.$inferSelect)[] = [];
      for (const sid of sampleIds) {
        const sigs = await db.query.signatures.findMany({ where: eq(signatures.sampleId, sid) });
        batchSignatures.push(...sigs);
      }
      // r1-results-oos: a release signed through signRecord names the batch (entity BatchRelease); v0.1.0 releases are linked by signature_id.
      const relSig = releaseRecord?.signatureId
        ? await db.query.signatures.findFirst({ where: eq(signatures.id, releaseRecord.signatureId) })
        : await db.query.signatures.findFirst({ where: (s, { and, eq }) => and(eq(s.entityType, 'BatchRelease'), eq(s.entityId, batch)) });
      if (relSig && !batchSignatures.some(s => s.id === relSig.id)) batchSignatures.push(relSig);

      // Audit Trail Entries for this batch and associated entities
      const allAudits = await db.query.auditTrail.findMany({
        orderBy: (adt, { asc }) => [asc(adt.sequence)]
      });

      const relevantEntityIds = new Set([
        batch,
        ...sampleIds,
        ...materials.map(m => m.id),
        ...batchResults.map(r => r.id),
        ...batchOos.map(o => o.id)
      ]);

      const batchAudits = allAudits.filter(a => relevantEntityIds.has(a.entityId) || a.newValue?.includes(batch) || a.oldValue?.includes(batch));

      // Users lookup map
      const allUsers = await db.query.users.findMany();
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      const enrichedMaterials = materials.map(m => ({
        ...m,
        dispensedByName: m.dispensedBy ? (userMap.get(m.dispensedBy)?.name || m.dispensedBy) : null,
        verifiedByName: m.verifiedBy ? (userMap.get(m.verifiedBy)?.name || m.verifiedBy) : null
      }));

      const enrichedRelease = releaseRecord ? {
        ...releaseRecord,
        // Who released it as the records say; nobody is named when the record names nobody.
        releasedByName: releaseRecord.releasedBy ? (userMap.get(releaseRecord.releasedBy)?.name || releaseRecord.releasedBy) : null,
        releasedByRole: releaseRecord.releasedBy ? (userMap.get(releaseRecord.releasedBy)?.role ?? null) : null
      } : null;

      res.json({
        batch,
        master,
        deviations,
        materials: enrichedMaterials,
        cleanroom: em.results,
        cleanroomWindows: em.windows,
        samples: batchSamples,
        results: batchResults,
        oos: batchOos,
        release: enrichedRelease,
        signatures: batchSignatures,
        audits: batchAudits
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 1 action: dispense a raw material against its CoA. The dispenser (the signed-in user) states every value; a different
  // person (Reviewer, QA, Admin) verifies it in the same request by signing with their own credentials (VERIFICATION).
  router.post('/traceability/batch/:batch/material', requireAuth, validate(batchMaterialSchema), async (req, res) => {
    const batch = String(req.params.batch);
    const user = (req as any).user;
    const { verifier, ...m } = req.body as z.infer<typeof batchMaterialSchema>;

    // Four eyes, before any password is looked at: the dispenser cannot verify their own dispensing.
    const verifierEmail = verifier.email.trim().toLowerCase();
    const refuseSelf = async () => {
      await recordDenied(db, req, user, { rule: 'batch.material.verify', entity: 'BatchMaterial', batch });
      throw new AppError(403, 'SOD_VIOLATION', 'Segregation of duties: the person who dispensed a material cannot verify it. A second person must verify and sign.');
    };
    if (verifierEmail === String(user.email ?? '').trim().toLowerCase()) await refuseSelf();
    const [checker] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${verifierEmail}`).limit(1);
    // An unknown verifier gets the same answer as a wrong password: the screen does not tell which accounts exist.
    if (!checker) throw new AppError(401, 'INVALID_PASSWORD', 'Invalid password for electronic signature. Check the verifier and the password.');
    if (checker.id === user.id) await refuseSelf();

    const id = `BM-${randomBytes(4).toString('hex').toUpperCase()}`;
    const { result } = await signRecord({
      db, user: { id: checker.id }, meaningCode: 'VERIFICATION',
      credentials: { password: verifier.password, totpCode: verifier.totpCode },
      entityType: 'BatchMaterial', entityId: id,
      context: securityEventContext(req),
      execute: async (tx) => {
        const record = { id, batch, ...m, dispensedBy: user.id, verifiedBy: checker.id, dispensedAt: new Date(), version: 1 };
        await tx.insert(batchMaterials).values(record);
        // The dispensing is the dispenser's act; the verification (written by signRecord under the verifier) is the second person's.
        await writeAudit(tx, user.id, 'Dispense', 'BatchMaterial', id, 'all', '', JSON.stringify(record), `Raw material dispensed for batch ${batch} against CoA ${m.coaNumber}`);
        return {
          recordVersion: 1,
          audit: { action: 'Verify', field: 'coaStatus', oldValue: '', newValue: m.coaStatus, reason: `Dispensing verified against CoA ${m.coaNumber}` },
          result: record,
        };
      },
    });
    res.json(result);
  });

  // Part 11 Cryptographic Audit Trail Chaining Verification for Batch
  router.get('/traceability/batch/:batch/verify-chain', requireAuth, async (req, res) => {
    try {
      const batch = String(req.params.batch);
      const chain = await verifyAuditChain(db, { writeCheckpoints: false });
      const chainValid = chain.isValid;
      const brokenSequence = chain.compromisedSequence;

      res.json({
        batch,
        isChainIntact: chainValid,
        brokenSequence,
        totalAuditedEvents: chain.totalRecords,
        cryptographicStandard: 'SHA-256 Chained Hash Merkle Lineage',
        alcoaVerified: chainValid
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
