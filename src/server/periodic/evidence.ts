// The evidence of a periodic review (roadmap M42): a JSON snapshot of the records the reviewer looks at, built by the server when the
// review is opened, hashed (SHA-256 of the canonical JSON) and never edited. Reading only: nothing here writes.
import { and, desc, eq, sql } from 'drizzle-orm';
import { calibrationHistory, documentVersions, documents, instruments, methods, qualifiedModules, signatures, specifications } from '../../db/schema';
import type { ReviewKind } from '../../db/schema/periodic';
import { calibrationState, utcToday } from '../../lib/validations/instruments';
import { verifyAuditChain } from '../audit/chain';
import type { Db } from '../core/context';
import type { Executor } from '../core/tx';
import { canonicalJson } from '../esign';
import { NotFoundError } from '../http/errors';
import { createHash } from 'crypto';

/** A user who has not signed in for this many days is listed as dormant. A proposal, not a regulatory number (decisionsForUser). */
export const DORMANT_DAYS = 90;
/** The look-back of the system evaluation pack. */
export const SYSTEM_PACK_MONTHS = 12;

const rowsOf = (res: unknown): any[] => (res as { rows: any[] }).rows;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);

export const sha256OfJson = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

async function signaturesOf(ex: Executor, entityType: string, entityId: string) {
  const rows = await ex.select({
    id: signatures.id, meaningCode: signatures.meaningCode, signerName: signatures.signerName, signerRole: signatures.signerRole,
    timestamp: signatures.timestamp, recordVersion: signatures.recordVersion,
  }).from(signatures).where(and(eq(signatures.entityType, entityType), eq(signatures.entityId, entityId))).orderBy(desc(signatures.timestamp)).limit(20);
  return rows.map(r => ({ ...r, timestamp: iso(r.timestamp) }));
}

/** users x role x last sign-in x training. Never a password hash or an authenticator secret. */
async function userAccess(ex: Executor, now: Date) {
  const rows = rowsOf(await ex.execute(sql`
    SELECT u.id, u.name, u.email, u.role, u.active, u.has_completed_software_training AS software_training, u.totp_enabled AS mfa,
           u.created_at, (u.locked_at IS NOT NULL OR (u.login_locked_until IS NOT NULL AND u.login_locked_until > now())) AS locked,
           (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
           (SELECT count(*) FROM training_assignments a WHERE a.user_id = u.id AND a.status IN ('Assigned', 'Overdue')) AS open_training,
           (SELECT count(*) FROM training_assignments a WHERE a.user_id = u.id AND a.status = 'Overdue') AS overdue_training
    FROM users u WHERE u.role <> 'Service' ORDER BY u.id COLLATE "C"`));
  const cutoff = now.getTime() - DORMANT_DAYS * 86_400_000;
  const users = rows.map(r => ({
    id: r.id, name: r.name, email: r.email, role: r.role, active: !!r.active, locked: !!r.locked, mfaEnabled: !!r.mfa,
    softwareTrainingCompleted: !!r.software_training, openTrainingAssignments: num(r.open_training), overdueTrainingAssignments: num(r.overdue_training),
    lastLoginAt: iso(r.last_login), createdAt: iso(r.created_at),
    dormant: !!r.active && (r.last_login ? new Date(r.last_login).getTime() < cutoff : new Date(r.created_at).getTime() < cutoff),
  }));
  const active = users.filter(u => u.active);
  const byRole: Record<string, number> = {};
  for (const u of active) byRole[u.role] = (byRole[u.role] ?? 0) + 1;
  return {
    users,
    summary: {
      total: users.length, active: active.length, inactive: users.length - active.length, activeByRole: byRole,
      dormantDays: DORMANT_DAYS, dormantActive: users.filter(u => u.dormant).length, neverSignedIn: active.filter(u => !u.lastLoginAt).length,
      withoutMfa: active.filter(u => !u.mfaEnabled).length, withoutSoftwareTraining: active.filter(u => !u.softwareTrainingCompleted).length,
      withOverdueTraining: active.filter(u => u.overdueTrainingAssignments > 0).length,
    },
  };
}

async function instrumentEvidence(ex: Executor, id: string, now: Date) {
  const [inst] = await ex.select().from(instruments).where(eq(instruments.id, id)).limit(1);
  if (!inst) throw new NotFoundError(`Instrument ${id} was not found.`);
  const history = await ex.select().from(calibrationHistory).where(eq(calibrationHistory.instrumentId, id)).orderBy(desc(calibrationHistory.performedAt)).limit(12);
  const [usage] = rowsOf(await ex.execute(sql`SELECT count(*) AS n FROM instrument_usage_log WHERE instrument_id = ${id} AND at > ${new Date(now.getTime() - 365 * 86_400_000)}`));
  const [res] = rowsOf(await ex.execute(sql`SELECT count(*) AS n FROM results WHERE instrument_id = ${id}`));
  const cal = calibrationState(inst.calibrationDueDate, now);
  return {
    instrument: { id: inst.id, name: inst.name, type: inst.type, status: inst.status, version: inst.version },
    calibration: { lastCalibrationDate: inst.lastCalibrationDate, calibrationDueDate: inst.calibrationDueDate, overdue: cal.expired, daysRemaining: cal.daysRemaining },
    calibrationHistory: history.map(h => ({ id: h.id, performedAt: iso(h.performedAt), previousDueDate: h.previousDueDate, newDueDate: h.newDueDate, statusBefore: h.statusBefore, statusAfter: h.statusAfter, reason: h.reason })),
    usage: { eventsLast12Months: num(usage?.n), resultsRecordedWithInstrument: num(res?.n) },
    signatures: await signaturesOf(ex, 'Instrument', id),
  };
}

async function specificationEvidence(ex: Executor, id: string) {
  const [spec] = await ex.select().from(specifications).where(eq(specifications.id, id)).limit(1);
  if (!spec) throw new NotFoundError(`Specification ${id} was not found.`);
  const [used] = rowsOf(await ex.execute(sql`SELECT count(*) AS n FROM samples WHERE spec_id = ${id}`));
  return {
    specification: { id: spec.id, material: spec.material, version: spec.version, revisionLabel: spec.revisionLabel, effectiveDate: spec.effectiveDate, status: spec.status, parameterCount: spec.parameters.length, parameters: spec.parameters },
    samplesTestedAgainstIt: num(used?.n),
    signatures: await signaturesOf(ex, 'Specification', id),
  };
}

async function methodEvidence(ex: Executor, id: string) {
  const [m] = await ex.select().from(methods).where(eq(methods.id, id)).limit(1);
  if (!m) throw new NotFoundError(`Method ${id} was not found.`);
  const [used] = rowsOf(await ex.execute(sql`SELECT count(*) AS n FROM spec_parameters WHERE method_code = ${m.code}`));
  return {
    method: { id: m.id, code: m.code, title: m.title, revision: m.revision, status: m.status, instrumentType: m.instrumentType, approvedAt: iso(m.approvedAt), sstCriteriaCount: m.sstCriteria.length },
    specificationParametersUsingIt: num(used?.n),
    signatures: await signaturesOf(ex, 'Method', id),
  };
}

async function documentEvidence(ex: Executor, id: string, now: Date) {
  const [doc] = await ex.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) throw new NotFoundError(`Document ${id} was not found.`);
  const versions = await ex.select().from(documentVersions).where(eq(documentVersions.documentId, id)).orderBy(desc(documentVersions.revision));
  const effective = versions.find(v => v.status === 'Effective') ?? null;
  const reviewDue = effective?.effectiveAt ? new Date(Date.UTC(effective.effectiveAt.getUTCFullYear(), effective.effectiveAt.getUTCMonth() + doc.reviewPeriodMonths, effective.effectiveAt.getUTCDate())).toISOString().slice(0, 10) : null;
  return {
    document: { id: doc.id, code: doc.code, title: doc.title, docType: doc.docType, reviewPeriodMonths: doc.reviewPeriodMonths },
    effectiveVersion: effective ? { id: effective.id, revision: effective.revision, effectiveAt: iso(effective.effectiveAt), approvedAt: iso(effective.approvedAt) } : null,
    documentReviewDueByPeriod: reviewDue, documentReviewOverdue: reviewDue ? reviewDue < utcToday(now) : null,
    versions: versions.map(v => ({ id: v.id, revision: v.revision, status: v.status, effectiveAt: iso(v.effectiveAt) })),
    signatures: await signaturesOf(ex, 'DocumentVersion', effective?.id ?? id),
  };
}

async function moduleEvidence(ex: Executor, key: string) {
  const [row] = await ex.select().from(qualifiedModules).where(eq(qualifiedModules.id, key)).limit(1);
  return {
    module: key,
    declaration: row ? { status: row.status, reason: row.reason, evidenceRef: row.evidenceRef, updatedAt: iso(row.updatedAt), version: row.version } : null,
    declared: !!row,
    signatures: await signaturesOf(ex, 'QualifiedModule', key),
  };
}

/** The annual system evaluation pack: deviations, changes, backups, restore tests and audit-review coverage over the last 12 months. */
async function systemPack(db: Db, now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - SYSTEM_PACK_MONTHS, now.getUTCDate()));
  const qms = rowsOf(await db.execute(sql`
    SELECT type, count(*) FILTER (WHERE created_at >= ${from}) AS opened, count(*) FILTER (WHERE closed_at >= ${from}) AS closed,
           count(*) FILTER (WHERE closed_at IS NULL) AS open_now,
           count(*) FILTER (WHERE closed_at IS NULL AND due_date IS NOT NULL AND due_date < ${utcToday(now)}) AS overdue_now
    FROM qms_records GROUP BY type ORDER BY type COLLATE "C"`));
  const backups = rowsOf(await db.execute(sql`
    SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'ok') AS ok, count(*) FILTER (WHERE status <> 'ok') AS failed,
           count(*) FILTER (WHERE status = 'ok' AND verified) AS verified, max(finished_at) FILTER (WHERE status = 'ok') AS last_ok
    FROM backup_runs WHERE started_at >= ${from}`))[0];
  const drills = rowsOf(await db.execute(sql`
    SELECT count(*) AS runs, count(*) FILTER (WHERE passed) AS passed, count(*) FILTER (WHERE NOT passed) AS failed, max(finished_at) FILTER (WHERE passed) AS last_passed
    FROM restore_drills WHERE started_at >= ${from}`))[0];
  const reviews = rowsOf(await db.execute(sql`
    SELECT count(*) AS reviews, coalesce(sum(rows_reviewed), 0) AS rows_reviewed, coalesce(sum(exception_count), 0) AS exceptions
    FROM audit_reviews WHERE reviewed_at >= ${from}`))[0];
  const [audit] = rowsOf(await db.execute(sql`SELECT count(*) AS n, coalesce(max(sequence), 0) AS head FROM audit_trail`));
  const [auditInPeriod] = rowsOf(await db.execute(sql`SELECT count(*) AS n FROM audit_trail WHERE timestamp >= ${from}`));
  const chain = await verifyAuditChain(db, { writeCheckpoints: false });
  const modules = rowsOf(await db.execute(sql`SELECT status, count(*) AS n FROM qualified_modules GROUP BY status ORDER BY status COLLATE "C"`));
  const security = rowsOf(await db.execute(sql`SELECT outcome, count(*) AS n FROM security_events WHERE timestamp >= ${from} GROUP BY outcome ORDER BY outcome COLLATE "C"`));
  const periodic = rowsOf(await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'Completed' AND completed_at >= ${from}) AS completed,
           count(*) FILTER (WHERE status = 'Open' AND due_date < ${utcToday(now)}) AS overdue FROM periodic_reviews`))[0];
  return {
    periodFrom: from.toISOString().slice(0, 10), periodTo: utcToday(now),
    qualityRecords: qms.map(r => ({ type: r.type, openedInPeriod: num(r.opened), closedInPeriod: num(r.closed), openNow: num(r.open_now), overdueNow: num(r.overdue_now) })),
    backups: { runs: num(backups.runs), ok: num(backups.ok), failed: num(backups.failed), verified: num(backups.verified), lastOkAt: iso(backups.last_ok) },
    restoreTests: { runs: num(drills.runs), passed: num(drills.passed), failed: num(drills.failed), lastPassedAt: iso(drills.last_passed) },
    auditReviewCoverage: { reviews: num(reviews.reviews), rowsReviewed: num(reviews.rows_reviewed), exceptions: num(reviews.exceptions), auditEntriesInPeriod: num(auditInPeriod.n) },
    auditChain: { valid: chain.isValid, entries: chain.totalRecords, headSequence: chain.headSequence, compromisedSequence: chain.compromisedSequence },
    auditEntriesTotal: num(audit.n),
    qualifiedModules: Object.fromEntries(modules.map(m => [m.status, num(m.n)])),
    securityEventsByOutcome: Object.fromEntries(security.map(s => [s.outcome, num(s.n)])),
    periodicReviews: { completedInPeriod: num(periodic.completed), overdueNow: num(periodic.overdue) },
  };
}

export async function buildEvidence(db: Db, kind: ReviewKind, subjectId: string, now = new Date()): Promise<{ evidence: Record<string, unknown>; sha256: string }> {
  let body: Record<string, unknown>;
  switch (kind) {
    case 'user_access': body = await userAccess(db, now); break;
    case 'instrument': body = await instrumentEvidence(db, subjectId, now); break;
    case 'specification': body = await specificationEvidence(db, subjectId); break;
    case 'method': body = await methodEvidence(db, subjectId); break;
    case 'document': body = await documentEvidence(db, subjectId, now); break;
    case 'module': body = await moduleEvidence(db, subjectId); break;
    case 'system': body = await systemPack(db, now); break;
  }
  const evidence = { kind, subjectId, generatedAt: now.toISOString(), ...body };
  return { evidence, sha256: sha256OfJson(evidence) };
}

/** Whether the subject of a plan exists (checked when the plan is created). */
export async function subjectExists(ex: Executor, kind: ReviewKind, subjectId: string): Promise<boolean> {
  const one = async (table: 'instruments' | 'specifications' | 'methods' | 'documents') =>
    rowsOf(await ex.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${subjectId} LIMIT 1`)).length > 0;
  switch (kind) {
    case 'user_access': case 'system': return subjectId === '*';
    case 'instrument': return one('instruments');
    case 'specification': return one('specifications');
    case 'method': return one('methods');
    case 'document': return one('documents');
    case 'module': return (await import('../qualified')).MODULES.some(m => m.key === subjectId);
  }
}
