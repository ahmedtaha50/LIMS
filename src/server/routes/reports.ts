// Domain: reports. Moved from src/server/api.ts by r1-core; handlers are unchanged except where docs/changes/r1-core.md says otherwise.
import { eq } from 'drizzle-orm';
import { results, samples, signatures } from '../../db/schema';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { reportsRouter } from '../reports';

export const reportsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.use(reportsRouter);

  router.get('/reports/batch/:batch', requireAuth, async (req, res) => {
    try {
      const batchNo = String(req.params.batch);
      const batchSamples = await db.query.samples.findMany({ where: eq(samples.batch, String(batchNo)) });
      if (batchSamples.length === 0) return res.status(404).json({ error: 'Batch not found or no samples exist.' });
      
      let allResults = [];
      let allSignatures = [];
      
      for (const sample of batchSamples) {
        const resData = await db.query.results.findMany({ where: eq(results.sampleId, sample.id) });
        const sigData = await db.query.signatures.findMany({ where: eq(signatures.sampleId, sample.id) });
        allResults.push(...resData);
        allSignatures.push(...sigData);
      }
      
      res.json({ samples: batchSamples, results: allResults, signatures: allSignatures });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/trends', requireAuth, async (req, res) => {
    try {
      const { material, parameter } = req.query;
      
      // We can just fetch all samples and results since data is likely small, 
      // or use a targeted query. We'll use Drizzle query builders.
      const allSamples = await db.query.samples.findMany({
         where: material ? eq(samples.material, String(material)) : undefined,
         orderBy: (samples, { asc }) => [asc(samples.createdAt)]
      });
      
      const sampleIds = allSamples.map(s => s.id);
      if (sampleIds.length === 0) return res.json([]);
      
      let allResults = [];
      // Doing chunks to avoid too large query, or just fetch all
      allResults = await db.query.results.findMany();
      
      let trendData = [];
      
      for (const sample of allSamples) {
        const sampleResults = allResults.filter(r => r.sampleId === sample.id);
        const targetResult = parameter 
          ? sampleResults.find(r => r.parameter === String(parameter))
          : sampleResults[0]; // just pick the first one if no param specified
          
        if (targetResult && targetResult.value !== null) {
          const numVal = parseFloat(targetResult.value);
          if (!isNaN(numVal)) {
            trendData.push({
              batch: sample.batch,
              date: new Date(sample.createdAt).toISOString().slice(0, 10), // not toLocaleDateString: the server's regional settings would decide the order of day and month
              value: numVal,
              specMin: targetResult.specMin,
              specMax: targetResult.specMax,
              parameter: targetResult.parameter,
              isOos: targetResult.isOos
            });
          }
        }
      }
      
      res.json(trendData);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/filters', requireAuth, async (req, res) => {
    try {
      const allSamples = await db.query.samples.findMany();
      const allResults = await db.query.results.findMany();
      
      const materials = [...new Set(allSamples.map(s => s.material))];
      const parameters = [...new Set(allResults.map(r => r.parameter))];
      
      res.json({ materials, parameters });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/metrics', requireAuth, async (req, res) => {
    try {
      const allSamples = await db.query.samples.findMany();
      const allResults = await db.query.results.findMany();
      
      // Batch status distribution
      const statusCounts = {
        'Testing': 0,
        'Pending Review': 0,
        'Approved': 0,
        'Rejected': 0
      };
      
      allSamples.forEach((s: any) => {
        const st = String(s.state);
        if (statusCounts[st] !== undefined) {
          statusCounts[st]++;
        }
      });

      const batchStatus = Object.keys(statusCounts).map(key => ({
        name: key,
        value: statusCounts[key]
      }));

      // Pass / Fail rates based on Results
      let passCount = 0;
      let failCount = 0;
      
      allResults.forEach(r => {
        if (r.value !== null) {
          if (r.isOos) failCount++;
          else passCount++;
        }
      });
      
      const passFailRates = [
        { name: 'Pass', value: passCount },
        { name: 'OOS (Fail)', value: failCount }
      ];

      // Pending metrics (we can just use the status counts for Pending Review)
      const pendingApprovals = statusCounts['Pending Review'];
      
      res.json({
        batchStatus,
        passFailRates,
        pendingApprovals,
        totalSamples: allSamples.length
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
