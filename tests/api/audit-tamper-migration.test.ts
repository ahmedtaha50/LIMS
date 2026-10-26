/**
 * Roadmap M35 (r2-audit-tamper), migration 0170_audit_review: audit-trail reviews, the review requirement for release (off), the anchor
 * register, the clock guard's state and anomalies, three signature meanings and three permissions.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * a new installation: the meanings, the permissions and their grants, the setting row (off), and the database's own refusals
 *     (reviews and anchors are append-only, a review names a valid scope and range);
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/audit-review.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as auditReview from '../../src/db/schema/audit-review';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['audit_reviews', 'audit_review_settings', 'audit_anchors', 'clock_anomalies', 'clock_state'];
const MEANINGS = ['AUDIT_REVIEW', 'AUDIT_REVIEW_SETTING', 'CLOCK_ANOMALY_ACK'];
const backup = async () => ({ file: 'audit-tamper-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0170_audit_review, in the range reserved for this track', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0170_audit_review');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('at-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = any($1)`, [MEANINGS])).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code in ('audit.review', 'audit.review.settings', 'clock.acknowledge')`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meanings, the permissions, the setting (off) and the database-level controls', async () => {
    const s = await scratchDb('at-new');
    await migrate(s.pool, { dir: DIR });
    const meanings = (await s.pool.query(`select code, allowed_roles, requires_reason from signature_meanings where code = any($1) order by code`, [MEANINGS])).rows;
    expect(meanings).toEqual([
      { code: 'AUDIT_REVIEW', allowed_roles: ['QA', 'Admin'], requires_reason: false },
      { code: 'AUDIT_REVIEW_SETTING', allowed_roles: ['QA', 'Admin'], requires_reason: true },
      { code: 'CLOCK_ANOMALY_ACK', allowed_roles: ['Admin'], requires_reason: true },
    ]);
    const grants = (await s.pool.query(`select role_id || ':' || permission_code as g from role_permissions where permission_code in ('audit.review', 'audit.review.settings', 'clock.acknowledge') order by 1`)).rows.map(r => r.g);
    expect(grants).toEqual(['role-admin:audit.review', 'role-admin:audit.review.settings', 'role-admin:clock.acknowledge', 'role-qa:audit.review', 'role-qa:audit.review.settings']);
    expect((await s.pool.query(`select id, required_for_release, version from audit_review_settings`)).rows).toEqual([{ id: 'default', required_for_release: false, version: 1 }]);

    const user = (await s.pool.query(`select id from users limit 1`)).rows[0]?.id
      ?? (await s.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA') returning id`)).rows[0].id;
    const review = (id: string, scope: string, from: number, to: number, scopeId: string | null = 'B1') => s.pool.query(
      `insert into audit_reviews (id, scope, scope_id, from_sequence, to_sequence, rows_reviewed, exception_count, reviewer_id) values ($1, $2, $3, $4, $5, 1, 0, $6)`,
      [id, scope, scopeId, from, to, user]);
    await review('AR-1', 'batch', 1, 5);
    await expect(review('AR-2', 'everything', 1, 5)).rejects.toThrow(/audit_reviews_scope_check/);
    await expect(review('AR-3', 'range', 9, 5, null)).rejects.toThrow(/audit_reviews_range_check/);
    await expect(review('AR-4', 'batch', 1, 5, null)).rejects.toThrow(/audit_reviews_scope_id_check/);
    await s.pool.query(`insert into audit_anchors (id, sequence, hash, anchored_at, file_name, key_generation, hmac) values ('AN-1', 1, 'h', now(), 'f.json', 1, 'x')`);
    for (const table of ['audit_reviews', 'audit_anchors']) {
      await expect(s.pool.query(`update ${table} set id = id`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`truncate ${table}`)).rejects.toThrow(/append-only/);
    }
  });

  it('src/db/schema/audit-review.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('at-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...auditReview }, drizzle(s.pool) as any, ['public'], TABLES)).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0170 and changes no existing row', async () => {
    const s = await scratchDb('at-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0170_audit_review').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by sequence) from audit_trail t where entity <> 'SYSTEM_MIGRATION') as audit,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from users t) as users`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0170_audit_review');
    expect(await frozen()).toBe(rowsBefore);
    expect((await s.pool.query(`select required_for_release from audit_review_settings`)).rows).toEqual([{ required_for_release: false }]);
  });
});
