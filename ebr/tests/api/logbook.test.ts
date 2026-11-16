import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf, verifyChain } from '../../server/audit/index.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { base32Encode, totp } from '../../server/identity/totp.js';
import { Definition } from '../../server/logbook/definition.js';
import { deriveStatus } from '../../server/logbook/status.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'logbook test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
type R = { status: number; body: any; headers: Headers };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: `ebr_session=${cookies[who]}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
async function account(username: string, roles: string[]) {
  const secret = base32Encode(Buffer.from(username.padEnd(20, 'x').slice(0, 20)));
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $2, $3, $4, false, $5, true)', [username, `${username} (name)`, await hashPassword(PW), roles, secret]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW, totp: totp(secret) }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
const TEMP_LOG = { entryKinds: [{ key: 'reading', label: 'Reading', fields: [
  { key: 'temperature', label: 'Temperature', type: 'number', required: true, unit: '°C', min: 2, max: 8, decimals: 1 },
  { key: 'checked_door', label: 'Door closed', type: 'boolean', required: true },
  { key: 'shift', label: 'Shift', type: 'choice', choices: ['morning', 'evening', 'night'] },
  { key: 'note', label: 'Note', type: 'text' }] }] };

beforeAll(async () => {
  db = await freshDatabase('logbook'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup1', ['supervisor']); await account('op1', ['operator']); await account('qa1', ['qa']);
});
afterAll(async () => { await close(); await db.drop(); });

describe('create any logbook type (E21)', () => {
  let typeId = '', v1 = '';
  it('E21#1: a supervisor creates a fridge temperature logbook type with its own fields', async () => {
    const r = await call('sup1', 'POST', '/api/logbook-types', { code: 'fridge-temp', name: 'Fridge temperature log', definition: TEMP_LOG });
    expect(r.status).toBe(201);
    expect(r.body.version).toMatchObject({ versionNo: 1, status: 'draft' });
    typeId = r.body.id; v1 = r.body.version.id;
  });
  it('a definition with a mistake is refused with the reason (min above max, duplicate keys, unknown field type)', async () => {
    const bad = { entryKinds: [{ key: 'r', label: 'R', fields: [{ key: 't', label: 'T', type: 'number', min: 9, max: 1 }, { key: 't', label: 'T2', type: 'text' }] }] };
    const r = await call('sup1', 'POST', '/api/logbook-types', { code: 'bad-one', name: 'Bad', definition: bad });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.details)).toMatch(/min is above max/);
    expect(JSON.stringify(r.body.details)).toMatch(/two fields of r are called t/);
    expect((await call('sup1', 'POST', '/api/logbook-types', { code: 'bad-two', name: 'Bad', definition: { entryKinds: [{ key: 'r', label: 'R', fields: [{ key: 'x', label: 'X', type: 'colour' }] }] } })).status).toBe(400);
  });
  it('an operator cannot design types; QA cannot design them either', async () => {
    expect((await call('op1', 'POST', '/api/logbook-types', { code: 'x-op', name: 'X', definition: TEMP_LOG })).status).toBe(403);
    expect((await call('qa1', 'POST', '/api/logbook-types', { code: 'x-qa', name: 'X', definition: TEMP_LOG })).status).toBe(403);
  });
  it('E21#2: a draft cannot be used; the author cannot approve; QA approves with a signature, then it is effective', async () => {
    expect((await call('sup1', 'POST', '/api/logbooks', { typeCode: 'fridge-temp', objectKind: 'equipment', objectCode: 'FRIDGE-01', name: 'Fridge 1' })).body.code).toBe('no_effective_type');
    const submitted = await call('sup1', 'POST', `/api/logbook-types/${typeId}/versions/${v1}/submit`, { rowVersion: 1, password: PW });
    expect(submitted.body.status).toBe('in_review');
    // the author has no approve permission; even a person with both could not approve their own (server-side two-person rule)
    expect((await call('sup1', 'POST', `/api/logbook-types/${typeId}/versions/${v1}/approve`, { rowVersion: 2, password: PW })).status).toBe(403);
    expect((await call('qa1', 'POST', `/api/logbook-types/${typeId}/versions/${v1}/approve`, { rowVersion: 2, password: 'wrong' })).status).toBe(401);
    const ok = await call('qa1', 'POST', `/api/logbook-types/${typeId}/versions/${v1}/approve`, { rowVersion: 2, password: PW, comment: 'reviewed against SOP-QC-014' });
    expect(ok.body).toMatchObject({ status: 'effective', approvedBy: 'qa1' });
    const sigs = (await call('qa1', 'GET', `/api/signatures?entity=logbook_type_version&entityId=${v1}`)).body;
    expect(sigs.map((s: { meaning: string }) => s.meaning)).toEqual(['authored', 'approved']);
  });
  it('E21#2: a person who may both design and approve still cannot approve their own version (two-person rule)', async () => {
    await account('both1', ['supervisor', 'qa']);
    const t = await call('both1', 'POST', '/api/logbook-types', { code: 'self-approve', name: 'Self', definition: TEMP_LOG });
    await call('both1', 'POST', `/api/logbook-types/${t.body.id}/versions/${t.body.version.id}/submit`, { rowVersion: 1, password: PW });
    const r = await call('both1', 'POST', `/api/logbook-types/${t.body.id}/versions/${t.body.version.id}/approve`, { rowVersion: 2, password: PW });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('same_person');
  });
  it('E21#3: a logbook of any object is created from the approved type, without a code change', async () => {
    const r = await call('sup1', 'POST', '/api/logbooks', { typeCode: 'fridge-temp', objectKind: 'instrument', objectCode: 'FRIDGE-01', name: 'Reagent fridge 1', location: 'QC lab' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ typeCode: 'fridge-temp', objectKind: 'instrument' });
  });
  it('E21#4: an entry is checked against its type: unknown fields refused, outside limits flagged and needs a comment', async () => {
    const lb = (await call('op1', 'GET', '/api/logbooks?objectKind=instrument')).body[0];
    const path = `/api/logbooks/${lb.id}/entries`;
    expect((await call('op1', 'POST', path, { kind: 'reading', values: { temperature: 5, checked_door: true, colour: 'blue' }, password: PW })).body.details).toContain('colour: not a field of Reading');
    expect((await call('op1', 'POST', path, { kind: 'reading', values: { temperature: 5 }, password: PW })).body.details).toContain('Door closed: required');
    expect((await call('op1', 'POST', path, { kind: 'reading', values: { temperature: '5', checked_door: true }, password: PW })).body.details).toContain('Temperature: a number');
    const noComment = await call('op1', 'POST', path, { kind: 'reading', values: { temperature: 9.4, checked_door: true }, password: PW });
    expect(noComment.body.details).toContain('A value is outside its limits: a comment is required.');
    const flagged = await call('op1', 'POST', path, { kind: 'reading', values: { temperature: 9.4, checked_door: true, shift: 'morning' }, comment: 'door was open during loading; QA informed', password: PW });
    expect(flagged.status).toBe(201);
    expect(flagged.body.flags[0].message).toMatch(/9.4 °C is outside 2 to 8 °C/);
    expect((await call('op1', 'POST', path, { kind: 'reading', values: { temperature: 4.1, checked_door: true }, password: PW })).body.flags).toEqual([]);
  });
  it('E21#2: a new version needs approval again, and entries keep the version they were written with', async () => {
    const d = await call('sup1', 'POST', `/api/logbook-types/${typeId}/versions`);
    expect(d.body).toMatchObject({ versionNo: 2, status: 'draft' });
    const def2 = structuredClone(TEMP_LOG); def2.entryKinds[0]!.fields[0] = { ...def2.entryKinds[0]!.fields[0]!, min: 2, max: 10 } as never;
    await call('sup1', 'PUT', `/api/logbook-types/${typeId}/versions/${d.body.id}`, { rowVersion: 1, definition: def2 });
    await call('sup1', 'POST', `/api/logbook-types/${typeId}/versions/${d.body.id}/submit`, { rowVersion: 2, password: PW });
    await call('qa1', 'POST', `/api/logbook-types/${typeId}/versions/${d.body.id}/approve`, { rowVersion: 3, password: PW });
    const lb = (await call('op1', 'GET', '/api/logbooks?objectKind=instrument')).body[0];
    const e = await call('op1', 'POST', `/api/logbooks/${lb.id}/entries`, { kind: 'reading', values: { temperature: 9.4, checked_door: true }, password: PW });
    expect(e.body).toMatchObject({ flags: [], typeVersion: 2 });
    const detail = (await call('op1', 'GET', `/api/logbooks/${lb.id}`)).body;
    expect(detail.entries.map((x: { typeVersion: number }) => x.typeVersion)).toEqual([1, 1, 2]);
    const types = (await call('op1', 'GET', '/api/logbook-types')).body;
    expect(types.find((t: { code: string }) => t.code === 'fridge-temp').versions.map((v: { status: string }) => v.status)).toEqual(['retired', 'effective']);
  });
});

describe('equipment and room logbooks (E06) and status (E07)', () => {
  let mixer = '';
  it('E06#1: equipment is created, changed with a reason and the version read, and retired (never deleted), all audited', async () => {
    const c = await call('sup1', 'POST', '/api/logbooks', { typeCode: 'equipment', objectKind: 'equipment', objectCode: 'MIX-101', name: 'Planetary mixer 101', location: 'Granulation 2', settings: { cleanHoldHours: 72 } });
    expect(c.status).toBe(201); mixer = c.body.id;
    expect((await call('sup1', 'PATCH', `/api/logbooks/${mixer}`, { version: 1, reason: 'moved', location: 'Granulation 3' })).body.location).toBe('Granulation 3');
    expect((await call('sup1', 'PATCH', `/api/logbooks/${mixer}`, { version: 1, reason: 'stale', location: 'X' })).status).toBe(409);
    const room = await call('sup1', 'POST', '/api/logbooks', { typeCode: 'room', objectKind: 'room', objectCode: 'RM-204', name: 'Compression room 204' });
    expect((await call('sup1', 'POST', `/api/logbooks/${room.body.id}/retire`, { version: 1, reason: 'room converted to storage', password: PW })).status).toBe(204);
    expect((await call('op1', 'POST', `/api/logbooks/${room.body.id}/entries`, { kind: 'cleaning', values: { method: 'daily' }, password: PW })).body.code).toBe('retired');
    expect((await call('op1', 'GET', `/api/logbooks/${room.body.id}`)).body.status).toBe('retired');
    expect((await call('op1', 'DELETE', `/api/logbooks/${room.body.id}`)).status).toBe(404);
    expect((await auditOf(db.pool, 'logbook', mixer)).map(e => e.action)).toEqual(['logbook.created', 'logbook.changed']);
  });
  it('E06#2: an entry is signed by its author and cannot be changed; a correction is a new entry with a reason', async () => {
    const w = await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'cleaning', values: { method: 'major', agent: 'Detergent D lot 22' }, password: PW });
    expect(w.status).toBe(201);
    expect((await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'cleaning', values: { method: 'major' }, password: 'not my password' })).status).toBe(401);
    await expect(db.pool.query("UPDATE logbook_entries SET \"values\" = '{}'")).rejects.toThrow(/never changed/);
    await expect(db.pool.query('DELETE FROM logbook_entries')).rejects.toThrow(/never changed/);
    expect((await call('op1', 'POST', `/api/logbooks/${mixer}/entries/${w.body.id}/correct`, { kind: 'cleaning', values: { method: 'minor' }, password: PW })).status).toBe(400);
    const fix = await call('op1', 'POST', `/api/logbooks/${mixer}/entries/${w.body.id}/correct`, { kind: 'cleaning', values: { method: 'minor', agent: 'Detergent D lot 22' }, reason: 'it was a minor cleaning, wrong choice', password: PW });
    expect(fix.status).toBe(201);
    expect((await call('op1', 'POST', `/api/logbooks/${mixer}/entries/${w.body.id}/correct`, { kind: 'cleaning', values: { method: 'major' }, reason: 'again', password: PW })).body.code).toBe('already_corrected');
    const sig = (await call('op1', 'GET', `/api/signatures?entity=logbook_entry&entityId=${w.body.id}`)).body;
    expect(sig).toMatchObject([{ meaning: 'performed', signerName: 'op1 (name)' }]);
  });
  it('E07#1: status is derived from the entries (and a corrected entry counts through its correction)', async () => {
    expect((await call('op1', 'GET', `/api/logbooks/${mixer}`)).body.derived.status).toBe('clean');
    await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'use_start', values: { product: 'Paracetamol 500 mg', batch: 'B-2026-001' }, password: PW });
    expect((await call('op1', 'GET', `/api/logbooks/${mixer}`)).body.derived.status).toBe('in_use');
    await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'use_end', values: { batch: 'B-2026-001' }, password: PW });
    expect((await call('op1', 'GET', `/api/logbooks/${mixer}`)).body.derived.status).toBe('dirty');
  });
  it('E07#2: clean hold time and calibration due date change the status without anyone acting', () => {
    const def = Definition.parse({ tracksStatus: true, entryKinds: [{ key: 'clean', label: 'C', fields: [], setsStatus: 'clean' }, { key: 'cal', label: 'Cal', fields: [{ key: 'due', label: 'Due', type: 'datetime', required: true }], setsCalibrationDue: 'due' }] });
    const t0 = new Date('2026-01-01T08:00:00Z');
    const entries = [{ kind: 'clean', values: {}, recorded_at: t0, corrected: false }];
    expect(deriveStatus(def, entries, { cleanHoldHours: 72 }, new Date('2026-01-03T08:00:00Z')).status).toBe('clean');
    expect(deriveStatus(def, entries, { cleanHoldHours: 72 }, new Date('2026-01-04T09:00:00Z'))).toMatchObject({ status: 'dirty', reasons: ['clean hold time of 72 h has passed'] });
    const cal = [...entries, { kind: 'cal', values: { due: '2026-01-02T00:00:00.000Z' }, recorded_at: t0, corrected: false }];
    expect(deriveStatus(def, cal, {}, new Date('2026-01-01T12:00:00Z')).status).toBe('clean');
    expect(deriveStatus(def, cal, {}, new Date('2026-01-02T12:00:00Z')).status).toBe('out_of_calibration');
  });
  it('E07#2 through the API: a calibration due date in the past shows the equipment out of calibration', async () => {
    await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'calibration', values: { certificate: 'CAL-778', result: 'pass', next_due: '2020-01-01T00:00:00Z' }, password: PW });
    expect((await call('op1', 'GET', `/api/logbooks/${mixer}`)).body.derived).toMatchObject({ status: 'out_of_calibration' });
  });
  it('E07#3: a status change by hand needs a reason and a signature', async () => {
    const noReason = await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'hold', values: {}, password: PW });
    expect(noReason.body.details).toContain('Reason: required');
    expect((await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'hold', values: { reason: 'noise in the gearbox' }, password: 'bad' })).status).toBe(401);
    expect((await call('op1', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'hold', values: { reason: 'noise in the gearbox' }, password: PW })).status).toBe(201);
  });
  it('E06#3: entries are listed in time order with signer and meaning, and export as a PDF with a hash', async () => {
    const d = (await call('op1', 'GET', `/api/logbooks/${mixer}`)).body;
    const ids = d.entries.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(d.entries[0]).toMatchObject({ meaning: 'performed', signedBy: 'op1 (name)', correctedBy: d.entries[1].id });
    expect(d.entries[1]).toMatchObject({ meaning: 'corrected', correctsEntryId: d.entries[0].id });
    const pdf = await call('op1', 'GET', `/api/logbooks/${mixer}/export`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('MIX-101');
    expect(text).toContain('CORRECTS #');
    expect(text).toContain('meaning corrected');
    expect(pdf.headers.get('x-export-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the built-in equipment and room types parse with the same schema as user types, and the audit chain still verifies', async () => {
    const defs = (await db.pool.query<{ definition: unknown }>("SELECT definition FROM logbook_type_versions v JOIN logbook_types t ON t.id = v.type_id WHERE t.built_in")).rows;
    expect(defs.length).toBe(2);
    for (const d of defs) expect(() => Definition.parse(d.definition)).not.toThrow();
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true });
  });
});
