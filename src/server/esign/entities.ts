/**
 * The record types signRecord can sign today, and what a signature on each covers (hash version 2).
 *
 * Records that are edited in a draft state and then frozen (Sample, OOS, Specification, LabNotebook, BatchRelease) sign their
 * content; the lifecycle value (state, status) is the one the signed action set, taken from the audit entry, so a later and
 * legitimate move of the record (a specification made Obsolete, a sample revoked) does not break the earlier signature.
 * Records that are a series of events (Instrument calibration, Reagent receipt, User training and administration) sign the event:
 * the audit entry's action, field and values, which the audit chain protects. A signature on an event is only as strong as that
 * chain, and verification reports a broken chain.
 *
 * What is NOT in a content: the version counters (the signature carries record_version), signature bookkeeping columns written by
 * the signing step itself (signed_at, signed_by, content_hash of the notebook), and anything that changes after the signature.
 */
import { eq } from 'drizzle-orm';
import type { PgTable, AnyPgColumn } from 'drizzle-orm/pg-core';
import { batchReleases, instruments, labNotebook, oosInvestigations, reagents, samples, specifications, users } from '../../db/schema';
import type { Executor } from '../core/tx';
import { asSigned, registerSignable, type SignedChange } from './registry';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

registerSignable({
  type: 'Sample',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(samples).where(eq(samples.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, material: row.material, batch: row.batch, createdBy: row.createdBy, state: asSigned(change, ['state'], row.state) };
  },
});

registerSignable({
  type: 'OOS',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(oosInvestigations).where(eq(oosInvestigations.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, sampleId: row.sampleId, resultId: row.resultId, parameter: row.parameter, dateRaised: row.dateRaised, assignedTo: row.assignedTo,
      rootCause: row.rootCause, conclusion: row.conclusion, status: asSigned(change, ['status'], row.status),
    };
  },
});

registerSignable({
  type: 'Specification',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(specifications).where(eq(specifications.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, material: row.material, effectiveDate: row.effectiveDate, parameters: row.parameters, status: asSigned(change, ['status'], row.status) };
  },
});

registerSignable({
  type: 'LabNotebook',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(labNotebook).where(eq(labNotebook.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, title: row.title, sampleId: row.sampleId, content: row.content, experimentType: row.experimentType, pharmacopeia: row.pharmacopeia,
      enteredBy: row.enteredBy, status: asSigned(change, ['status'], row.status),
    };
  },
});

// A batch release is addressed by its batch (the audit entries of releases always were): the entity id is the batch name.
registerSignable({
  type: 'BatchRelease',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(batchReleases).where(eq(batchReleases.batch, id)).limit(1);
    if (!row) return null;
    return {
      batch: row.batch, status: asSigned(change, ['status'], row.status), dispositionRecommendation: row.dispositionRecommendation,
      releasedBy: row.releasedBy, releasedAt: iso(row.releasedAt),
    };
  },
});

/** A record type whose signature binds one event on a row that keeps changing. */
function eventEntity(type: string, table: PgTable & { id: AnyPgColumn }) {
  registerSignable({
    type,
    async canonical(ex: Executor, { id, change }) {
      if (!change) return null;
      const rows = await ex.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
      if (rows.length === 0) return null;
      return { id, event: eventOf(change) };
    },
  });
}
const eventOf = (c: SignedChange) => ({ action: c.action, field: c.field, oldValue: c.oldValue, newValue: c.newValue });

eventEntity('Instrument', instruments);
eventEntity('Reagent', reagents);
eventEntity('User', users);
