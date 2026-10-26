/**
 * The docs page of /api/v1 (roadmap M22: "the docs page loads offline"). Five files, kept here as text so the server bundle serves them
 * without reading the disk and `openapi-cli.ts write` copies them to docs/api/, where index.html opens straight from the file system:
 *
 *   index.html    the page: no external host, no inline script or style (the server's Content-Security-Policy is script-src 'self')
 *   openapi.js    the document as a script (window.__OPENAPI__), so the page needs no fetch, which a file:// page cannot make
 *   openapi.json  the same document as JSON
 *   docs.js       renders the document with DOM calls and textContent only (nothing from the document is parsed as HTML)
 *   docs.css      the styles
 *
 * The server serves them at /api/v1/docs/ (and /api/v1/openapi.json).
 */
type Json = Record<string, any>;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>B-Pharma LIMS API v1</title>
<link rel="stylesheet" href="docs.css">
</head>
<body>
<main id="app" class="page"><p>Loading the API reference. If this text stays, open this page in a browser with JavaScript enabled.</p></main>
<script src="openapi.js"></script>
<script src="docs.js"></script>
</body>
</html>
`;

const DOCS_CSS = `:root { color-scheme: light dark; --fg: #1f2937; --muted: #4b5563; --bg: #ffffff; --line: #d1d5db; --code: #f3f4f6; --get: #065f46; --post: #1e3a8a; }
@media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --muted: #9ca3af; --bg: #111827; --line: #374151; --code: #1f2937; --get: #6ee7b7; --post: #93c5fd; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { font-size: 16px; margin: 0; font-family: ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
p, li { color: var(--muted); }
.op { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.method { display: inline-block; min-width: 52px; font-weight: 700; margin-right: 8px; }
.method.get { color: var(--get); }
.method.post { color: var(--post); }
.scope { font-family: ui-monospace, Consolas, monospace; font-size: 13px; background: var(--code); padding: 1px 6px; border-radius: 4px; }
pre { background: var(--code); padding: 8px 12px; border-radius: 6px; overflow-x: auto; font-size: 12.5px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 4px 8px; vertical-align: top; }
code { font-family: ui-monospace, Consolas, monospace; }
summary { cursor: pointer; margin-top: 6px; }
`;

const DOCS_JS = `/* Renders window.__OPENAPI__ (openapi.js). DOM calls and textContent only: nothing from the document is parsed as HTML. */
(function () {
  var doc = window.__OPENAPI__;
  var app = document.getElementById('app');
  if (!doc || !app) return;
  app.textContent = '';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function block(parent, title, value) {
    var d = add(parent, el('details'));
    add(d, el('summary', null, title));
    add(d, el('pre', null, JSON.stringify(value, null, 2)));
  }

  document.title = doc.info.title + ' ' + doc.info.version;
  add(app, el('h1', null, doc.info.title));
  add(app, el('p', null, 'Version ' + doc.info.version + '. Base path ' + ((doc.servers && doc.servers[0] && doc.servers[0].url) || '') + '.'));
  add(app, el('p', null, doc.info.description));

  add(app, el('h2', null, 'Authentication and scopes'));
  var scheme = doc.components.securitySchemes.apiToken;
  add(app, el('p', null, 'Send Authorization: Bearer <token> (format ' + scheme.bearerFormat + '). Each operation needs one scope.'));
  var st = add(app, el('table'));
  var sh = add(st, el('tr'));
  add(sh, el('th', null, 'Scope'));
  add(sh, el('th', null, 'Allows'));
  (doc['x-scopes'] || []).forEach(function (s) {
    var tr = add(st, el('tr'));
    add(add(tr, el('td')), el('code', null, s.scope));
    add(tr, el('td', null, s.description));
  });

  add(app, el('h2', null, 'Operations'));
  Object.keys(doc.paths).forEach(function (path) {
    var item = doc.paths[path];
    Object.keys(item).forEach(function (method) {
      var op = item[method];
      var box = add(app, el('section', 'op'));
      box.setAttribute('id', 'op-' + op.operationId);
      var h = add(box, el('h3'));
      add(h, el('span', 'method ' + method, method.toUpperCase()));
      add(h, el('span', null, path));
      add(box, el('p', null, op.summary));
      if (op.description) add(box, el('p', null, op.description));
      var scopes = (op.security && op.security[0] && op.security[0].apiToken) || [];
      var sp = add(box, el('p', null, scopes.length ? 'Scope: ' : 'No token needed.'));
      scopes.forEach(function (s) { add(sp, el('span', 'scope', s)); });
      if (op.parameters && op.parameters.length) {
        var t = add(box, el('table'));
        var hr = add(t, el('tr'));
        ['Parameter', 'In', 'Required', 'Description'].forEach(function (x) { add(hr, el('th', null, x)); });
        op.parameters.forEach(function (p) {
          var tr = add(t, el('tr'));
          add(add(tr, el('td')), el('code', null, p.name));
          add(tr, el('td', null, p.in));
          add(tr, el('td', null, p.required ? 'yes' : 'no'));
          add(tr, el('td', null, p.description || JSON.stringify(p.schema)));
        });
      }
      if (op.requestBody) block(box, 'Request body (application/json)', op.requestBody.content['application/json'].schema);
      Object.keys(op.responses).forEach(function (status) {
        var r = op.responses[status];
        var types = Object.keys(r.content || {});
        var schema = types.length ? r.content[types[0]].schema : null;
        if (schema) block(box, status + ' ' + r.description + ' (' + types[0] + ')', schema);
        else add(box, el('p', null, status + ' ' + r.description));
      });
    });
  });

  add(app, el('h2', null, 'Problem codes'));
  add(app, el('p', null, 'Every error is application/problem+json (RFC 9457) with a stable code; errors[] names each refused field or batch item.'));
  var pt = add(app, el('table'));
  (doc['x-problem-codes'] || []).forEach(function (c) {
    var tr = add(pt, el('tr'));
    tr.setAttribute('id', 'problem-' + c.code.toLowerCase().split('_').join('-'));
    add(add(tr, el('td')), el('code', null, c.code));
    add(tr, el('td', null, c.description));
  });
  block(app, 'Problem schema', doc.components.schemas.Problem);
})();
`;

/** The five files of the docs site for `doc`, by file name. */
export function docsFiles(doc: Json): Record<string, string> {
  return {
    'openapi.json': `${JSON.stringify(doc, null, 2)}\n`,
    'openapi.js': `window.__OPENAPI__ = ${JSON.stringify(doc)};\n`,
    'index.html': INDEX_HTML,
    'docs.js': DOCS_JS,
    'docs.css': DOCS_CSS,
  };
}

export const DOCS_CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'openapi.js': 'text/javascript; charset=utf-8',
  'docs.js': 'text/javascript; charset=utf-8',
  'docs.css': 'text/css; charset=utf-8',
  'openapi.json': 'application/json; charset=utf-8',
};
