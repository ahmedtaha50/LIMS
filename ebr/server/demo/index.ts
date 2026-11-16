import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { HttpError } from '../core/errors.js';
import { passwordCheck } from '../identity/index.js';
import { hashPassword, passwordProblem } from '../identity/password.js';
import { reviewBuiltIn } from '../logbook/review.js';
import * as logbooks from '../logbook/service.js';
import * as materials from '../materials/service.js';
import * as mbr from '../mbr/service.js';
import { permissionsOf } from '../identity/roles.js';
import { writeAudit } from '../audit/index.js';

/**
 * E33: fills an EMPTY installation with demo data, to try a whole batch on a tablet. Everything goes through the services
 * the screens use, with real signatures of the demo accounts, so the audit trail and the signatures are the system's own:
 * QA reviews the built-in logbook types, an operator cleans and calibrates the equipment, QA releases the material lot,
 * the supervisor writes the recipe and QA approves it and makes it effective.
 * It refuses a database that holds anything beyond the first administrator: demo data never mixes with real records.
 */
export const DEMO_USERS = [
  { username: 'demo-operator', displayName: 'Demo operator', roles: ['operator'] },
  { username: 'demo-operator2', displayName: 'Demo second operator', roles: ['operator'] },
  { username: 'demo-supervisor', displayName: 'Demo supervisor', roles: ['supervisor'] },
  { username: 'demo-qa', displayName: 'Demo QA', roles: ['qa'] },
] as const;

const RECIPE = {
  batchSize: { value: 100, unit: 'kg' },
  yieldLimits: { minPct: 97, maxPct: 101 },
  phases: [
    { key: 'dispensing', label: 'Dispensing', steps: [
      { key: 'clearance', label: 'Line clearance', type: 'verified', text: 'The room and the scale are free of the previous product', critical: true },
      { key: 'api', label: 'Paracetamol powder', type: 'material', material: 'RM-PCM', quantity: 50, unit: 'kg', tolerancePct: 1 },
      { key: 'starch', label: 'Maize starch', type: 'material', material: 'RM-STA', quantity: 48, unit: 'kg', tolerancePct: 2 },
    ] },
    { key: 'granulation', label: 'Granulation', steps: [
      { key: 'mixer', label: 'Planetary mixer', type: 'equipment', objectKind: 'equipment', objectCode: 'MIX-01', purpose: 'Granulation' },
      { key: 'water', label: 'Purified water added', type: 'data', unit: 'L', min: 18, max: 22 },
      { key: 'ratio', label: 'Water per kg of powder', type: 'calculation', formula: 'water / 98', unit: 'L/kg', min: 0.18, max: 0.23 },
      { key: 'end', label: 'Granulation end point checked', type: 'signature', text: 'The granules hold together when pressed' },
    ] },
  ],
};

export type DemoResult = { accounts: string[]; logbooks: string[]; lots: string[]; recipe: string };

export async function fillDemo(pool: Pool, password: string): Promise<DemoResult> {
  for (const u of DEMO_USERS) { const p = passwordProblem(password, u.username); if (p) throw new HttpError(400, 'weak_password', `EBR_DEMO_PASSWORD: ${p}`); }
  const used = (await pool.query<{ n: number }>(`SELECT (SELECT count(*) FROM users)::int + (SELECT count(*) FROM logbooks)::int + (SELECT count(*) FROM mbr_masters)::int
    + (SELECT count(*) FROM materials)::int + (SELECT count(*) FROM batches)::int - 1 AS n`)).rows[0]!.n;
  if (used > 0) throw new HttpError(409, 'not_empty', 'This database already holds records (accounts beyond the first administrator, logbooks, recipes, materials or batches): demo data is only for an empty installation.');

  const hash = await hashPassword(password);
  const ids: Record<string, string> = {};
  await withTx(pool, async (c) => {
    for (const u of DEMO_USERS) {
      const r = await c.query<{ id: string }>("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id", [u.username, u.displayName, hash, u.roles]);
      ids[u.username] = r.rows[0]!.id;
      await writeAudit(c, { actorId: null, actorName: 'demo data', action: 'user.created', entity: 'user', entityId: r.rows[0]!.id, newValue: { username: u.username, roles: u.roles, demo: true }, reason: 'demo installation (npm run demo-data)' });
    }
  });
  const check = passwordCheck(pool);
  const as = <T>(username: string, fn: (x: logbooks.Ctx) => Promise<T>) => withTx(pool, (c) => {
    const roles = DEMO_USERS.find(u => u.username === username)!.roles;
    return fn({ c, pool, check, actor: { userId: ids[username]!, username, displayName: username, permissions: permissionsOf(roles) }, requestId: 'demo-data' });
  });

  // QA reviews the built-in logbook types (E28)
  const builtIns = (await pool.query<{ type_id: string; id: string }>('SELECT type_id, id FROM logbook_type_versions WHERE needs_qa_review')).rows;
  for (const v of builtIns) await as('demo-qa', x => reviewBuiltIn(x, v.type_id, v.id, { password, comment: 'demo installation: definition reviewed' }));

  // equipment and rooms, cleaned and calibrated by the operator
  const due = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const made: string[] = [];
  for (const [typeCode, objectKind, objectCode, name, location] of [
    ['equipment', 'equipment', 'MIX-01', 'Planetary mixer 150 L', 'Granulation room 1'],
    ['equipment', 'equipment', 'BAL-01', 'Floor scale 300 kg', 'Dispensing booth'],
    ['room', 'room', 'RM-101', 'Granulation room 1', 'Block A'],
  ] as const) {
    const lb = await as('demo-supervisor', x => logbooks.createLogbook(x, { typeCode, objectKind, objectCode, name, location, settings: { cleanHoldHours: 72 } }));
    await as('demo-operator', x => logbooks.writeEntry(x, lb.id, { kind: 'cleaning', values: { method: 'major', agent: 'Purified water and detergent D' }, password }));
    if (objectKind === 'equipment') await as('demo-operator', x => logbooks.writeEntry(x, lb.id, { kind: 'calibration', values: { certificate: `CAL-${objectCode}-DEMO`, result: 'pass', next_due: due }, password }));
    made.push(objectCode);
  }

  // materials, a lot each, released by QA
  const lots: string[] = [];
  for (const [code, name, lot] of [['RM-PCM', 'Paracetamol powder', 'PCM-2601'], ['RM-STA', 'Maize starch', 'STA-2601']] as const) {
    await as('demo-supervisor', x => materials.createMaterial(x, { code, name, unit: 'kg' }));
    const l = await as('demo-supervisor', x => materials.receiveLot(x, code, { lotNumber: lot, expiry: new Date(Date.now() + 2 * 365 * 86_400_000).toISOString().slice(0, 10) }));
    await as('demo-qa', x => materials.decideLot(x, (l as { id: string }).id, 'released', { version: (l as { version: number }).version, password }));
    lots.push(lot);
  }

  // the recipe: written by the supervisor, approved and made effective by QA (E09)
  const r = await as('demo-supervisor', x => mbr.create(x, { code: 'PCM-500', productName: 'Paracetamol 500 mg tablets (demo)', design: RECIPE }));
  const v1 = await as('demo-supervisor', x => mbr.submit(x, r.id, r.version.id, r.version.rowVersion, password));
  const v2 = await as('demo-qa', x => mbr.approve(x, r.id, r.version.id, v1.rowVersion, password, 'demo recipe'));
  await as('demo-qa', x => mbr.makeEffective(x, r.id, r.version.id, v2.rowVersion, password));
  return { accounts: DEMO_USERS.map(u => u.username), logbooks: made, lots, recipe: 'PCM-500' };
}
