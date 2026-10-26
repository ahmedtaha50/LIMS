/**
 * Characterization test for the api.ts split (roadmap M01).
 * tests/route-table.json was recorded from the pre-split code. After the split the live route table must be identical,
 * except that the dead duplicate registration of POST /audit/verify (the unguarded handler shadowed the Admin/QA one)
 * is gone. Any later change to the API surface must update the JSON in the same commit.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { extractRouteTable, routesWithUnwrappedHandlers, sortRouteTable } from '../../helpers/routeTable';

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'route-table.json'), 'utf8')).routes;

async function liveApp() {
  const { createApp } = await import('../../../src/server/app');
  const { db } = await import('../../../src/db/index');
  return createApp({ db, rateLimit: false });
}
const liveTable = async () => extractRouteTable(await liveApp());

describe('API route table', () => {
  it('matches tests/route-table.json exactly', async () => {
    expect(sortRouteTable(await liveTable())).toEqual(expected);
  });

  it('registers each method and path once (a duplicate silently shadows the later handler)', async () => {
    const keys = (await liveTable()).map(r => `${r.method} ${r.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('exposes only the three authentication routes and the two health probes without requireAuth', async () => {
    const open = (await liveTable()).filter(r => !r.auth).map(r => `${r.method} ${r.path}`).sort();
    expect(open).toEqual(['GET /api/health', 'GET /api/ready', 'POST /api/auth/login-local', 'POST /api/auth/totp-setup', 'POST /api/auth/totp-verify']);
  });

  it('wraps every route handler in asyncHandler (a bare express.Router lets a rejected promise kill the process)', async () => {
    const { isAsyncWrapped } = await import('../../../src/server/core/asyncHandler');
    expect(routesWithUnwrappedHandlers(await liveApp(), isAsyncWrapped)).toEqual([]);
  });
});
