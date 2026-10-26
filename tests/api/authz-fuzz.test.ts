/**
 * Roadmap M09 (r1-authz) acceptance: "posting an unknown key to every mutating route returns 400 (table-driven)".
 *
 * 23 of the 33 body-consuming routes had no strict schema, so a client could send `status`, `version`, `signatures` or any other
 * server-controlled field and have it ignored (or, in two handlers, used). The route table now lists the keys every mutating
 * route accepts, and rejects any other before the handler runs (AGENTS.md section 3).
 *
 * The routes are read from the live application, so a route added later is covered without touching this file.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { extractRouteTable } from '../helpers/routeTable';

const UNKNOWN = '__unexpected_key__';
let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });

/** A session of its own for every request: unknown-key calls to /auth/logout must not end the session of the next route. */
async function freshAdmin() {
  const login = await t.request.post('/api/auth/login-local').send({ email: 'admin@gxp.com', password: TEST_PASSWORD });
  return { Authorization: `Bearer ${login.body.token}` };
}
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'x-none');

describe('unknown keys', () => {
  it('every mutating route answers 400 and names the unknown key', async () => {
    const routes = extractRouteTable(t.app).filter(r => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
    expect(routes.length).toBeGreaterThan(50);

    const failures: string[] = [];
    for (const r of routes) {
      const headers = r.auth ? await freshAdmin() : {};
      const res = await (t.request as any)[r.method.toLowerCase()](concrete(r.path)).set(headers).send({ [UNKNOWN]: 'x' });
      if (res.status !== 400 || !JSON.stringify(res.body).includes(UNKNOWN)) {
        failures.push(`${r.method} ${r.path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('a body that is not an object is refused as well', async () => {
    const admin = await freshAdmin();
    const res = await t.request.post('/api/samples').set(admin).send([{ material: 'M', batch: 'B' }]);
    expect(res.status).toBe(400);
  });

  it('server-controlled fields do not slip in beside valid ones: status, id, signatures, createdBy, author', async () => {
    const admin = await freshAdmin();
    for (const key of ['status', 'id', 'signatures', 'createdBy', 'author']) {
      const res = await t.request.post('/api/specifications').set(admin).send({ material: 'Fuzz', version: 1, effectiveDate: '2026-01-01', [key]: 'Active' });
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(res.body), key).toContain(key);
    }
    expect((await t.db.pool.query(`SELECT count(*)::int AS n FROM specifications WHERE material = 'Fuzz'`)).rows[0].n).toBe(0);
  });
});

describe('the keys the screens send are still accepted', () => {
  // The exact payloads of the components (src/components/*.tsx). Anything but "Unrecognized key" is fine here: the records do not
  // exist or the password is wrong, and the handler says so. A 400 naming a key means the route table is narrower than the screen.
  const PAYLOADS: Array<[method: string, path: string, body: unknown]> = [
    ['POST', '/api/eln', { title: 'T', content: 'C', sampleId: '', experimentType: 'General', pharmacopeia: 'USP' }],
    ['PUT', '/api/eln/ELN-NONE', { title: 'T', content: 'C', sampleId: '', experimentType: 'General', pharmacopeia: 'USP', expectedVersion: 1 }],
    ['POST', '/api/eln/ELN-NONE/sign', { password: 'wrong', reason: 'r' }], // r1-quality-fixes: the screen no longer sends a meaning
    ['POST', '/api/notebook-templates', { title: 'T', content: 'C' }],
    ['POST', '/api/ai/eln-protocol', { title: 'T', experimentType: 'E', pharmacopeia: 'P', dosageForm: 'Tablet', sampleId: 'SMP-1', rawMaterial: 'R', instrument: 'I' }],
    ['POST', '/api/ai/capa-analysis', { sampleId: 'S', resultId: 'R', parameter: 'P', value: 'V', notes: 'N' }],
    ['POST', '/api/traceability/batch/B-UI/material', { materialName: 'M', materialType: 'API', lotNumber: 'L', manufacturer: 'X', coaNumber: 'C', coaStatus: 'Verified Pass', quantityDispensed: '1 kg', potencyAssay: '99 %', lossOnDrying: '0.2 %' }],
    ['POST', '/api/traceability/batch/B-UI/release', { password: 'wrong', reason: 'r', dispositionRecommendation: 'd' }],
    ['POST', '/api/stability', { protocolId: 'STP-NONE', batchId: 'B-NONE', startDate: '2026-01-01' }],
    ['PUT', '/api/stability/STB-NONE', { status: 'Aborted', reason: 'Stored at the wrong condition', expectedVersion: 1 }],
    ['POST', '/api/specifications', { material: 'UI material', effectiveDate: '2026-01-01' }],
    ['PUT', '/api/specifications/SPEC-NONE', { parameters: [], expectedVersion: 1 }],
    ['POST', '/api/specifications/SPEC-NONE/approve', { password: 'wrong' }],
    ['POST', '/api/env-records', { location: 'L', grade: 'D', date: '2026-01-01', viableCount: '1', nonViableCount: '1' }],
    ['PUT', '/api/env-records/ENV-NONE', { location: 'L', grade: 'D', viableCount: 1, nonViableCount: 1, expectedVersion: 1 }],
    ['POST', '/api/instruments', { name: 'N', type: 'T', calibrationDueDate: '2030-01-01' }],
    ['POST', '/api/instruments/INST-NONE/calibrate', { newDueDate: '2030-01-01', password: 'wrong' }],
    ['POST', '/api/oos', { sampleId: 'SMP-NONE', resultId: 'res-none', parameter: 'P', dateRaised: '2026-01-01' }],
    ['PUT', '/api/oos/OOS-NONE', { assignedTo: 'usr-qa', rootCause: 'r', conclusion: 'c', expectedVersion: 1 }],
    ['POST', '/api/oos/OOS-NONE/close', { rootCause: 'abcde', conclusion: 'abcde', password: 'wrong', expectedVersion: 1 }],
    ['POST', '/api/samples', { material: 'No such material', batch: 'B' }],
    ['POST', '/api/samples/bulk-import', { items: [] }],
    ['POST', '/api/samples/SMP-NONE/transition', { action: 'submit', expectedVersion: 1, password: 'p', reason: 'r' }],
    ['POST', '/api/samples/SMP-NONE/notebook', { content: 'c', password: 'p' }],
    ['PUT', '/api/samples/SMP-NONE/results/res-none', { value: '1', reason: 'entry', expectedVersion: 1, instrumentId: 'INST-NONE', attachmentName: 'a.txt', attachmentData: 'x' }],
    ['POST', '/api/reports/generate', { sampleId: 'SMP-NONE' }],
    ['POST', '/api/training/usr-none/certify', { password: 'p', moduleName: 'LIMS Core Software' }],
    ['POST', '/api/reagents', { name: 'N', lotNumber: 'L', expiryDate: '2030-01-01', quantity: '1' }],
    ['POST', '/api/audit/export', { reason: 'periodic review' }],
    ['POST', '/api/audit/verify', {}],
    ['POST', '/api/security-events/verify', {}],
    ['POST', '/api/auth/logout', {}],
  ];

  it.each(PAYLOADS)('%s %s', async (method, path, body) => {
    const headers = await freshAdmin(); // before the request object exists: see tests/helpers/app.ts
    const res = await (t.request as any)[method.toLowerCase()](path).set(headers).send(body);
    expect(String(res.body?.error ?? ''), `${res.status}`).not.toMatch(/Unrecognized key/i);
    expect(res.body?.code, JSON.stringify(res.body)).not.toBe('PERMISSION_DENIED'); // (a handler may still answer 403 to a wrong password)
  });
});
