// Domain: signatures (roadmap M07). Verification of one signature, the meaning catalog the signature dialog reads, and the signatures of one record.
// Making a signature is not a route of its own: every signing route calls signRecord (src/server/esign).
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { auditTrail, signatures } from '../../db/schema';
import { entityParamsSchema, signatureIdParamsSchema } from '../../lib/validations/signatures';
import { listActiveMeanings, verifySignature } from '../esign';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

const STATUS_TEXT: Record<string, string> = {
  valid: 'The record is exactly as it was signed and the audit chain is intact.',
  'record-modified': 'The record has been changed since it was signed.',
  'record-missing': 'The signed record no longer exists.',
  'chain-broken': 'The record matches, but an audit entry up to this signature has been altered.',
  'legacy-unverifiable': 'Signed before signatures could be recomputed. It is neither confirmed nor refuted.',
  'audit-missing': 'The audit entry of this signature cannot be found.',
  unsupported: 'This record type is not known to this version of the application.',
};

export const signaturesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // Recomputes the hash of the signed record and checks the audit chain up to the signature's entry.
  router.get('/signatures/verify/:id', requireAuth, validate(signatureIdParamsSchema, 'params'), async (req, res) => {
    const v = await verifySignature(db, String(req.params.id));
    if (!v) throw new NotFoundError('Signature record not found in 21 CFR Part 11 vault');
    const { signature: s, audit, signer, binding } = v;
    res.json({
      valid: v.valid,
      status: v.status,
      statusText: STATUS_TEXT[v.status],
      contentHashMatches: v.contentHashMatches,
      chainIntact: v.chainIntact,
      entityType: binding.entityType,
      entityId: binding.entityId,
      hashVersion: s.hashVersion,
      signature: {
        id: s.id,
        sampleId: s.sampleId,
        signerName: signer.name,
        signerEmail: signer.email,
        signerRole: signer.role,
        snapshot: signer.snapshot, // false: a signature made before the name and role were recorded; they show the user's current record
        meaningCode: s.meaningCode,
        meaning: s.meaning,
        authMethod: s.authMethod,
        reason: s.reason,
        timestamp: s.timestamp,
        recordVersion: s.recordVersion,
        contentHash: s.contentHash,
        auditEntryId: s.auditEntryId,
      },
      auditRecord: audit ? { sequence: audit.sequence, action: audit.action, timestamp: audit.timestamp, hash: audit.hash } : null,
      complianceSummary: {
        part11Compliant: v.valid,
        alcoaAttributable: !!signer.name,
        alcoaContemporaneous: !!s.timestamp,
        alcoaOriginal: true,
        alcoaAccurate: v.valid,
      },
    });
  });

  // The catalog, with what the caller's role may use. The dialog shows the text; the server decides at signing time.
  router.get('/signatures/meanings', requireAuth, async (req, res) => {
    const role = (req as any).user.role as string;
    const rows = await listActiveMeanings(db);
    res.json(rows.map(m => ({
      code: m.code, text: m.text, requiresReason: m.requiresReason, trainingExempt: m.trainingExempt,
      allowedRoles: m.allowedRoles, allowedForYou: m.allowedRoles.includes(role),
    })));
  });

  // The manifestations of one record, newest first. A signature written by a route that has not moved to signRecord has no binding
  // columns; it is found through its audit entry's entity and entity id.
  router.get('/signatures/entity/:type/:id', requireAuth, validate(entityParamsSchema, 'params'), async (req, res) => {
    const { type, id } = req.params as { type: string; id: string };
    const rows = await db.select({ s: signatures, a: { entity: auditTrail.entity, entityId: auditTrail.entityId } }).from(signatures)
      .leftJoin(auditTrail, eq(auditTrail.id, signatures.auditEntryId))
      .where(or(
        and(eq(signatures.entityType, type), eq(signatures.entityId, id)),
        and(isNull(signatures.entityType), sql`coalesce(${auditTrail.entity}, 'Sample') = ${type}`, sql`coalesce(${auditTrail.entityId}, ${signatures.sampleId}) = ${id}`),
      ))
      .orderBy(desc(signatures.timestamp));
    res.json(rows.map(({ s }) => ({
      id: s.id, entityType: type, entityId: id, meaningCode: s.meaningCode, meaning: s.meaning, signerName: s.signerName, signerRole: s.signerRole,
      authMethod: s.authMethod, reason: s.reason, timestamp: s.timestamp, recordVersion: s.recordVersion, hashVersion: s.hashVersion,
    })));
  });

  return router;
};
