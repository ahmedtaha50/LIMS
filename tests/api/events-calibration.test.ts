/**
 * Roadmap M23 (r2-events): the scheduled scan calibration.due announces an instrument once per due date when it comes within
 * 30 days, once more when it is overdue, never for a Retired instrument and never twice for the same state; the event reaches the
 * holders of instrument.view as a persistent notification.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let handler: typeof import('../../src/server/jobs/handlers/events').calibrationDueHandler;
let ev: typeof import('../../src/server/events');
let dbMod: typeof import('../../src/db/index');
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startTestApp();
  handler = (await import('../../src/server/jobs/handlers/events')).calibrationDueHandler;
  ev = await import('../../src/server/events');
  dbMod = await import('../../src/db/index');
});

const run = () => handler({}, { db: dbMod.db, job: { createdBy: 'usr-admin' } as any, workerId: 'test', signal: new AbortController().signal });
const instrument = async (due: string, status = 'Active') => {
  const id = uniq('INS');
  await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, $2, 'HPLC', $3, $4, $5)`,
    [id, `Balance ${id}`, status, due, day(-300)]);
  return id;
};
const eventsOf = (id: string) => sql(`SELECT payload, actor_id, audience FROM outbox_events WHERE type = 'instrument.calibration_due' AND entity_id = $1 ORDER BY created_at`, [id]);

describe('the calibration.due job', () => {
  it('announces due-soon and overdue instruments once, not the far or retired ones', async () => {
    const soon = await instrument(day(10));
    const late = await instrument(day(-2));
    const far = await instrument(day(90));
    const retired = await instrument(day(-5), 'Retired');
    await run();
    await run(); // a second run announces nothing new

    expect(await eventsOf(soon)).toEqual([{ payload: { instrumentId: soon, name: `Balance ${soon}`, dueDate: day(10), overdue: false }, actor_id: 'usr-admin', audience: 'instrument.view' }]);
    expect((await eventsOf(late)).map((e: any) => e.payload.overdue)).toEqual([true]);
    expect(await eventsOf(far)).toEqual([]);
    expect(await eventsOf(retired)).toEqual([]);

    // the due date passes: announced once more, as overdue; a recalibration (new due date) is a new announcement in its turn
    await sql(`UPDATE instruments SET calibration_due_date = $2 WHERE id = $1`, [soon, day(-1)]);
    await run();
    await sql(`UPDATE instruments SET calibration_due_date = $2 WHERE id = $1`, [soon, day(20)]);
    await run(); await run();
    expect((await eventsOf(soon)).map((e: any) => [e.payload.dueDate, e.payload.overdue])).toEqual([[day(10), false], [day(-1), true], [day(20), false]]);
  });

  it('reaches only the holders of instrument.view, as a notification that links to the instruments screen', async () => {
    // In the default matrix every role holds instrument.view: take it from Analyst here, so the audience is visible.
    await sql(`DELETE FROM role_permissions WHERE permission_code = 'instrument.view' AND role_id = (SELECT id FROM roles WHERE name = 'Analyst')`);
    const id = await instrument(day(3));
    await run();
    await ev.dispatchOnce(dbMod.db, {});
    const rows = await sql(`SELECT n.user_id, n.title, n.href FROM notifications n JOIN outbox_events e ON e.id = n.event_id WHERE e.entity_id = $1 ORDER BY n.user_id`, [id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ title: 'Calibration due', href: '#/instruments' });
    const holders = await sql(`SELECT DISTINCT u.id FROM users u JOIN roles r ON r.name = u.role AND r.active JOIN role_permissions rp ON rp.role_id = r.id
      WHERE u.active AND rp.permission_code = 'instrument.view' ORDER BY u.id`);
    expect(rows.map((r: any) => r.user_id)).toEqual(holders.map((h: any) => h.id));
    expect(rows.map((r: any) => r.user_id)).toEqual(['usr-admin', 'usr-qa', 'usr-reviewer']);
  });
});
