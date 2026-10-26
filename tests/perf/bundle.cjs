#!/usr/bin/env node
/**
 * Bundle report (roadmap M43): the JavaScript a first visit downloads, measured on dist/ (run `npx vite build` first).
 *
 *   node tests/perf/bundle.cjs [dist-dir]        prints the table; exit code 1 when the first load is over the budget
 *
 * "First load" is the entry script of index.html plus every chunk it imports statically, plus the chunk(s) of the screen the application
 * opens first after sign-in (#/samples) with their static imports. Chunks reached only through import() (the other screens, the PDF,
 * chart and scanner libraries, the palette) are lazy and are listed separately. Sizes are raw bytes on disk (not gzip).
 */
const fs = require('fs');
const path = require('path');

const BUDGET_BYTES = 700 * 1024;
const HOME_SCREEN = 'Samples';

function analyse(dist) {
  const read = f => fs.readFileSync(path.join(dist, f), 'utf8');
  const html = read('index.html');
  const entry = (html.match(/<script[^>]+type="module"[^>]+src="\/?([^"]+)"/) || [])[1];
  if (!entry) throw new Error('index.html has no module script');
  const files = fs.readdirSync(path.join(dist, 'assets')).filter(f => f.endsWith('.js')).map(f => `assets/${f}`);
  const size = f => fs.statSync(path.join(dist, f)).size;
  const staticImports = f => {
    const src = read(f);
    const found = new Set();
    // import{a as b}from"./x.js"  /  import"./x.js"  /  export{..}from"./x.js"   (a dynamic import( is not matched)
    for (const m of src.matchAll(/(?:^|[;}\n])\s*(?:import|export)\s*(?:[^"'()]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g)) found.add(`assets/${m[1]}`);
    return [...found].filter(x => files.includes(x));
  };
  const closure = roots => {
    const seen = new Set();
    const walk = f => { if (seen.has(f)) return; seen.add(f); for (const d of staticImports(f)) walk(d); };
    roots.forEach(walk);
    return seen;
  };
  const home = files.filter(f => path.basename(f).startsWith(`${HOME_SCREEN}-`));
  const first = closure([entry, ...home]);
  const entryOnly = closure([entry]);
  const sum = set => [...set].reduce((n, f) => n + size(f), 0);
  const lazy = files.filter(f => !first.has(f)).map(f => ({ file: f, bytes: size(f) })).sort((a, b) => b.bytes - a.bytes);
  return { entry, firstLoad: [...first].map(f => ({ file: f, bytes: size(f) })).sort((a, b) => b.bytes - a.bytes), firstLoadBytes: sum(first), entryBytes: sum(entryOnly), lazy, totalBytes: files.reduce((n, f) => n + size(f), 0) };
}

module.exports = { analyse, BUDGET_BYTES };

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || 'dist');
  const r = analyse(dist);
  const kb = n => `${(n / 1024).toFixed(1)} KB`;
  console.log(`entry ${r.entry}: ${kb(r.entryBytes)} with its static imports`);
  console.log(`first load (entry + the ${HOME_SCREEN} screen): ${kb(r.firstLoadBytes)}   budget ${kb(BUDGET_BYTES)}   all JS on disk ${kb(r.totalBytes)}`);
  for (const f of r.firstLoad) console.log(`  first   ${kb(f.bytes).padStart(10)}  ${f.file}`);
  for (const f of r.lazy.slice(0, 12)) console.log(`  lazy    ${kb(f.bytes).padStart(10)}  ${f.file}`);
  process.exit(r.firstLoadBytes <= BUDGET_BYTES ? 0 : 1);
}
