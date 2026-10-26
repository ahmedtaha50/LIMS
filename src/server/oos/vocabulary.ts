/**
 * The OOS vocabulary check (roadmap M26). Fail closed: an investigation whose status, phase or decision is not a word of the vocabulary
 * (src/lib/constants/oos.ts, src/lib/validations/oos.ts) blocks the approval of its sample and the release of its batch, whatever it
 * says, because nobody can tell what it means. Shared by the sample guard (src/server/workflow/guards/oos.ts) and the release blocker
 * (src/server/release-blockers/oos.ts).
 *
 * A closure with no decision is accepted: closures signed before 0210 (and v0.1.0's 'Approved') had none, and every closure since is
 * refused without one (closeOosSchema).
 */
import { inArray } from 'drizzle-orm';
import { oosInvestigations } from '../../db/schema/oos';
import { LEGACY_CLOSED_STATUS, OOS_PHASES, OOS_STATUS } from '../../lib/constants/oos';
import { OOS_CLOSURE_DECISIONS } from '../../lib/validations/oos';
import type { Executor } from '../core/tx';

const STATUSES: readonly string[] = [OOS_STATUS.OPEN, OOS_STATUS.CLOSED, LEGACY_CLOSED_STATUS];
const PHASES: readonly string[] = OOS_PHASES;
const DECISIONS: readonly string[] = OOS_CLOSURE_DECISIONS;

export async function findOosVocabularyProblems(ex: Executor, sampleIds: readonly string[]): Promise<string[]> {
  if (sampleIds.length === 0) return [];
  const rows = await ex.select({ id: oosInvestigations.id, sampleId: oosInvestigations.sampleId, status: oosInvestigations.status, phase: oosInvestigations.phase, decision: oosInvestigations.decision })
    .from(oosInvestigations).where(inArray(oosInvestigations.sampleId, [...sampleIds])).orderBy(oosInvestigations.id);
  const problems: string[] = [];
  for (const o of rows) {
    if (!STATUSES.includes(o.status)) problems.push(`OOS investigation ${o.id} (sample ${o.sampleId}) has the status "${o.status}", which is not an OOS status (${STATUSES.join(', ')}).`);
    else if (o.status === OOS_STATUS.OPEN && o.phase !== null && !PHASES.includes(o.phase)) problems.push(`OOS investigation ${o.id} (sample ${o.sampleId}) is in the phase "${o.phase}", which is not an OOS phase (${PHASES.join(', ')}).`);
    if (o.decision !== null && !DECISIONS.includes(o.decision)) problems.push(`OOS investigation ${o.id} (sample ${o.sampleId}) has the decision "${o.decision}", which is not an OOS decision (${DECISIONS.join(', ')}).`);
  }
  return problems;
}
