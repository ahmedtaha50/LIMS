#!/usr/bin/env node
// The PowerShell mistakes that cost the source project a CI cycle each, and that no Linux run can show.
//
//   node ps1-lint.cjs [--repo .] [<file or folder>...]          (default: every .ps1 under the repository)
//
// FAIL (exit 1):
//   VARCOLON   "$name:" inside a double-quoted string: PowerShell reads $name: as a drive or scope qualifier ($env:...),
//              so the string breaks at parse time. Write "${name}:" (scope prefixes env, global, script, local, using,
//              private, variable, function are fine).
//   PSQLORDER  a psql call with an option after the connection address: psql on Windows ignores options that follow it
//              ("extra command-line argument ignored"), so -v ON_ERROR_STOP=1 or -c silently do nothing. Options first.
//   PSQLSTOP   a psql call that runs SQL (-c or -f) without -v ON_ERROR_STOP=1: a failed statement still exits 0.
// Exit 0 clean, 1 findings, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const { args } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

const SCOPES = new Set(['env', 'global', 'script', 'local', 'using', 'private', 'variable', 'function', 'alias', 'workflow']);

/** @param {string} p @returns {string[]} */
const ps1 = (p) => {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return p.endsWith('.ps1') ? [p] : [];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap(e => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : ps1(path.join(p, e.name))));
};

/** The findings of one script. @param {string} text @returns {Array<{ line: number, kind: string, text: string }>} */
function lint(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '');           // a comment is not code
    for (const s of line.matchAll(/"((?:[^"`]|`.)*)"/g)) {
      for (const m of s[1].matchAll(/(?<!`)\$([A-Za-z_][A-Za-z0-9_]*):(?!:)/g)) {
        if (!SCOPES.has(m[1].toLowerCase())) out.push({ line: i + 1, kind: 'VARCOLON', text: `"$${m[1]}:" is read as a scope or drive: write "\${${m[1]}}:"` });
      }
    }
    if (/\bpsql(\.exe)?\b/i.test(line)) {
      const tokens = [...line.matchAll(/'[^']*'|"[^"]*"|\S+/g)].map(t => t[0]);
      const start = tokens.findIndex(t => /psql(\.exe)?['"]?$/i.test(t) || /^\$psql$/i.test(t));
      const rest = start > -1 ? tokens.slice(start + 1) : tokens;
      const at = rest.findIndex(t => /^['"]?postgres(ql)?:\/\//.test(t));
      const end = rest.findIndex(t => t === '|' || t === ';' || t === ')' || t === '}');
      const after = at > -1 ? rest.slice(at + 1, end > at ? end : undefined) : [];
      const late = after.find(t => /^-{1,2}[A-Za-z]/.test(t));
      if (late) out.push({ line: i + 1, kind: 'PSQLORDER', text: `${late} follows the connection address: psql on Windows ignores it; put the options first` });
      if (rest.some(t => t === '-c' || t === '-f' || /^-[A-Za-z]*c$/.test(t)) && !/ON_ERROR_STOP=(1|on)/i.test(line)) out.push({ line: i + 1, kind: 'PSQLSTOP', text: 'runs SQL without -v ON_ERROR_STOP=1: a failed statement exits 0' });
    }
  });
  return out;
}

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;
  const { opt, positional } = args(argv, ['--repo']);
  const repo = path.resolve(opt('--repo', '.'));
  const targets = positional.length ? positional.map(p => path.resolve(repo, p)) : [repo];
  const missing = targets.filter(t => !fs.existsSync(t));
  if (missing.length) { console.error(`ps1-lint: not found: ${missing.join(', ')}`); return 2; }
  const files = targets.flatMap(ps1);
  let n = 0;
  for (const f of files) for (const x of lint(fs.readFileSync(f, 'utf8'))) { n++; console.log(`FAIL  ${x.kind.padEnd(9)} ${path.relative(repo, f)}:${x.line}  ${x.text}`); }
  console.log(`ps1-lint: ${files.length} script(s), ${n ? n + ' finding(s)' : 'clean'}`);
  return n ? 1 : 0;
}

module.exports = { main, lint };
if (require.main === module) cli(main);
