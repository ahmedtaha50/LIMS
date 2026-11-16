import { writeAudit } from '../audit/index.js';
import { HttpError, notFound } from '../core/errors.js';
import { Design } from './design.js';
import { view, type Ctx } from './service.js';

/**
 * E23: copies any version of a master batch record into a NEW master, as its version 1 in draft. The copy carries the
 * design (checked again against the current design rules) and records where it came from: `based_on` points to the source
 * version, and the audit entry names the source master and version. It goes through the same review and QA approval as any
 * draft. The source is only read: its rows are not locked for change and nothing of it is written.
 */
export async function copyToNewMaster(x: Ctx, sourceMasterId: string, sourceVersionId: string, input: { code: string; productName: string }) {
  const src = (await x.c.query<{ id: string; version_no: number; design: unknown; code: string; product_name: string }>(
    'SELECT v.id, v.version_no, v.design, m.code, m.product_name FROM mbr_versions v JOIN mbr_masters m ON m.id = v.master_id WHERE v.id = $1 AND v.master_id = $2',
    [sourceVersionId, sourceMasterId])).rows[0];
  if (!src) throw notFound('No such version of this master batch record.');
  const design = Design.parse(src.design);
  const m = await x.c.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [input.code, input.productName]);
  if (!m.rows[0]) throw new HttpError(409, 'code_taken', `A master batch record with the code ${input.code} exists.`);
  const id = m.rows[0].id;
  const v = (await x.c.query('INSERT INTO mbr_versions (master_id, version_no, design, based_on, author_id, author_name) VALUES ($1, 1, $2, $3, $4, $5) RETURNING *',
    [id, JSON.stringify(design), src.id, x.actor.userId, x.actor.username])).rows[0];
  const copiedFrom = { masterId: sourceMasterId, code: src.code, versionId: src.id, versionNo: src.version_no };
  await writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action: 'mbr.copied', entity: 'mbr', entityId: id, requestId: x.requestId,
    newValue: { code: input.code, productName: input.productName, version: 1, design, copiedFrom } });
  return { id, code: input.code, productName: input.productName, copiedFrom, version: view(v) };
}
