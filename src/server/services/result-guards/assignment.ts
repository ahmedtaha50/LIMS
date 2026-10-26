/**
 * Result guard NOT_ASSIGNED (roadmap M33). Owned by r2-worklists; registered in ./index.ts (RESULT_GUARDS).
 *
 * While a result is an Active Sample item of a Released worklist, only the analyst assigned to it enters its value: anyone else is
 * refused with 403 NOT_ASSIGNED naming the worklist and the assignee, and nothing is written. Reassigning is a change of the worklist
 * (a reason, audited), not a way round this rule. A result on no Released worklist is open to every analyst as before; a Draft, Completed
 * or Cancelled worklist assigns nothing. The 'Instrument' service account of an API client is not a person on the bench: the values it
 * delivers (POST /v1/results:batch) are not held back by the assignment; the assignee reviews them.
 */
import { sql } from 'drizzle-orm';
import { AppError } from '../../http/errors';
import type { ResultGuard } from './index';

export const assignedAnalyst: ResultGuard = {
  name: 'assignment',
  async check(ex, input) {
    const res = await ex.execute(sql`
      SELECT i.assignee_id AS "assigneeId", u.name AS "assigneeName", w.id AS "worklistId"
        FROM worklist_items i
        JOIN worklists w ON w.id = i.worklist_id AND w.status = 'Released'
        LEFT JOIN users u ON u.id = i.assignee_id
       WHERE i.result_id = ${input.resultId} AND i.status = 'Active'
       ORDER BY w.id`);
    const rows = (res as any).rows as Array<{ assigneeId: string | null; assigneeName: string | null; worklistId: string }>;
    if (rows.length === 0) return null;
    if (input.userId) {
      if (rows.some(r => r.assigneeId === input.userId)) return null;
      const who = await ex.execute(sql`SELECT role FROM users WHERE id = ${input.userId}`);
      if (((who as any).rows[0]?.role) === 'Instrument') return null;
    }
    const r = rows[0];
    throw new AppError(403, 'NOT_ASSIGNED',
      `NOT_ASSIGNED: this result is assigned to ${r.assigneeName ?? r.assigneeId} on worklist ${r.worklistId}. Only the assignee enters it; ask for the assignment to be changed on the worklist (with a reason).`,
      { worklistId: r.worklistId, assigneeId: r.assigneeId });
  },
};
