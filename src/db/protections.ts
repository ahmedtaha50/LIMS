import { auditProtections } from './protections/audit';
import { custodyProtections } from './protections/custody';
import { blockMutation, type ProtectionSet } from './protections/common';
import { documentsProtections } from './protections/documents';
import { equipmentProtections } from './protections/equipment';
import { masterProtections } from './protections/master';
import { methodsProtections } from './protections/methods';
import { opsProtections } from './protections/ops';
import { qmsProtections } from './protections/qms';
import { oosProtections } from '../server/oos/protections';
import { instrumentDataProtections } from '../server/connectors/protections';
import { emProtections } from '../server/em/protections';
import { rawdataProtections } from './protections/rawdata';
import { reagentsProtections } from './protections/reagents';
import { reportsProtections } from './protections/reports';
import { signatureProtections } from './protections/signatures';

/**
 * Database-level immutability for the audit trail and signatures (21 CFR Part 11.10(e)). Idempotent; applied inside the
 * migration transaction (src/server/migrate.ts) and again at every server start. A trigger, not application convention,
 * refuses UPDATE/DELETE/TRUNCATE, so the control holds for any client that connects as the app role.
 * Note: a database owner/superuser can still drop the trigger; that is detectable via the audit-chain head anchor
 * (GET /api/audit/head) filed outside the system.
 *
 * The registry: each domain keeps its own statements in src/db/protections/<domain>.ts and is listed here, in install order
 * (shared functions first). To protect a new table: add its triggers to the file of the domain that owns the table; a brand
 * new domain adds a file and one line to the list below.
 */
export const protectionSets: ProtectionSet[] = [blockMutation, auditProtections, signatureProtections, opsProtections, equipmentProtections, masterProtections, methodsProtections, qmsProtections, rawdataProtections, reportsProtections, oosProtections, documentsProtections, custodyProtections, reagentsProtections, emProtections, instrumentDataProtections];

/** All statements, flattened in install order (src/server/backup.ts re-applies them after a restore). */
export const protectionStatements: string[] = protectionSets.flatMap(s => s.statements);

/** Runs every statement on the given connection (inside the caller's transaction, if it has one). */
export async function applyProtections(conn: { query(text: string): Promise<unknown> }) {
  for (const st of protectionStatements) await conn.query(st);
}

/** Applies the protections to the application's own database. Imports ./index lazily: it reads SQL_* from the environment once. */
export async function ensureProtections() {
  const { createPool } = await import('./index');
  await applyProtections(createPool());
}
