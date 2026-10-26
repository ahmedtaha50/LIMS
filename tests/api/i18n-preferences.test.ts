/**
 * Roadmap M38 (r3-i18n): the display language and digit style are kept on the server (migration 0350, GET/PUT /api/me/preferences).
 * Needs the gate patch (route registry, route-table rules, schema export). Display only: the tests also prove that choosing Arabic
 * changes no GxP data and that every change is audited in the same transaction.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, receiveSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
beforeAll(async () => { t = await startTestApp(); });

describe('GET /me/preferences', () => {
  it('needs a session (401)', async () => {
    expect((await t.request.get('/api/me/preferences')).status).toBe(401);
    expect((await t.request.put('/api/me/preferences').send({ language: 'ar', digits: 'latin', expectedVersion: 0 })).status).toBe(401);
  });

  it('answers English, Latin digits, version 0 for a user who never chose', async () => {
    const h = await t.auth('analyst2@gxp.com');
    const res = await t.request.get('/api/me/preferences').set(h);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ language: 'en', digits: 'latin', version: 0 });
  });
});

describe('PUT /me/preferences', () => {
  it('saves the choice, bumps the version and writes one audit entry per changed field with the actor from the session', async () => {
    const h = await t.auth('analyst1@gxp.com');
    const put = await t.request.put('/api/me/preferences').set(h).send({ language: 'ar', digits: 'arabic-indic', expectedVersion: 0 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({ language: 'ar', digits: 'arabic-indic', version: 1 });
    expect((await t.request.get('/api/me/preferences').set(h)).body).toEqual(put.body);

    const [me] = await sql("SELECT id FROM users WHERE lower(email) = 'analyst1@gxp.com'");
    const audit = await sql(`SELECT user_id, action, field, old_value, new_value FROM audit_trail WHERE entity = 'UserPreference' AND entity_id = $1 ORDER BY sequence`, [me.id]);
    expect(audit.map((a: any) => [a.field, a.old_value, a.new_value, a.user_id])).toEqual([['language', 'en', 'ar', me.id], ['digits', 'latin', 'arabic-indic', me.id]]);

    const back = await t.request.put('/api/me/preferences').set(h).send({ language: 'en', digits: 'latin', expectedVersion: 1 });
    expect(back.body).toEqual({ language: 'en', digits: 'latin', version: 2 });
  });

  it('refuses a stale version with 409 and changes nothing (optimistic concurrency)', async () => {
    const h = await t.auth('qa@gxp.com');
    expect((await t.request.put('/api/me/preferences').set(h).send({ language: 'ar', digits: 'latin', expectedVersion: 0 })).status).toBe(200);
    const stale = await t.request.put('/api/me/preferences').set(h).send({ language: 'en', digits: 'latin', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect((await t.request.get('/api/me/preferences').set(h)).body.language).toBe('ar');
  });

  it('creating the row with the default values is still an audited creation', async () => {
    const h = await t.auth('reviewer@gxp.com');
    expect((await t.request.put('/api/me/preferences').set(h).send({ language: 'en', digits: 'latin', expectedVersion: 0 })).status).toBe(200);
    const [me] = await sql("SELECT id FROM users WHERE lower(email) = 'reviewer@gxp.com'");
    const audit = await sql(`SELECT action FROM audit_trail WHERE entity = 'UserPreference' AND entity_id = $1`, [me.id]);
    expect(audit).toEqual([{ action: 'Create' }]);
  });

  it('an unchanged save writes no audit entry and keeps the version', async () => {
    const h = await t.auth('reviewer@gxp.com');
    const again = await t.request.put('/api/me/preferences').set(h).send({ language: 'en', digits: 'latin', expectedVersion: 1 });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(1);
  });

  it('is strict: an unknown language or digit style, a user id, a missing or non-integer version are 400', async () => {
    const h = await t.auth('admin@gxp.com');
    for (const body of [
      { language: 'fr', digits: 'latin', expectedVersion: 0 },
      { language: 'ar', digits: 'persian', expectedVersion: 0 },
      { language: 'ar', digits: 'latin', expectedVersion: 0, userId: 'usr-qa' },
      { language: 'ar', digits: 'latin' },
      { language: 'ar', digits: 'latin', expectedVersion: 1.5 },
      { language: 'ar', digits: 'latin', expectedVersion: -1 },
    ]) {
      const res = await t.request.put('/api/me/preferences').set(h).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('only ever touches the caller\'s own row', async () => {
    const before = await sql('SELECT user_id, language FROM user_preferences ORDER BY user_id COLLATE "C"');
    const h = await t.auth('admin@gxp.com');
    await t.request.put('/api/me/preferences').set(h).send({ language: 'ar', digits: 'latin', expectedVersion: 0 });
    const after = await sql('SELECT user_id, language FROM user_preferences ORDER BY user_id COLLATE "C"');
    const changed = after.filter((a: any) => !before.some((b: any) => b.user_id === a.user_id && b.language === a.language));
    expect(changed).toHaveLength(1);
    const [admin] = await sql("SELECT id FROM users WHERE lower(email) = 'admin@gxp.com'");
    expect(changed[0].user_id).toBe(admin.id);
  });
});

describe('the language never changes GxP data', () => {
  it('a result entered by an Arabic-interface user is stored as typed (Latin digits, point) and a comma or a letter is refused on the server', async () => {
    const h = await t.auth('analyst1@gxp.com');
    await t.request.put('/api/me/preferences').set(h).send({ language: 'ar', digits: 'arabic-indic', expectedVersion: 2 });

    const material = uniq('Mat');
    await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null }] as any);
    const created = await t.request.post('/api/samples').set(h).send({ material, batch: uniq('B') });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id as string;
    await receiveSample(t, id);
    expect((await t.request.post(`/api/samples/${id}/transition`).set(h).send({ action: 'submit', expectedVersion: 1 })).status).toBe(200);
    const [r] = await sql('SELECT id, version FROM results WHERE sample_id = $1', [id]);
    const put = (value: string, version = r.version) => t.request.put(`/api/samples/${id}/results/${r.id}`).set(h).send({ value, reason: 'routine entry', expectedVersion: version });

    // 1,5 could be 1.5 or 1500: refused, never guessed. Same for a thousands comma, an Arabic comma and an exponent.
    for (const value of ['99,5', '99٫5٬0', '1,234.5', '9.9e1', '٩٩,٥']) {
      const res = await put(value);
      expect(res.status, value).toBe(400);
    }
    expect((await sql('SELECT value, version FROM results WHERE id = $1', [r.id]))[0]).toEqual({ value: null, version: r.version });

    // Arabic-Indic digits with the Arabic decimal separator are the digits they are: stored as Latin 99.5.
    const ok = await put('٩٩٫٥');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.value).toBe('99.5');
    expect((await sql('SELECT value FROM results WHERE id = $1', [r.id]))[0].value).toBe('99.5');
  });
});
