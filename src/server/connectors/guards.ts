// Transition guard `unaccepted-imports` (roadmap M21): a sample cannot be submitted for review while captured instrument values that
// name it are still waiting for an analyst to accept or reject them. Otherwise a value the instrument measured could be silently
// left out of the results a reviewer sees. Listed under 'Pending Review' in src/server/workflow/guards/index.ts by the wave gate.
import { and, asc, eq } from 'drizzle-orm';
import { instrumentFiles, instrumentImportRows } from '../../db/schema';
import type { TransitionGuard } from '../workflow/guards/types';

export const unacceptedImports: TransitionGuard = {
  name: 'unaccepted-imports',
  async check(ex, sample) {
    const pending = await ex.select({ id: instrumentImportRows.id, parameter: instrumentImportRows.parameter, fileName: instrumentFiles.fileName })
      .from(instrumentImportRows).innerJoin(instrumentFiles, eq(instrumentFiles.id, instrumentImportRows.fileId))
      .where(and(eq(instrumentImportRows.sampleRef, sample.id), eq(instrumentImportRows.state, 'Pending')))
      .orderBy(asc(instrumentImportRows.id)).limit(6);
    if (pending.length === 0) return null;
    const shown = pending.slice(0, 5).map(p => `${p.parameter} (${p.fileName})`).join(', ');
    return `Sample ${sample.id} has captured instrument values that no analyst has accepted or rejected yet: ${shown}${pending.length > 5 ? ' and more' : ''}. Accept or reject them in Imports first.`;
  },
};
