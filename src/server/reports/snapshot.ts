/**
 * The content of a Certificate of Analysis (roadmap M25), read from the records and frozen into coa_documents.snapshot when the
 * certificate is issued. Every PDF of the certificate, the original and each copy, is printed from this snapshot and nothing else, so
 * a later change to a master record (a product renamed, a method revised) cannot change what an issued certificate says.
 *
 *   specText       the limit as printed: NLT 98.0 %, NMT 0.50 %, 98.0 - 102.0 %, or the acceptance text
 *   conclusionOf   Complies only when every reported result is entered and none is out of specification. Computed from the
 *                  evaluation flags (results.is_oos); an investigation's decision never turns a failing flag into a pass
 *   buildCoaSnapshot
 *                  one row per result; a result whose OOS value was replaced under its investigation also gets the original row
 *                  (not reported) next to the retest (reported); every correction is counted (AMENDED(n)) with its coded reason
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { methods, oosInvestigations, productBatches, products, customers, results, sampleContext, samples, signatures, specParameters, specifications, users } from '../../db/schema';
import { resultVersions } from '../../db/schema/rawdata';
import { limitText } from '../../lib/numeric';
import type { Executor } from '../core/tx';
import { NotFoundError } from '../http/errors';
import { SERVER_VERSION_CODES, VERSION_CODE_LABELS, type VersionCode } from '../services/result-hooks/codes';

export type RowConclusion = 'Complies' | 'Does not comply' | 'Not entered';

export interface CoaAmendment { version: number; code: string; label: string; reason: string; previousValue: string | null; value: string | null; at: string }

export interface CoaResultRow {
  resultId: string;
  parameter: string;
  /** Result: the only value the result has had (corrections aside). Original: an OOS value replaced under its investigation, not
   *  reported. Retest: the value that replaced it, reported. */
  kind: 'Result' | 'Original' | 'Retest';
  reported: boolean;
  value: string | null;
  unit: string;
  specText: string;
  isOos: boolean;
  conclusion: RowConclusion;
  method: { code: string; revision: number | null; title: string | null } | null;
  amended: number;
  amendments: CoaAmendment[];
  oos: { id: string; status: string; decision: string | null } | null;
  enteredAt: string | null;
}

export interface CoaSnapshot {
  schema: 1;
  /** Null in a preview (src/server/pdfWorker.ts): a preview has no number and is not a certificate. */
  certificate: { number: string; issueVersion: number; label: string } | null;
  sample: { id: string; material: string; batch: string; state: string; version: number; registeredAt: string };
  product: { code: string; name: string } | null;
  batch: { batchNo: string; manufacturedOn: string | null; expiresOn: string | null; batchSize: string | null } | null;
  customer: { code: string; name: string } | null;
  specification: { id: string; material: string; revision: number; effectiveDate: string } | null;
  results: CoaResultRow[];
  conclusion: { complies: boolean; text: string };
  /** The signatures on the sample (submission, approval): the review chain the certificate rests on. */
  approvals: Array<{ meaning: string; signerName: string; signerRole: string; timestamp: string }>;
  supersedes: { id: string; label: string; reason: string } | null;
  issuedAt: string | null;
}

export interface LimitForText { limitKind: string | null; lower: string | null; upper: string | null; unit: string | null; text: string | null }

/** The limit as the certificate prints it. Never "null - null": a missing part is said in words. */
export function specText(l: LimitForText): string {
  const unit = l.unit ? ` ${l.unit}` : '';
  switch (l.limitKind) {
    case 'RANGE': return l.lower !== null && l.upper !== null ? `${l.lower} - ${l.upper}${unit}` : l.lower !== null ? `NLT ${l.lower}${unit}` : l.upper !== null ? `NMT ${l.upper}${unit}` : 'No limit recorded';
    case 'NLT': return l.lower !== null ? `NLT ${l.lower}${unit}` : 'No limit recorded';
    case 'NMT': return l.upper !== null ? `NMT ${l.upper}${unit}` : 'No limit recorded';
    case 'TEXT':
    case 'PRESENCE': return l.text && l.text.trim() ? l.text.trim() : 'As per specification (no text recorded)';
    default: return 'No limit recorded';
  }
}

const entered = (v: string | null | undefined) => v !== null && v !== undefined && v !== '';

/** The conclusion of the certificate, from the reported rows. `revision` names the specification revision in the text. */
export function conclusionOf(rows: ReadonlyArray<Pick<CoaResultRow, 'parameter' | 'value' | 'isOos' | 'reported'>>, revision?: number | null): { complies: boolean; text: string } {
  const reported = rows.filter(r => r.reported !== false);
  const spec = `the specification${revision ? ` (revision ${revision})` : ''}`;
  if (reported.length === 0) return { complies: false, text: `No result is reported: the sample cannot be certified against ${spec}.` };
  const failing = reported.filter(r => r.isOos).map(r => `${r.parameter} (out of specification)`);
  const missing = reported.filter(r => !r.isOos && !entered(r.value)).map(r => `${r.parameter} (not entered)`);
  if (failing.length || missing.length) return { complies: false, text: `The sample does not comply with ${spec}: ${[...failing, ...missing].join(', ')}.` };
  return { complies: true, text: `The sample complies with ${spec}.` };
}

const rowConclusion = (value: string | null, isOos: boolean): RowConclusion => (isOos ? 'Does not comply' : entered(value) ? 'Complies' : 'Not entered');
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The limit of a results row as text, also for a v0.1.0 row that kept only spec_min / spec_max. */
function limitOf(r: typeof results.$inferSelect): LimitForText {
  if (r.limitKind) return { limitKind: r.limitKind, lower: r.lowerText, upper: r.upperText, unit: r.unit, text: r.acceptanceText };
  const lower = limitText(r.specMin, null), upper = limitText(r.specMax, null);
  return { limitKind: lower !== null && upper !== null ? 'RANGE' : lower !== null ? 'NLT' : upper !== null ? 'NMT' : 'TEXT', lower, upper, unit: r.unit, text: r.acceptanceText };
}

async function batchOf(ex: Executor, sample: typeof samples.$inferSelect) {
  const [ctx] = await ex.select().from(sampleContext).where(eq(sampleContext.sampleId, sample.id)).limit(1);
  if (ctx) {
    const [p] = await ex.select().from(products).where(eq(products.id, ctx.productId)).limit(1);
    const [b] = await ex.select().from(productBatches).where(eq(productBatches.id, ctx.batchId)).limit(1);
    const [c] = ctx.customerId ? await ex.select().from(customers).where(eq(customers.id, ctx.customerId)).limit(1) : [];
    return { product: p ?? null, batch: b ?? null, customer: c ?? null };
  }
  // A sample registered with free text (no sample_context row): the batch of the product of that name, if master data has it.
  const [hit] = await ex.select({ p: products, b: productBatches }).from(productBatches)
    .innerJoin(products, eq(products.id, productBatches.productId))
    .where(and(eq(productBatches.batchNo, sample.batch), sql`lower(${products.name}) = lower(${sample.material})`)).limit(1);
  return { product: hit?.p ?? null, batch: hit?.b ?? null, customer: null };
}

async function methodsOf(ex: Executor, specId: string | null) {
  const byParameter = new Map<string, { code: string; revision: number | null; title: string | null }>();
  const position = new Map<string, number>();
  if (!specId) return { byParameter, position };
  const params = await ex.select().from(specParameters).where(eq(specParameters.specId, specId)).orderBy(asc(specParameters.position));
  for (const p of params) position.set(p.name.trim().toLowerCase(), p.position);
  const codes = [...new Set(params.map(p => p.methodCode).filter((c): c is string => !!c))];
  if (codes.length === 0) return { byParameter, position };
  const rows = await ex.select().from(methods).where(inArray(sql`lower(${methods.code})`, codes.map(c => c.toLowerCase())))
    .orderBy(desc(methods.revision));
  for (const p of params) {
    if (!p.methodCode) continue;
    const same = rows.filter(m => m.code.toLowerCase() === p.methodCode!.toLowerCase());
    const m = same.find(x => x.status === 'Effective') ?? null;
    byParameter.set(p.name.trim().toLowerCase(), { code: p.methodCode, revision: m?.revision ?? null, title: m?.title ?? null });
  }
  return { byParameter, position };
}

/**
 * Reads the snapshot of `sampleId`. `certificate` and `supersedes` describe the document being issued (null for a preview).
 * Call it inside the issuing transaction, after the sample row is locked, so the content is the one the signature covers.
 */
export async function buildCoaSnapshot(ex: Executor, sampleId: string, doc: {
  certificate: CoaSnapshot['certificate']; supersedes: CoaSnapshot['supersedes']; issuedAt: Date | null;
}): Promise<CoaSnapshot> {
  const [sample] = await ex.select().from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!sample) throw new NotFoundError(`Sample ${sampleId} was not found.`);
  const [spec] = sample.specId ? await ex.select().from(specifications).where(eq(specifications.id, sample.specId)).limit(1) : [];
  const { product, batch, customer } = await batchOf(ex, sample);
  const { byParameter, position } = await methodsOf(ex, sample.specId);

  const rows = await ex.select().from(results).where(eq(results.sampleId, sampleId)).orderBy(asc(results.parameter), asc(results.id));
  rows.sort((a, b) => (position.get(a.parameter.trim().toLowerCase()) ?? 1e9) - (position.get(b.parameter.trim().toLowerCase()) ?? 1e9));
  const ids = rows.map(r => r.id);
  const versions = ids.length ? await ex.select().from(resultVersions).where(inArray(resultVersions.resultId, ids)).orderBy(asc(resultVersions.resultVersion)) : [];
  const investigations = ids.length ? await ex.select().from(oosInvestigations).where(inArray(oosInvestigations.resultId, ids)).orderBy(asc(oosInvestigations.id)) : [];
  const investigation = (id: string | null | undefined) => {
    const o = investigations.find(x => x.id === id);
    return o ? { id: o.id, status: o.status, decision: o.decision ?? null } : null;
  };

  const out: CoaResultRow[] = [];
  for (const r of rows) {
    const key = r.parameter.trim().toLowerCase();
    const mine = versions.filter(v => v.resultId === r.id);
    const amendments: CoaAmendment[] = mine.filter(v => !(SERVER_VERSION_CODES as readonly string[]).includes(v.changeCode)).map(v => ({
      version: v.resultVersion, code: v.changeCode, label: VERSION_CODE_LABELS[v.changeCode as VersionCode] ?? v.changeCode, reason: v.reason,
      previousValue: v.previousValue, value: v.value, at: v.enteredAt.toISOString(),
    }));
    const base = { resultId: r.id, parameter: r.parameter, unit: r.unit ?? '', specText: specText(limitOf(r)), method: byParameter.get(key) ?? null };
    // OOS values replaced under their investigation: each is an original row, not reported, next to the value now reported.
    const replaced = mine.filter(v => v.oosId);
    for (const v of replaced) {
      out.push({ ...base, kind: 'Original', reported: false, value: v.previousValue, isOos: true, conclusion: 'Does not comply', amended: 0, amendments: [], oos: investigation(v.oosId), enteredAt: null });
    }
    const latestOos = investigations.filter(o => o.resultId === r.id).pop();
    out.push({
      ...base, kind: replaced.length ? 'Retest' : 'Result', reported: true, value: r.value, isOos: r.isOos, conclusion: rowConclusion(r.value, r.isOos),
      amended: amendments.length, amendments, oos: latestOos ? investigation(latestOos.id) : null, enteredAt: iso(r.enteredAt),
    });
  }

  const sampleSignatures = await ex.select({ s: signatures, name: users.name, role: users.role }).from(signatures)
    .leftJoin(users, eq(users.id, signatures.signerId))
    .where(and(eq(signatures.sampleId, sampleId), sql`coalesce(${signatures.entityType}, 'Sample') = 'Sample'`))
    .orderBy(asc(signatures.timestamp));

  return {
    schema: 1,
    certificate: doc.certificate,
    sample: { id: sample.id, material: sample.material, batch: sample.batch, state: sample.state, version: sample.version, registeredAt: sample.createdAt.toISOString() },
    product: product ? { code: product.code, name: product.name } : null,
    batch: batch ? { batchNo: batch.batchNo, manufacturedOn: batch.manufacturedOn, expiresOn: batch.expiresOn, batchSize: batch.batchSize } : null,
    customer: customer ? { code: customer.code, name: customer.name } : null,
    specification: spec ? { id: spec.id, material: spec.material, revision: sample.specRevision ?? spec.revisionLabel, effectiveDate: spec.effectiveDate } : null,
    results: out,
    conclusion: conclusionOf(out, sample.specRevision ?? spec?.revisionLabel ?? null),
    approvals: sampleSignatures.map(({ s, name, role }) => ({
      meaning: s.meaning, signerName: s.signerName ?? name ?? s.signerId, signerRole: s.signerRole ?? role ?? '', timestamp: s.timestamp.toISOString(),
    })),
    supersedes: doc.supersedes,
    issuedAt: iso(doc.issuedAt),
  };
}
