/* Renders window.__OPENAPI__ (openapi.js). DOM calls and textContent only: nothing from the document is parsed as HTML. */
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
