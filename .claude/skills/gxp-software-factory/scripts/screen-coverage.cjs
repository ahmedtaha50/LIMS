#!/usr/bin/env node
// Every function a person can call has a screen that calls it. On the source project the API was complete and tested,
// and seven functions had no screen at all (user management, creating a logbook, copying a recipe, the audit review...):
// the user found them missing, not a test.
//
//   node screen-coverage.cjs [--repo .] [--routes <route-table.json>] [--client <dir>] [--json]
//
// The routes: a JSON list of { method, path } (a route-table snapshot), SCREENS.routeTable in factory.config.json.
// The screens: the source files (.ts .tsx .js .jsx .vue .svelte) under SCREENS.clientDir, translations (i18n/) left out.
// A route counts as covered when a screen names its path (template parameters ${x} and route parameters :id are one
// segment each; a query string is ignored) and, for a method other than GET, names the method too ('POST', ...).
// An action chosen at run time (`/api/x/${id}/${action}`) counts when the screen also names the action as a string.
// SCREENS.exceptions: { "GET /api/health": "the reason no person calls it" }. An exception without a reason, or for a
// route that does not exist, is a finding: the list cannot hide a stale entry.
// Exit 0 every route covered or excepted, 1 a route without a screen or a bad exception, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const { args, loadConfig } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** The shape of a path as a source string writes it: parameters become :p, a trailing query is dropped. @param {string} p */
const shape = (p) => p.replace(/([^/])\$\{[^}]+\}$/, '$1').replace(/\$\{[^}]+\}/g, ':p').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').split('?')[0];

/** @param {string} dir @returns {string[]} */
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'i18n' || e.name.startsWith('.') ? [] : sources(p);
  return /\.(tsx?|jsx?|vue|svelte)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [p] : [];
});

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;
  const { opt, flag, positional } = args(argv, ['--repo', '--routes', '--client']);
  if (positional.length) { console.error(`screen-coverage: unexpected argument ${positional.join(' ')}`); return 2; }
  const repo = path.resolve(opt('--repo', '.'));
  const S = /** @type {{ routeTable?: string, clientDir?: string, exceptions?: Record<string, string> }} */ (loadConfig(repo).SCREENS || {});
  const routeFile = path.resolve(repo, opt('--routes', S.routeTable || ''));
  const clientDir = path.resolve(repo, opt('--client', S.clientDir || ''));
  if (!S.routeTable && !opt('--routes')) { console.error('screen-coverage: no route table: --routes <file> or SCREENS.routeTable in factory.config.json'); return 2; }
  if (!S.clientDir && !opt('--client')) { console.error('screen-coverage: no screens folder: --client <dir> or SCREENS.clientDir in factory.config.json'); return 2; }
  /** @type {Array<{ method: string, path: string }>} */
  let routes;
  try { routes = JSON.parse(fs.readFileSync(routeFile, 'utf8')); } catch (e) { console.error(`screen-coverage: cannot read ${routeFile}: ${e instanceof Error ? e.message : e}`); return 2; }
  if (!Array.isArray(routes) || !routes.length) { console.error(`screen-coverage: ${routeFile} holds no route`); return 2; }
  if (!fs.existsSync(clientDir)) { console.error(`screen-coverage: ${clientDir} does not exist`); return 2; }
  const exceptions = S.exceptions || {};

  const called = sources(clientDir).map(f => {
    const src = fs.readFileSync(f, 'utf8');
    // template literals read whole (a ${...} may hold quotes), plain strings up to their quote
    const paths = new Set([...src.matchAll(/`(\/[^`\s]*)`|'(\/[^'\s]*)'|"(\/[^"\s]*)"/g)].map(m => shape(m[1] ?? m[2] ?? m[3])));
    return { src, paths };
  });
  const hasMethod = (/** @type {string} */ src, /** @type {string} */ m) => src.includes(`'${m}'`) || src.includes(`"${m}"`) || new RegExp(`\\b${m.toLowerCase()}\\s*\\(`).test(src);
  const findings = [];
  for (const r of routes) {
    const key = `${String(r.method).toUpperCase()} ${r.path}`;
    if (key in exceptions) continue;
    const want = shape(r.path), last = want.split('/').pop() || '';
    const generic = last.startsWith(':') ? null : want.replace(/\/[^/]+$/, '/:p');
    const hit = called.some(c => (c.paths.has(want) || (generic !== null && c.paths.has(generic) && (c.src.includes(`'${last}'`) || c.src.includes(`"${last}"`))))
      && (key.startsWith('GET ') || hasMethod(c.src, key.split(' ')[0])));
    if (!hit) findings.push({ kind: 'NOSCREEN', route: key, text: 'no screen calls it: build the screen, or name it in SCREENS.exceptions with the reason' });
  }
  for (const [k, why] of Object.entries(exceptions)) {
    if (!routes.some(r => `${String(r.method).toUpperCase()} ${r.path}` === k)) findings.push({ kind: 'STALE', route: k, text: 'an exception for a route that does not exist' });
    else if (!String(why || '').trim()) findings.push({ kind: 'NOREASON', route: k, text: 'an exception without its reason' });
  }
  if (flag('--json')) console.log(JSON.stringify({ routes: routes.length, screens: called.length, findings }, null, 2));
  else {
    for (const f of findings) console.log(`FAIL  ${f.kind.padEnd(9)} ${f.route}: ${f.text}`);
    console.log(`screen-coverage: ${routes.length} route(s), ${Object.keys(exceptions).length} named exception(s), ${called.length} screen file(s): ${findings.length ? findings.length + ' finding(s)' : 'every route has a screen'}`);
  }
  return findings.length ? 1 : 0;
}

module.exports = { main, shape };
if (require.main === module) cli(main);
