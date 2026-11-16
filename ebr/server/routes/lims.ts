import { writeAudit } from '../audit/index.js';
import { route } from '../core/route.js';
import { APPROVED, getSample, limsConfig } from '../lims/client.js';

type Row = { external_ref: string; step_key: string; lims_sample_id: string; test: string; status: string; result: unknown; result_at: Date | null };

export const routes = [
  route({
    method: 'GET', path: '/api/batches/:id/lims', permission: 'batch.read', summary: 'The LIMS samples of a batch; approved results are fetched from the LIMS and kept on the batch',
    handler: async ({ pool, params, actor, res }) => {
      const id = params.id as string;
      const rows = (await pool.query<Row>('SELECT * FROM lims_requests WHERE batch_id = $1 ORDER BY created_at', [id])).rows;
      const cfg = limsConfig();
      let reachable = true;
      for (const r of rows.filter(x => x.status !== APPROVED)) {
        if (!cfg) { reachable = false; break; }
        try {
          const s = await getSample(cfg, r.lims_sample_id);   // E30: the sample as the LIMS machine API has it
          if (s.status !== r.status) {
            // E18#1: the result is kept on the batch only once it is APPROVED in the LIMS
            const approved = s.status === APPROVED;
            await pool.query('UPDATE lims_requests SET status = $2, result = CASE WHEN $3 THEN $4::jsonb ELSE result END, result_at = CASE WHEN $3 THEN now() ELSE result_at END WHERE external_ref = $1', [r.external_ref, s.status, approved, JSON.stringify(s.result ?? null)]);
            if (approved) {
              const c = await pool.connect();
              try { await c.query('BEGIN'); await writeAudit(c, { actorId: actor!.userId, actorName: 'lims', action: 'batch.lims_result', entity: 'batch', entityId: id, newValue: { externalRef: r.external_ref, sample: s.id, result: s.result }, requestId: String(res.locals.requestId) }); await c.query('COMMIT'); }
              catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
            }
            Object.assign(r, { status: s.status, result: approved ? s.result ?? null : r.result });
          }
        } catch { reachable = false; break; }
      }
      return { limsReachable: reachable, samples: rows.map(r => ({ externalRef: r.external_ref, step: r.step_key, limsSampleId: r.lims_sample_id, test: r.test, status: r.status, result: r.status === APPROVED ? r.result : null })) };
    },
  }),
];
