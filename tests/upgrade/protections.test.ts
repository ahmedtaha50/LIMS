/**
 * The append-only trigger registry (src/db/protections.ts + src/db/protections/<domain>.ts) installs exactly what v0.1.0 installed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { applyProtections, protectionSets, protectionStatements } from '../../src/db/protections';
import { appendOnlyTable } from '../../src/db/protections/common';
import { bootDatabase } from '../../src/server/boot';
import { FIXTURES, scratchDb } from './helpers';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('protection registry', () => {
  it('contains every statement v0.1.0 installed (the registry only regroups them by domain; later tracks add statements for their own tables)', () => {
    const v010 = fs.readFileSync(path.join(FIXTURES, 'v0.1.0.protections.sql'), 'utf8')
      .split('\n').filter(l => !l.startsWith('--')).join('\n')
      .split(/;\s*\n\s*\n/).map(squash).filter(Boolean).map(s => s.replace(/;$/, ''));
    expect(v010).toHaveLength(10);
    expect(protectionStatements.map(squash)).toEqual(expect.arrayContaining(v010));
  });

  it('lists each domain once and installs shared functions before the triggers that use them', () => {
    const domains = protectionSets.map(s => s.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(protectionStatements.findIndex(s => s.includes('FUNCTION gxp_block_mutation'))).toBeLessThan(protectionStatements.findIndex(s => s.includes('CREATE TRIGGER')));
  });

  it('appendOnlyTable names the triggers the OQ checks count (gxp_<table>_row_guard / _truncate_guard)', () => {
    expect(appendOnlyTable('backup_runs').filter(s => s.startsWith('CREATE TRIGGER')).map(s => s.split(' ')[2])).toEqual(['gxp_backup_runs_row_guard', 'gxp_backup_runs_truncate_guard']);
  });

  it('is idempotent and, applied to a migrated database, leaves exactly the gxp triggers the registry declares, which refuse UPDATE, DELETE and TRUNCATE', async () => {
    const s = await scratchDb('prot');
    await bootDatabase({ migrate: true, pool: s.pool, backup: null });
    await applyProtections(s.pool);
    await applyProtections(s.pool);
    const triggers = (await s.pool.query(`select tgname from pg_trigger where tgname like 'gxp\\_%' order by tgname`)).rows.map(r => r.tgname);
    const declared = [...protectionStatements.join(' ').matchAll(/CREATE TRIGGER (gxp_\w+)/g)].map(m => m[1]).sort();
    expect(triggers).toEqual(declared);
    expect(triggers).toEqual(expect.arrayContaining(['gxp_audit_trail_row_guard', 'gxp_audit_trail_truncate_guard', 'gxp_signatures_row_guard', 'gxp_signatures_truncate_guard']));
    await expect(s.pool.query(`update audit_trail set reason = 'x'`)).rejects.toThrow(/not permitted/);
    await expect(s.pool.query('truncate signatures')).rejects.toThrow(/not permitted/);
  });
});
