/**
 * Global search (roadmap M43, r3-search-perf): GET /api/search behind the Ctrl+K palette.
 *
 * Needs the gate patch (route registry and route-table rule) and migration 0340. Independent of the database collation and locale:
 * every expectation is on ids and on sets, never on the order PostgreSQL's collation would give; Arabic is matched by the
 * normalisation in SQL (search_norm), which does not depend on the locale.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
const q = (text: string, p: unknown[] = []) => t.db.pool.query(text, p);
const search = async (as: string, query: string) => {
  const h = await t.auth(as);
  return t.request.get('/api/search').query(query).set(h);
};
const groupsOf = (body: any) => Object.fromEntries(body.groups.map((g: any) => [g.type, g.hits.map((h: any) => h.id).sort()]));

beforeAll(async () => {
  t = await startTestApp();
  await q(`INSERT INTO samples (id, material, batch, state, created_by) VALUES
    ('SMP-9-00001', 'Ibuprofen 400 mg tablets', 'IBU-LOT-1', 'Testing', 'usr-admin'),
    ('SMP-9-00002', 'Paracetamol', 'PCM-LOT-7', 'Testing', 'usr-admin'),
    ('SMP-9-00003', 'أَسبِرين', 'لوط-١٢٣', 'Testing', 'usr-admin'),
    ('SMP-9-00004', 'Percent 100%', 'B_1', 'Testing', 'usr-admin')`);
  await q(`INSERT INTO products (id, code, name, description, created_by) VALUES
    ('PRD-1', 'IBU400', 'Ibuprofen 400', 'Film-coated tablet', 'usr-admin'),
    ('PRD-2', 'PCM500', 'Paracetamol 500', NULL, 'usr-admin'),
    ('PRD-3', 'ASP', 'أسبرين', NULL, 'usr-admin')`);
  await q(`INSERT INTO product_batches (id, product_id, batch_no, created_by) VALUES ('PB-1', 'PRD-1', 'IBU-B-2026-01', 'usr-admin')`);
  await q(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-1', 'Ibuprofen 400 mg tablets', 1, '2026-01-01', 'Approved', '[]')`);
  await q(`INSERT INTO methods (id, code, title, revision, status, created_by) VALUES ('MTH-1', 'HPLC-IBU', 'Assay of ibuprofen by HPLC', 1, 'Effective', 'usr-admin')`);
  await q(`INSERT INTO documents (id, code, title, doc_type, created_by) VALUES
    ('DOC-1', 'SOP-001', 'Handling of ibuprofen reference standards', 'SOP', 'usr-admin'),
    ('DOC-2', 'POL-001', 'Ibuprofen supply policy', 'Policy', 'usr-admin')`);
});

describe('GET /search', () => {
  it('needs a signed-in user', async () => {
    const res = await t.request.get('/api/search').query({ q: 'ibu' });
    expect(res.status).toBe(401);
  });

  it('refuses a short query, an unknown key, a bad limit and an unknown type (400)', async () => {
    for (const query of ['q=i', 'q=ib', 'q=%20%20%20', 'q=ibu&x=1', 'q=ibu&limit=0', 'q=ibu&limit=21', 'q=ibu&types=samples,passwords', 'q=' + 'a'.repeat(101), '']) {
      const res = await search('admin@gxp.com', query);
      expect(res.status, query).toBe(400);
    }
  });

  it('finds every kind of record for an administrator, as a substring and in any case', async () => {
    const res = await search('admin@gxp.com', 'q=IBU');
    expect(res.status).toBe(200);
    const g = groupsOf(res.body);
    expect(g.samples).toEqual(['SMP-9-00001']);
    expect(g.products).toEqual(['PRD-1']);
    expect(g.batches).toEqual(['PB-1']);
    expect(g.specifications).toEqual(['SPEC-1']);
    expect(g.methods).toEqual(['MTH-1']);
    expect(g.sops).toEqual(['DOC-1']);
    expect(g.documents).toEqual(['DOC-2']);
    expect(g.users).toBeUndefined();
    const sample = res.body.groups.find((x: any) => x.type === 'samples').hits[0];
    expect(sample).toMatchObject({ view: 'samples', segments: ['SMP-9-00001'], label: 'SMP-9-00001' });
  });

  it('finds a sample by a part of its id and a user by name or e-mail', async () => {
    expect(groupsOf((await search('admin@gxp.com', 'q=9-00002')).body).samples).toEqual(['SMP-9-00002']);
    expect(groupsOf((await search('qa@gxp.com', 'q=Analyst%20One')).body).users).toEqual(['usr-analyst1']);
    expect(groupsOf((await search('qa@gxp.com', 'q=analyst2@GXP')).body).users).toEqual(['usr-analyst2']);
  });

  it('treats % and _ as ordinary characters', async () => {
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('%%%'))).body)).toEqual({});
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('100%'))).body).samples).toEqual(['SMP-9-00004']);
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('B_1'))).body).samples).toEqual(['SMP-9-00004']);
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('BX1'))).body)).toEqual({});
  });

  it('matches Arabic with or without diacritics, alef variants and Arabic-Indic digits', async () => {
    for (const word of ['اسبرين', 'أَسبِرين', 'إسبرين', 'اسـبرين']) {
      const g = groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent(word))).body);
      expect(g.samples, word).toEqual(['SMP-9-00003']);
      expect(g.products, word).toEqual(['PRD-3']);
    }
    // the digits were stored as Arabic-Indic (١٢٣) and are found as 123 and as ١٢٣
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('لوط-123'))).body).samples).toEqual(['SMP-9-00003']);
    expect(groupsOf((await search('admin@gxp.com', 'q=' + encodeURIComponent('لوط-١٢٣'))).body).samples).toEqual(['SMP-9-00003']);
  });

  it('leaks nothing a role may not read: a group is absent, not empty', async () => {
    // An analyst may not list users (admin.users.view), whatever the query.
    const res = await search('analyst1@gxp.com', 'q=Test');
    expect(res.status).toBe(200);
    expect(res.body.groups.find((g: any) => g.type === 'users')).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('usr-admin');
    expect(JSON.stringify(res.body)).not.toMatch(/password|totp|hash/i);

    // Take the permissions away one by one: the group disappears the same request, nothing is cached.
    const before = groupsOf((await search('analyst1@gxp.com', 'q=ibu')).body);
    expect(Object.keys(before).length).toBeGreaterThan(0);
    const revoke = async (code: string) => (await q(`DELETE FROM role_permissions WHERE role_id = 'role-analyst' AND permission_code = $1 RETURNING 1`, [code])).rowCount;
    const revoked: string[] = [];
    try {
      const groupToPermission: Record<string, string> = { samples: 'sample.view', products: 'master.view', batches: 'master.view', specifications: 'spec.view', methods: 'method.view', sops: 'doc.view', documents: 'doc.view' };
      for (const permission of new Set(Object.values(groupToPermission))) {
        if (await revoke(permission)) revoked.push(permission);
        const after = groupsOf((await search('analyst1@gxp.com', 'q=ibu')).body);
        for (const [group, needed] of Object.entries(groupToPermission)) {
          if (revoked.includes(needed)) expect(after[group], `${group} after revoking ${needed}`).toBeUndefined();
        }
      }
      expect((await search('analyst1@gxp.com', 'q=ibu')).body.groups).toEqual([]);
    } finally {
      for (const code of revoked) await q(`INSERT INTO role_permissions (id, role_id, permission_code) VALUES ('role-analyst:' || $1, 'role-analyst', $1)`, [code]);
    }
    expect(groupsOf((await search('analyst1@gxp.com', 'q=ibu')).body)).toEqual(before);
  });

  it('never searches the audit trail or the security log', async () => {
    await q(`INSERT INTO audit_trail (id, user_id, action, entity, entity_id, old_value, new_value, previous_hash, hash)
             SELECT 'AUD-SEARCH', 'usr-admin', 'IBUPROFEN_PROBE', 'zzentity', 'zz', NULL, '{"note":"ibuprofen-probe"}', repeat('0', 64), repeat('1', 64)
             WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_trail' AND column_name = 'previous_hash')`).catch(() => undefined);
    const res = await search('admin@gxp.com', 'q=IBUPROFEN_PROBE');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.groups.map((g: any) => g.type)).not.toContain('audit');
  });

  it('is a read: it writes no audit entry', async () => {
    const count = async () => Number((await q('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n);
    const before = await count();
    await search('admin@gxp.com', 'q=ibu');
    await search('analyst1@gxp.com', 'q=ibu');
    expect(await count()).toBe(before);
  });

  it('limits each group, says when there is more, and can be narrowed with types', async () => {
    await q(`INSERT INTO samples (id, material, batch, state, created_by) SELECT 'SMP-8-' || g, 'Zetamol ' || g, 'ZB', 'Testing', 'usr-admin' FROM generate_series(1, 7) g`);
    const res = await search('admin@gxp.com', 'q=zetamol&limit=3');
    const group = res.body.groups.find((g: any) => g.type === 'samples');
    expect(group.hits).toHaveLength(3);
    expect(group.more).toBe(true);
    const all = await search('admin@gxp.com', 'q=zetamol&limit=20');
    expect(all.body.groups[0].hits).toHaveLength(7);
    expect(all.body.groups[0].more).toBe(false);
    const narrowed = await search('admin@gxp.com', 'q=ibu&types=methods,sops');
    expect(narrowed.body.groups.map((g: any) => g.type).sort()).toEqual(['methods', 'sops']);
  });

  it('puts a record that starts with the text before one that only contains it', async () => {
    await q(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ('SMP-7-00001', 'Old Zzq cream', 'B', 'Testing', 'usr-admin'), ('SMP-7-00002', 'Zzq ointment', 'B', 'Testing', 'usr-admin')`);
    const res = await search('admin@gxp.com', 'q=zzq');
    const ids = res.body.groups.find((g: any) => g.type === 'samples').hits.map((h: any) => h.id);
    expect(ids).toEqual(['SMP-7-00002', 'SMP-7-00001']);
  });
});

describe('the index', () => {
  it('is used by the exact expressions of the search (checked by EXPLAIN with sequential scans discouraged)', async () => {
    const ext = await q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    if (!ext.rowCount) return; // a PostgreSQL without contrib: the search runs on a scan (see search-fallback.test.ts)
    const plans: Array<[string, string, string]> = [
      ['samples', `search_norm(id || ' ' || material || ' ' || batch)`, 'samples_search_trgm_idx'],
      ['product_batches', `search_norm(id || ' ' || batch_no)`, 'product_batches_search_trgm_idx'],
      ['products', `search_norm(code || ' ' || name || ' ' || coalesce(description, ''))`, 'products_search_trgm_idx'],
      ['specifications', `search_norm(id || ' ' || material)`, 'specifications_search_trgm_idx'],
      ['methods', `search_norm(code || ' ' || title || ' ' || coalesce(description, ''))`, 'methods_search_trgm_idx'],
      ['documents', `search_norm(code || ' ' || title)`, 'documents_search_trgm_idx'],
    ];
    const c = await t.db.pool.connect();
    try {
      await c.query('SET enable_seqscan = off');
      for (const [table, expr, index] of plans) {
        const plan = (await c.query(`EXPLAIN SELECT 1 FROM ${table} WHERE ${expr} LIKE '%ibu%'`)).rows.map(r => r['QUERY PLAN']).join('\n');
        expect(plan, table).toContain(index);
      }
    } finally { c.release(); }
  });

  it('search_norm folds the Arabic spellings the way the migration documents', async () => {
    const r = await q(`SELECT search_norm('أَحْمَد إبراهيم آمنة ٣٢١ ۴۵ IBUprofen كــتاب مدرسة') AS n, search_norm('ؤ ئ ى ک ی') AS m`);
    expect(r.rows[0].n).toBe('احمد ابراهيم امنه 321 45 ibuprofen كتاب مدرسه');
    expect(r.rows[0].m).toBe('و ي ي ك ي');
  });
});
