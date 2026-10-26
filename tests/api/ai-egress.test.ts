/**
 * Roadmap M16 (r1-identity): controlled AI / external egress. AI is off by default; with no key or while disabled nothing is
 * sent anywhere and no canned text is returned; enabling needs the administrator's password and is audited; every request
 * that leaves the machine writes an EXTERNAL_CALL entry; output carries a label; the API key is stored encrypted and never returned.
 * The Google SDK is replaced by a recorder (the network boundary); the application, the routes and PostgreSQL are real.
 */
import net from 'net';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

const sdk = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, any>>,
  next: { text: 'The sample was prepared in duplicate.' } as { text?: string; throws?: string },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(options: Record<string, unknown>) { sdk.constructed.push(options); }
    models = {
      generateContent: async (request: Record<string, any>) => {
        sdk.calls.push(request);
        if (sdk.next.throws) throw new Error(sdk.next.throws);
        return { text: sdk.next.text };
      },
    };
  },
}));

const KEY = 'AIzaSyTestKeyDoNotUse0123456789abcdef';
const AUDIO = 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/';
const CAPA = { sampleId: 'SMP-2026-00042', resultId: 'RES-ABC123XYZ', parameter: 'Assay (%)', value: '91.2', specMin: 98, specMax: 102, instrument: 'HPLC-01', notes: 'Checked SMP-2026-00042 twice' };
let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  // Cache the five tokens now: building a header inside `request.get(...).set(await t.auth(...))` would otherwise log in while that request waits.
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});
beforeEach(() => { sdk.constructed.length = 0; sdk.calls.length = 0; sdk.next = { text: 'The sample was prepared in duplicate.' }; });

const admin = () => t.auth('admin@gxp.com');
const row = async () => (await t.db.pool.query("SELECT * FROM integration_settings WHERE id = 'default'")).rows[0];
const externalCalls = async () => (await t.db.pool.query("SELECT actor_id, actor_role, outcome, detail FROM security_events WHERE event_type = 'EXTERNAL_CALL' ORDER BY sequence")).rows;
async function version() { return (await t.request.get('/api/admin/integrations').set(await admin())).body.ai.version as number; }
async function configure(body: Record<string, unknown>) {
  const expectedVersion = await version(); // read first: a request object must not sit idle while another one runs
  const headers = await admin();
  return t.request.put('/api/admin/integrations/ai').set(headers)
    .send({ reason: 'AI use approved for drafting', password: TEST_PASSWORD, expectedVersion, ...body });
}
async function enable() { const r = await configure({ enabled: true, apiKey: KEY }); expect(r.status, JSON.stringify(r.body)).toBe(200); }
async function disable() { const r = await configure({ enabled: false, reason: 'Back to offline' }); expect(r.status, JSON.stringify(r.body)).toBe(200); }

describe('AI is off by default and nothing canned is ever returned (M16 acceptance)', () => {
  it('POST /transcribe with no key returns 503 AI_DISABLED, no text, and sends nothing anywhere', async () => {
    const res = await t.request.post('/api/transcribe').set(await t.auth('analyst1@gxp.com')).send({ audio: AUDIO });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_DISABLED');
    expect(res.body.text).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/System suitability|laminar|SOP-QC-402/i);
    expect(sdk.constructed).toHaveLength(0);
    expect(sdk.calls).toHaveLength(0);
  });

  it('the other two AI routes behave the same, and a GEMINI_API_KEY in the environment does not switch AI on', async () => {
    process.env.GEMINI_API_KEY = 'env-key-that-must-be-ignored';
    try {
      const analyst = await t.auth('analyst1@gxp.com');
      const capa = await t.request.post('/api/ai/capa-analysis').set(analyst).send(CAPA);
      expect(capa.status).toBe(503);
      expect(capa.body.code).toBe('AI_DISABLED');
      expect(capa.body.summary).toBeUndefined();
      expect(capa.body.fishboneAnalysis).toBeUndefined();
      const eln = await t.request.post('/api/ai/eln-protocol').set(analyst).send({ title: 'T', experimentType: 'HPLC Assay' });
      expect(eln.status).toBe(503);
      expect(eln.body.code).toBe('AI_DISABLED');
      expect(eln.body.protocol).toBeUndefined();
      expect(sdk.constructed).toHaveLength(0);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('needs a session, and validates its input strictly', async () => {
    expect((await t.request.post('/api/transcribe').send({ audio: AUDIO })).status).toBe(401);
    const analyst = await t.auth('analyst1@gxp.com');
    expect((await t.request.post('/api/transcribe').set(analyst).send({})).status).toBe(400);
    expect((await t.request.post('/api/transcribe').set(analyst).send({ audio: 'not a data url' })).status).toBe(400);
    expect((await t.request.post('/api/transcribe').set(analyst).send({ audio: AUDIO, language: 'ar' })).status).toBe(400);
    expect((await t.request.post('/api/ai/capa-analysis').set(analyst).send({ ...CAPA, model: 'other' })).status).toBe(400);
  });
});

describe('a run with AI off needs no network (M16 acceptance: the OQ suite completes with outbound access denied)', () => {
  it('sign-in, the three AI routes and ordinary reads open no connection except to this computer', async () => {
    const targets: string[] = [];
    const original = net.Socket.prototype.connect;
    const spy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: any[]) {
      const first = args[0];
      targets.push(typeof first === 'object' && first !== null ? (first.path ? 'unix' : String(first.host ?? 'localhost')) : String(args[1] ?? 'localhost'));
      return (original as any).apply(this, args);
    });
    try {
      const analyst = await t.auth('analyst1@gxp.com');
      await t.request.post('/api/auth/login-local').send({ email: 'qa@gxp.com', password: TEST_PASSWORD });
      await t.request.post('/api/transcribe').set(analyst).send({ audio: AUDIO });
      await t.request.post('/api/ai/capa-analysis').set(analyst).send(CAPA);
      await t.request.post('/api/ai/eln-protocol').set(analyst).send({ title: 'T' });
      await t.request.get('/api/samples').set(analyst);
    } finally {
      spy.mockRestore();
    }
    expect(targets.length).toBeGreaterThan(0); // the spy saw the test's own loopback traffic
    expect(targets.filter(h => !['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', 'unix'].includes(h))).toEqual([]);
    expect(sdk.constructed).toHaveLength(0);
  });
});

describe('enabling AI', () => {
  it('is for Administrators with their password, with a reason and the current version, and is audited', async () => {
    const body = { enabled: true, apiKey: KEY, reason: 'AI use approved for drafting', password: TEST_PASSWORD, expectedVersion: await version() };
    expect((await t.request.put('/api/admin/integrations/ai').set(await t.auth('analyst1@gxp.com')).send(body)).status).toBe(403);
    expect((await t.request.put('/api/admin/integrations/ai').set(await t.auth('qa@gxp.com')).send(body)).status).toBe(403);
    const wrong = await t.request.put('/api/admin/integrations/ai').set(await admin()).send({ ...body, password: 'not-my-password' });
    expect(wrong.status).toBe(401);
    expect((await t.request.put('/api/admin/integrations/ai').set(await admin()).send({ ...body, expectedVersion: body.expectedVersion + 3 })).status).toBe(409);
    expect((await t.request.put('/api/admin/integrations/ai').set(await admin()).send({ ...body, reason: undefined })).status).toBe(400);
    expect((await t.request.put('/api/admin/integrations/ai').set(await admin()).send({ ...body, extra: true })).status).toBe(400);
    expect((await t.request.put('/api/admin/integrations/ai').set(await admin()).send({ enabled: true, reason: 'Enable without a key', password: TEST_PASSWORD, expectedVersion: body.expectedVersion })).status).toBe(400); // no key stored, none given
    // refused attempts change nothing: no Update entry; the wrong password is recorded as a failed signature (committed although the request failed)
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Integration' AND action = 'Update'")).rows[0].n).toBe(0);
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Integration' AND action = 'SignatureFailed' AND user_id = 'usr-admin'")).rows[0].n).toBe(1);
    expect((await row())?.external_ai_enabled ?? false).toBe(false);

    const ok = await t.request.put('/api/admin/integrations/ai').set(await admin()).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.ai).toMatchObject({ enabled: true, hasApiKey: true, version: body.expectedVersion + 1 });
    expect(JSON.stringify(ok.body)).not.toContain(KEY);

    const stored = await row();
    expect(stored.external_ai_enabled).toBe(true);
    expect(stored.ai_api_key_enc).toMatch(/^v1:/);
    expect(stored.ai_api_key_enc).not.toContain(KEY);
    const audit = (await t.db.pool.query("SELECT user_id, action, reason, old_value, new_value FROM audit_trail WHERE entity = 'Integration' AND action = 'Update' ORDER BY sequence")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: 'usr-admin', action: 'Update', reason: 'AI use approved for drafting' });
    expect(audit[0].new_value).toContain('"enabled":true');
    expect(JSON.stringify(audit)).not.toContain(KEY);

    const read = await t.request.get('/api/admin/integrations').set(await admin());
    expect(read.body.ai).toMatchObject({ enabled: true, hasApiKey: true, redactIdentifiers: true });
    expect(JSON.stringify(read.body)).not.toContain(KEY);
    expect((await t.request.get('/api/admin/integrations').set(await t.auth('analyst1@gxp.com'))).status).toBe(403);
  });
});

describe('with AI enabled', () => {
  beforeAll(async () => { await enable(); });

  it('a transcription goes out with the stored key, comes back labelled, and writes one EXTERNAL_CALL security event', async () => {
    const before = (await externalCalls()).length;
    const res = await t.request.post('/api/transcribe').set(await t.auth('analyst1@gxp.com')).send({ audio: AUDIO });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('The sample was prepared in duplicate.');
    expect(res.body.generatedBy).toMatchObject({ provider: 'google-genai', label: 'AI draft - not a GxP record' });
    expect(res.body.generatedBy.model).toBeTruthy();
    expect(sdk.constructed).toEqual([expect.objectContaining({ apiKey: KEY })]);

    const calls = await externalCalls();
    expect(calls.length).toBe(before + 1);
    const last = calls[calls.length - 1];
    expect(last).toMatchObject({ actor_id: 'usr-analyst1', actor_role: 'Analyst', outcome: 'info' });
    const detail = JSON.parse(last.detail);
    expect(detail).toMatchObject({ endpoint: '/api/transcribe', provider: 'google-genai', purpose: 'transcription', identifiersRedacted: true });
    expect(detail.bytes).toBeGreaterThan(0);
    expect(last.detail).not.toContain(KEY);
    expect(last.detail).not.toContain('GkXfo59');
  });

  it('identifiers are removed from the prompt by default, and kept only when the administrator turns redaction off', async () => {
    sdk.next = { text: JSON.stringify({ summary: 'Probable weighing error.', rootCauseConclusion: 'Weighing' }) };
    const analyst = await t.auth('analyst1@gxp.com');
    const redacted = await t.request.post('/api/ai/capa-analysis').set(analyst).send(CAPA);
    expect(redacted.status).toBe(200);
    expect(redacted.body.summary).toBe('Probable weighing error.');
    expect(redacted.body.generatedBy.label).toBe('AI draft - not a GxP record');
    const prompt = JSON.stringify(sdk.calls[0]);
    expect(prompt).not.toContain('SMP-2026-00042');
    expect(prompt).not.toContain('RES-ABC123XYZ');
    expect(prompt).toContain('Assay (%)'); // the science stays

    sdk.calls.length = 0;
    expect((await configure({ enabled: true, redactIdentifiers: false, reason: 'QA asked for full context' })).status).toBe(200);
    expect((await t.request.post('/api/ai/capa-analysis').set(analyst).send(CAPA)).status).toBe(200);
    expect(JSON.stringify(sdk.calls[0])).toContain('SMP-2026-00042');
    expect((await configure({ enabled: true, redactIdentifiers: true, reason: 'Back to the default' })).status).toBe(200);
  });

  it('a protocol draft carries the label inside its text, so it stays on the record until a person removes it', async () => {
    sdk.next = { text: '## Objective\nAssay of tablets.' };
    const res = await t.request.post('/api/ai/eln-protocol').set(await t.auth('analyst1@gxp.com')).send({ title: 'T', experimentType: 'HPLC Assay', sampleId: 'SMP-2026-00042' });
    expect(res.status).toBe(200);
    expect(res.body.protocol).toMatch(/^AI DRAFT - NOT A GXP RECORD/);
    expect(res.body.protocol).toContain('## Objective');
    expect(res.body.generatedBy.label).toBe('AI draft - not a GxP record');
    expect(JSON.stringify(sdk.calls[0])).not.toContain('SMP-2026-00042');
  });

  it('when the provider fails the answer is 503 AI_UNAVAILABLE with no invented content, and the attempt is still recorded', async () => {
    const before = (await externalCalls()).length;
    sdk.next = { throws: 'quota exceeded' };
    const analyst = await t.auth('analyst1@gxp.com');
    for (const [url, body] of [['/api/transcribe', { audio: AUDIO }], ['/api/ai/capa-analysis', CAPA], ['/api/ai/eln-protocol', { title: 'T' }]] as const) {
      const res = await t.request.post(url).set(analyst).send(body);
      expect(res.status, url).toBe(503);
      expect(res.body.code, url).toBe('AI_UNAVAILABLE');
      expect(JSON.stringify(res.body), url).not.toMatch(/quota|System suitability|fishbone|SOP-QC-402|Analytical Testing Protocol/i);
    }
    expect((await externalCalls()).length).toBe(before + 3);
  });

  it('an unusable answer to the CAPA request is a 503, never a made-up analysis', async () => {
    sdk.next = { text: 'this is not JSON' };
    const res = await t.request.post('/api/ai/capa-analysis').set(await t.auth('analyst1@gxp.com')).send(CAPA);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    expect(res.body.summary).toBeUndefined();
  });

  it('switching AI off again returns every route to AI_DISABLED, and the audit chain is intact', async () => {
    await disable();
    sdk.constructed.length = 0;
    const res = await t.request.post('/api/transcribe').set(await t.auth('analyst1@gxp.com')).send({ audio: AUDIO });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_DISABLED');
    expect(sdk.constructed).toHaveLength(0);
    const verify = await t.request.post('/api/audit/verify').set(await t.auth('qa@gxp.com'));
    expect(verify.body.isValid).toBe(true);
  });
});
