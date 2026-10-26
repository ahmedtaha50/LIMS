/**
 * Roadmap M35 (r2-audit-tamper), acceptance 3 (second half): a clock set back writes CLOCK_ANOMALY, and signing is blocked until an
 * Administrator acknowledges it with an e-signature (CLOCK_ANOMALY_ACK). The acknowledgement itself is the one signature allowed
 * while the anomaly is open: the bypass for the entity that lifts the requirement (AGENTS.md, the SignatureModal rule).
 *
 * The guard keeps a watermark: the latest time it has seen (initially the newest audit entry). A check whose clock reads more than
 * the tolerance (60 s) before the watermark is an anomaly; the watermark never moves back by itself.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD } from '../helpers/db';
import { useTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let db: any;
let clock: typeof import('../../src/server/audit/clockGuard');
const q = async (text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows;
const MIN = 60_000;

beforeAll(async () => {
  t = await useTestDb();
  db = (await import('../../src/db/index')).db;
  clock = await import('../../src/server/audit/clockGuard');
  const { writeAudit } = await import('../../src/db/utils');
  await db.transaction((tx: any) => writeAudit(tx, 'usr-qa', 'Update', 'Sample', 'S-clock', 'state', 'a', 'b', 'clock test baseline'));
});

const status = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return `${e.status} ${e.code}`; } };

describe('the clock guard', () => {
  it('a clock within the tolerance of the newest audit entry is fine', async () => {
    const r = await clock.checkClock(db, { now: new Date(Date.now() - 30_000), source: 'test' });
    expect(r.ok).toBe(true);
    expect(await q('SELECT count(*)::int AS n FROM clock_anomalies')).toEqual([{ n: 0 }]);
  });

  it('acceptance: a clock set back 10 minutes writes CLOCK_ANOMALY and records an open anomaly', async () => {
    const r = await clock.checkClock(db, { now: new Date(Date.now() - 10 * MIN), source: 'test' });
    expect(r.ok).toBe(false);
    expect(r.behindMs).toBeGreaterThan(9 * MIN);
    const rows = await q('SELECT source, behind_ms, acknowledged_at FROM clock_anomalies');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'test', acknowledged_at: null });
    expect(Number(rows[0].behind_ms)).toBeGreaterThan(9 * MIN);
    const [ev] = await q(`SELECT outcome, detail FROM security_events WHERE event_type = 'CLOCK_ANOMALY'`);
    expect(ev.outcome).toBe('failure');
    expect(JSON.parse(ev.detail)).toMatchObject({ source: 'test', anomalyId: expect.any(String) });
  });

  it('a second check while it is open adds no second anomaly, and the watermark does not move back', async () => {
    const [before] = await q('SELECT last_seen_at FROM clock_state');
    const r = await clock.checkClock(db, { now: new Date(Date.now() - 20 * MIN), source: 'test' });
    expect(r.ok).toBe(false);
    expect(await q('SELECT count(*)::int AS n FROM clock_anomalies')).toEqual([{ n: 1 }]);
    expect((await q('SELECT last_seen_at FROM clock_state'))[0].last_seen_at.getTime()).toBe(before.last_seen_at.getTime());
  });

  it('blocks every signature except the acknowledgement while the anomaly is open', async () => {
    expect(await status(clock.assertClockTrusted(db, 'BATCH_RELEASE'))).toBe('423 CLOCK_ANOMALY');
    expect(await status(clock.assertClockTrusted(db, 'AUDIT_REVIEW'))).toBe('423 CLOCK_ANOMALY');
    expect(await status(clock.assertClockTrusted(db, 'CLOCK_ANOMALY_ACK'))).toBe('ok');
    expect(await status(clock.guardSigningClock(db, 'APPROVAL'))).toBe('423 CLOCK_ANOMALY');
  });

  it('only an Administrator acknowledges, with a reason and the current version', async () => {
    const [a] = await q('SELECT id, version FROM clock_anomalies');
    const ack = (userId: string, body: Record<string, unknown>) =>
      clock.acknowledgeClockAnomaly(db, { id: userId }, a.id, { password: TEST_PASSWORD, reason: 'Clock corrected against the NTP server, no records affected', expectedVersion: a.version, ...body });
    expect(await status(ack('usr-qa', {}))).toBe('403 ROLE_NOT_ALLOWED');
    expect(await status(ack('usr-admin', { reason: '' }))).toBe('400 REASON_REQUIRED');
    expect(await status(ack('usr-admin', { expectedVersion: a.version + 5 }))).toBe('409 CONFLICT');
    const done: any = await ack('usr-admin', {});
    expect(done.anomaly).toMatchObject({ id: a.id, acknowledgedBy: 'usr-admin', version: a.version + 1 });
    const [sig] = await q(`SELECT meaning_code, signer_id, record_version FROM signatures WHERE entity_type = 'ClockAnomaly' AND entity_id = $1`, [a.id]);
    expect(sig).toEqual({ meaning_code: 'CLOCK_ANOMALY_ACK', signer_id: 'usr-admin', record_version: a.version + 1 });
    expect(await q(`SELECT action, field, new_value FROM audit_trail WHERE entity = 'ClockAnomaly' AND entity_id = $1`, [a.id])).toEqual([{ action: 'Acknowledge', field: 'acknowledged', new_value: 'true' }]);
    expect(await status(ack('usr-admin', { expectedVersion: a.version + 1 }))).toBe('409 ALREADY_ACKNOWLEDGED');
  });

  it('after the acknowledgement the current clock is the new baseline and signing is allowed again', async () => {
    expect(await status(clock.assertClockTrusted(db, 'BATCH_RELEASE'))).toBe('ok');
    expect((await clock.checkClock(db, { source: 'test' })).ok).toBe(true);
    expect(await status(clock.guardSigningClock(db, 'APPROVAL'))).toBe('ok');
  });

  it('a clock that jumps forward is not an anomaly; the watermark follows it', async () => {
    const ahead = new Date(Date.now() + 30 * MIN);
    expect((await clock.checkClock(db, { now: ahead, source: 'test' })).ok).toBe(true);
    expect((await q('SELECT last_seen_at FROM clock_state'))[0].last_seen_at.getTime()).toBe(ahead.getTime());
    // ... so the return to the real time afterwards IS a set-back, and is reported.
    expect((await clock.checkClock(db, { source: 'test' })).ok).toBe(false);
    expect(await q('SELECT count(*)::int AS n FROM clock_anomalies WHERE acknowledged_at IS NULL')).toEqual([{ n: 1 }]);
  });
});
