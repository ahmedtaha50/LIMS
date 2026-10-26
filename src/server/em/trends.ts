/**
 * Adverse-trend evaluation (roadmap M32, r2-em). Run by the scheduler (src/server/schedules/em.ts, job em.trends) and on demand by QA
 * (POST /em/trends/evaluate). Each finding is one em_trend_flags row with its audit entry; dedupe_key makes a finding that was already
 * flagged a no-op, so the evaluation can run any number of times. The rules and their windows are in ./constants.ts (TREND_RULES).
 *
 *   CONSECUTIVE_ALERTS   per point and method, in sampling order: a run of 3 results at Alert or above. A longer run is the same
 *                        finding (keyed by the first result of the run); a Pass ends the run.
 *   REPEATED_ACTIONS     per point: two action-level results whose sampling days are at most 30 days apart (keyed by the pair).
 *   RECURRING_ORGANISM   per room: an organism identified again within 90 days of its previous identification there (case and
 *                        spacing do not make another organism; keyed by the pair).
 */
import { randomBytes } from 'crypto';
import { asc, gte } from 'drizzle-orm';
import { emResults, emTrendFlags } from '../../db/schema/em';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { withTransaction } from '../core/tx';
import { utcToday } from '../../lib/validations/instruments';
import { TREND_LOOKBACK_DAYS, TREND_RULES, type TrendRule } from './constants';

interface Row { id: string; pointId: string; room: string; method: string; sampledOn: string; status: string; organism: string | null }
export interface TrendFinding { rule: TrendRule; dedupeKey: string; pointId: string; room: string; organism: string | null; resultIds: string[]; detail: string }

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const organismKey = (o: string) => o.trim().replace(/\s+/g, ' ').toLowerCase();

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const list = m.get(k); if (list) list.push(r); else m.set(k, [r]); }
  return m;
}

/** The findings in `rows` (already in sampling order: sampled_on, recorded_at, id). Pure: the fixture tests call it directly. */
export function findTrends(rows: Row[]): TrendFinding[] {
  const out: TrendFinding[] = [];
  const { run } = TREND_RULES.CONSECUTIVE_ALERTS;
  for (const list of groupBy(rows, r => `${r.pointId}\u0000${r.method}`).values()) {
    let streak: Row[] = [];
    for (const r of list) {
      streak = r.status === 'Alert' || r.status === 'Action' ? [...streak, r] : [];
      if (streak.length === run) {
        out.push({
          rule: 'CONSECUTIVE_ALERTS', dedupeKey: `CONSECUTIVE_ALERTS:${streak[0].id}`, pointId: r.pointId, room: r.room, organism: null,
          resultIds: streak.map(s => s.id),
          detail: `${run} consecutive results at Alert level or above at this point (${r.method}): ${streak.map(s => `${s.id} ${s.status} ${s.sampledOn}`).join(', ')}.`,
        });
      }
    }
  }

  const { days: actionDays } = TREND_RULES.REPEATED_ACTIONS;
  for (const list of groupBy(rows.filter(r => r.status === 'Action'), r => r.pointId).values()) {
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (days(a.sampledOn, b.sampledOn) <= actionDays) {
        out.push({
          rule: 'REPEATED_ACTIONS', dedupeKey: `REPEATED_ACTIONS:${a.id}:${b.id}`, pointId: b.pointId, room: b.room, organism: null, resultIds: [a.id, b.id],
          detail: `2 action-level results at this point within ${actionDays} days: ${a.id} (${a.sampledOn}, ${a.method}) and ${b.id} (${b.sampledOn}, ${b.method}).`,
        });
      }
    }
  }

  const { days: organismDays } = TREND_RULES.RECURRING_ORGANISM;
  for (const list of groupBy(rows.filter(r => r.organism), r => r.room).values()) {
    const last = new Map<string, Row>();
    for (const r of list) {
      const k = organismKey(r.organism!);
      const prev = last.get(k);
      if (prev && days(prev.sampledOn, r.sampledOn) <= organismDays) {
        out.push({
          rule: 'RECURRING_ORGANISM', dedupeKey: `RECURRING_ORGANISM:${prev.id}:${r.id}`, pointId: r.pointId, room: r.room, organism: r.organism!.trim(), resultIds: [prev.id, r.id],
          detail: `${r.organism!.trim()} identified again in room ${r.room} within ${organismDays} days: ${prev.id} (${prev.sampledOn}) and ${r.id} (${r.sampledOn}).`,
        });
      }
      last.set(k, r);
    }
  }
  return out;
}

/** Reads the results of the look-back window, flags every finding not flagged before, and returns the new flags. */
export async function evaluateTrends(db: Db, opts: { actorId: string; now?: Date }): Promise<{ evaluated: number; flagged: Array<{ id: string; rule: TrendRule; pointId: string }> }> {
  const now = opts.now ?? new Date();
  const since = utcToday(new Date(now.getTime() - TREND_LOOKBACK_DAYS * DAY));
  const rows = await db.select({
    id: emResults.id, pointId: emResults.pointId, room: emResults.room, method: emResults.method, sampledOn: emResults.sampledOn,
    status: emResults.status, organism: emResults.organism,
  }).from(emResults).where(gte(emResults.sampledOn, since)).orderBy(asc(emResults.sampledOn), asc(emResults.recordedAt), asc(emResults.id));

  const flagged: Array<{ id: string; rule: TrendRule; pointId: string }> = [];
  for (const f of findTrends(rows)) {
    const id = await withTransaction(db, async (tx) => {
      const row = {
        id: `EMT-${randomBytes(5).toString('hex')}`, rule: f.rule, dedupeKey: f.dedupeKey, pointId: f.pointId, room: f.room, organism: f.organism,
        resultIds: f.resultIds, detail: f.detail, status: 'Open', detectedBy: opts.actorId,
      };
      const [ins] = await tx.insert(emTrendFlags).values(row).onConflictDoNothing({ target: emTrendFlags.dedupeKey }).returning({ id: emTrendFlags.id });
      if (!ins) return null;
      await writeAudit(tx, opts.actorId, 'Create', 'EmTrendFlag', ins.id, 'all', '', JSON.stringify(row), `Adverse trend detected (${TREND_RULES[f.rule].label}): ${f.detail}`);
      return ins.id;
    });
    if (id) flagged.push({ id, rule: f.rule, pointId: f.pointId });
  }
  return { evaluated: rows.length, flagged };
}
