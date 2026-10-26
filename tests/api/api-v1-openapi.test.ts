/**
 * Roadmap M22 (r2-api-v1): the contract of /api/v1.
 *
 *   - openapi.json (OpenAPI 3.1) is generated from the same Zod schemas that validate the requests, so it cannot drift from the code:
 *     the committed copy in docs/api/ must equal what the code generates, and it must validate;
 *   - the docs page loads offline: no external host anywhere, no inline script or style (the server's CSP), and it renders every
 *     operation from the committed files alone;
 *   - a breaking change to the contract is detected (the CI step `openapi-cli.ts check --base <ref>` fails on it), an additive one is not;
 *   - the running server serves exactly the generated document, and its answers match the response schemas in it.
 */
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

const ROOT = path.resolve(__dirname, '..', '..');
const docsFile = (name: string) => readFileSync(path.join(ROOT, 'docs', 'api', name), 'utf8');

let t: TestApp;
let v1: typeof import('../../src/server/v1/openapi');
let breaking: typeof import('../../src/server/v1/breaking');
let site: typeof import('../../src/server/v1/docsSite');
beforeAll(async () => {
  t = await startTestApp();
  v1 = await import('../../src/server/v1/openapi');
  breaking = await import('../../src/server/v1/breaking');
  site = await import('../../src/server/v1/docsSite');
});

describe('openapi.json', () => {
  it('the committed docs/api files are what the code generates (run `npx tsx src/server/v1/openapi-cli.ts write` after a change)', () => {
    for (const [name, content] of Object.entries(site.docsFiles(v1.buildOpenApiDocument()))) {
      expect(docsFile(name), `docs/api/${name} is stale`).toBe(content);
    }
  });

  it('is a valid OpenAPI 3.1 document: every operation has an id, a scope, responses and problem+json errors; every $ref resolves', () => {
    const doc = JSON.parse(docsFile('openapi.json'));
    expect(doc.openapi).toBe('3.1.0');
    expect(v1.validateOpenApiDocument(doc)).toEqual([]);
    const ops = Object.entries(doc.paths).flatMap(([p, item]: [string, any]) => Object.entries(item).map(([m, op]: [string, any]) => ({ p, m, op })));
    expect(ops.map(o => `${o.m.toUpperCase()} ${o.p}`).sort()).toEqual([
      'GET /batches/{batch}/disposition', 'GET /openapi.json', 'GET /samples', 'GET /samples/{sampleId}', 'GET /specifications/active',
      'POST /results:batch', 'POST /samples:batch',
    ]);
    for (const { p, op } of ops.filter(o => o.p !== '/openapi.json')) {
      expect(op.security?.[0]?.apiToken?.length, p).toBe(1);
      expect(op.responses['401'].content['application/problem+json'], p).toBeDefined();
      expect(op.responses['403'].content['application/problem+json'], p).toBeDefined();
    }
    expect(doc.paths['/results:batch'].post.requestBody.content['application/json'].schema.properties.items.maxItems).toBe(500);
    expect(doc.paths['/results:batch'].post.parameters.find((x: any) => x.name === 'Idempotency-Key')).toMatchObject({ in: 'header', required: true });
  });

  it('the validator itself rejects a broken document (unresolved $ref, duplicate operationId, undeclared path parameter)', () => {
    const doc = JSON.parse(docsFile('openapi.json'));
    doc.paths['/samples/{sampleId}'].get.parameters = [];
    doc.paths['/samples'].get.operationId = doc.paths['/samples:batch'].post.operationId;
    doc.paths['/samples'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Nope' };
    const problems = v1.validateOpenApiDocument(doc).join('\n');
    expect(problems).toMatch(/sampleId/);
    expect(problems).toMatch(/operationId/);
    expect(problems).toMatch(/Nope/);
  });

  it('the server serves the generated document', async () => {
    const res = await t.request.get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(docsFile('openapi.json')));
  });
});

describe('breaking-change detection', () => {
  const base = () => JSON.parse(docsFile('openapi.json'));
  const results = (d: any) => d.paths['/results:batch'].post.requestBody.content['application/json'].schema.properties.items.items;
  const sampleOut = (d: any) => d.paths['/samples/{sampleId}'].get.responses['200'].content['application/json'].schema.properties.sample;

  it('no change, a new optional request field, a new response field and a new operation are not breaking', () => {
    expect(breaking.findBreakingChanges(base(), base())).toEqual([]);
    const next = base();
    results(next).properties.note = { type: 'string' };
    sampleOut(next).properties.extra = { type: 'string' };
    next.paths['/instruments'] = { get: { ...next.paths['/samples'].get, operationId: 'listInstruments' } };
    expect(breaking.findBreakingChanges(base(), next)).toEqual([]);
  });

  it('a removed operation, a new required request field, a removed request field, a removed or optional response field, a tighter limit, a changed scope are breaking', () => {
    const cases: Array<[string, (d: any) => void]> = [
      ['removed operation', d => { delete d.paths['/samples:batch']; }],
      ['new required field', d => { results(d).properties.lot = { type: 'string' }; results(d).required.push('lot'); }],
      ['removed request field', d => { delete results(d).properties.instrumentId; }],
      ['removed response field', d => { delete sampleOut(d).properties.batch; }],
      ['response field optional', d => { sampleOut(d).required = sampleOut(d).required.filter((k: string) => k !== 'batch'); }],
      ['tighter limit', d => { d.paths['/results:batch'].post.requestBody.content['application/json'].schema.properties.items.maxItems = 100; }],
      ['type changed', d => { results(d).properties.expectedVersion = { type: 'string' }; }],
      ['scope changed', d => { d.paths['/samples'].get.security = [{ apiToken: ['samples:write'] }]; }],
      ['enum narrowed', d => { d.paths['/samples'].get.parameters.find((p: any) => p.name === 'state').schema.enum.pop(); }],
    ];
    for (const [name, change] of cases) {
      const next = base();
      change(next);
      expect(breaking.findBreakingChanges(base(), next).length, name).toBeGreaterThan(0);
    }
  });
});

describe('the docs page', () => {
  it('names no external host and needs no inline script or style', () => {
    const html = docsFile('index.html');
    for (const name of ['index.html', 'docs.js', 'docs.css']) expect(docsFile(name), name).not.toMatch(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    expect(html).toMatch(/<script src="openapi\.js"><\/script>/);
    expect(html).toMatch(/<script src="docs\.js"><\/script>/);
  });

  it('renders every operation from the committed files alone (no network)', () => {
    const doc = JSON.parse(docsFile('openapi.json'));
    const dom = fakeDocument();
    const sandbox: any = { document: dom, window: {} };
    sandbox.window = sandbox;
    vm.runInNewContext(docsFile('openapi.js'), sandbox);
    vm.runInNewContext(docsFile('docs.js'), sandbox);
    const text = dom.root.allText();
    for (const [p, item] of Object.entries(doc.paths)) for (const op of Object.values(item as object) as any[]) {
      expect(text).toContain(p);
      expect(text).toContain(op.summary);
    }
    expect(text).toContain('results:write');
  });

  it('is served by the server with the CSP of the application', async () => {
    const bare = await t.request.get('/api/v1/docs');
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe('/api/v1/docs/');
    const page = await t.request.get('/api/v1/docs/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toBe(docsFile('index.html'));
    for (const name of ['docs.js', 'docs.css', 'openapi.js']) {
      const res = await t.request.get(`/api/v1/docs/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.text, name).toBe(docsFile(name));
    }
  });
});

/** Just enough of the DOM for docs.js: elements with children, text and attributes. */
function fakeDocument() {
  class El {
    children: El[] = [];
    attrs: Record<string, string> = {};
    className = '';
    private ownText = '';
    constructor(readonly tag: string) {}
    appendChild(c: El) { this.children.push(c); return c; }
    append(...cs: Array<El | string>) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(new El('#text'), { textContent: c }) : c); }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    set textContent(v: string) { this.ownText = String(v); this.children = []; }
    get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
    allText(): string { return this.textContent; }
  }
  const root = new El('main');
  return {
    root,
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => Object.assign(new El('#text'), { textContent: text }),
    getElementById: (id: string) => (id === 'app' ? root : null),
    title: '',
  };
}
