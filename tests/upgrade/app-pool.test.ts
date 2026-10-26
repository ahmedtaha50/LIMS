/**
 * Roadmap M40: the request path of the application connects as the unprivileged lims_app (SQL_APP_USER), while the owner
 * connection (SQL_USER) stays available for backup, restore and the installer. SQL_PORT is honoured (the built-in PostgreSQL does
 * not run on 5432). A child process per case, because src/db/index.ts creates its pools when it is first loaded.
 */
import { describe, expect, it } from 'vitest';
import { runInitDb, runTs, scratchDb, ROOT } from './helpers';
import path from 'path';
import fs from 'fs';

const probe = (env: Record<string, string>) => {
  const f = path.join(fs.mkdtempSync(path.join(ROOT, 'tests', 'upgrade', '.probe-')), 'probe.ts');
  fs.writeFileSync(f, `
    import { db } from '${path.join(ROOT, 'src/db/index').replace(/\\/g, '/')}';
    import { sql } from 'drizzle-orm';
    (async () => {
      const who = (await db.execute(sql\`select current_user as u, current_setting('TimeZone') as tz\`)).rows[0] as any;
      const owner = ((db as any).$client as import('pg').Pool);
      const o = (await owner.query('select current_user as u')).rows[0];
      let ddl = 'allowed';
      try { await db.execute(sql\`create table should_not_exist(a int)\`); } catch (e: any) { ddl = e.cause?.code ?? e.code; }
      console.log(JSON.stringify({ request: who.u, tz: who.tz, owner: o.u, ddl }));
      process.exit(0);
    })().catch(e => { console.error(e.message, e.cause?.message); process.exit(1); });`);
  const r = runTs(f, [], env);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  return r;
};

describe('application pool and owner pool', () => {
  it('requests run as lims_app, the owner connection stays for backup and restore, DDL by the request role is refused', async () => {
    const s = await scratchDb('apppool');
    const init = runInitDb(s, { LIMS_APP_DB_PASSWORD: 'app-password-for-test-1234', LIMS_APP_ROLE: 'required' });
    expect(init.status, init.stdout + init.stderr).toBe(0);
    const r = probe({ ...s.env, SQL_APP_USER: 'lims_app', SQL_APP_PASSWORD: 'app-password-for-test-1234' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out).toEqual({ request: 'lims_app', tz: 'UTC', owner: s.env.SQL_USER, ddl: '42501' });
  });

  it('without SQL_APP_USER nothing changes: one identity', async () => {
    const s = await scratchDb('apppool-off');
    const r = probe({ ...s.env });
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out.request).toBe(s.env.SQL_USER);
    expect(out.owner).toBe(s.env.SQL_USER);
  });

  it('SQL_PORT is used', async () => {
    const s = await scratchDb('apppool-port');
    const r = probe({ ...s.env, SQL_PORT: '1' });
    expect(r.status).not.toBe(0); // nothing listens on port 1: proves the setting reaches the pool
    expect(r.stderr + r.stdout).toMatch(/ECONNREFUSED|connect/i);
  });
});
