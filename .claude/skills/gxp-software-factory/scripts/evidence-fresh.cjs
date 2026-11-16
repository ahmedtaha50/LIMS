#!/usr/bin/env node
// Is the validation evidence still about the code that is checked in?
//
//   node evidence-fresh.cjs [--repo .] [--evidence validation/evidence] [--ignore "docs/**,validation/**,.claude/**,.github/**,**/*.md"] [--json]
//
// The evidence run records the commit it was collected at (a line "git <sha>" in the newest iq-sandbox-*.txt, or "gitSha" in an
// evidence-meta*.json). This tool lists the source files that changed between that commit and HEAD.
//   FRESH    nothing but documents changed since the evidence was collected
//   STALE    source or tests changed: the RTM, the OQ and the VSR describe an older product. Collect again, or say in the
//            package and to the user which commit the documents describe.
//   UNKNOWN  the evidence does not say which commit it belongs to, or that commit is not in this repository
// Why: on the source project a fix went in after the evidence run and the generated documents kept the old result. Nothing was
// false line by line; the package as a whole described a product that no longer existed. Exit 1 unless FRESH.
const fs = require('fs');
const path = require('path');
const { args, loadConfig, matcher, gitTry, isGit } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;

  const { opt, flag } = args(argv, ['--repo', '--evidence', '--ignore']);
  const repo = path.resolve(opt('--repo', '.'));
  const evDir = path.resolve(repo, opt('--evidence', loadConfig(repo).EVIDENCE_DIR));
  const ignore = matcher(opt('--ignore', 'docs/**,validation/**,.claude/**,.github/**,**/*.md,*.md').split(',').map(s => s.trim()).filter(Boolean));
  const out = (o) => { if (flag('--json')) console.log(JSON.stringify(o, null, 2)); else print(o); io.exit(o.verdict === 'FRESH' ? 0 : 1); };
  function print(o) {
    console.log(`evidence: ${o.evidenceCommit ? o.evidenceCommit.slice(0, 10) : '(no commit recorded)'}${o.source ? ' (from ' + o.source + ')' : ''}; HEAD ${o.head ? o.head.slice(0, 10) : '?'}`);
    if (o.dates && Object.keys(o.dates).length) console.log('newest file per kind: ' + Object.entries(o.dates).map(([k, d]) => `${k} ${d}`).join(', '));
    if (o.mixedDays) console.log('note: the evidence files come from different days. Each result is from its own run; say so where it matters.');
    if (o.changed && o.changed.length) { console.log(`\n${o.changed.length} source file(s) changed since the evidence was collected:`); for (const f of o.changed.slice(0, 25)) console.log('  ' + f); if (o.changed.length > 25) console.log(`  ... and ${o.changed.length - 25} more`); }
    console.log(`\nVERDICT ${o.verdict}: ${o.message}`);
  }
  if (!isGit(repo)) out({ verdict: 'UNKNOWN', message: `${repo} is not a git repository.` });
  if (!fs.existsSync(evDir)) out({ verdict: 'UNKNOWN', message: `no evidence folder at ${path.relative(repo, evDir)}: nothing was collected.` });

  const files = fs.readdirSync(evDir).filter(f => fs.statSync(path.join(evDir, f)).isFile());
  const dateOf = (f) => (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const dates = {};
  for (const f of files) { const d = dateOf(f); if (!d) continue; const kind = f.slice(0, f.indexOf(d)).replace(/[-_.]+$/, ''); if (!dates[kind] || dates[kind] < d) dates[kind] = d; }
  let evidenceCommit = null, source = null;
  for (const f of files.filter(x => /^(iq-|evidence-meta)/.test(x)).sort((a, b) => (dateOf(b) + b).localeCompare(dateOf(a) + a))) {
    const text = fs.readFileSync(path.join(evDir, f), 'utf8');
    const m = /^git\s+([0-9a-f]{7,40})\s*$/m.exec(text) || /"gitSha"\s*:\s*"([0-9a-f]{7,40})"/.exec(text);
    if (m) { evidenceCommit = m[1]; source = f; break; }
  }
  const head = gitTry(repo, ['rev-parse', 'HEAD']);
  const mixedDays = new Set(Object.values(dates)).size > 1;
  if (!evidenceCommit) out({ verdict: 'UNKNOWN', head, dates, mixedDays, message: 'the evidence does not record its commit. Make the collection script write "git <sha>" (git rev-parse HEAD) into the IQ record.' });
  if (gitTry(repo, ['cat-file', '-e', evidenceCommit + '^{commit}']) === null) out({ verdict: 'UNKNOWN', evidenceCommit, source, head, dates, mixedDays, message: `commit ${evidenceCommit.slice(0, 10)} is not in this repository (shallow clone, or evidence from another history).` });
  const diff = gitTry(repo, ['diff', '--name-only', '--no-renames', evidenceCommit, 'HEAD']) || '';
  const changed = diff.split('\n').filter(Boolean).filter(f => !ignore(f));
  out(changed.length
    ? { verdict: 'STALE', evidenceCommit, source, head, dates, mixedDays, changed, message: 'the documents describe an older product. Collect the evidence again and regenerate, or state the commit the package describes.' }
    : { verdict: 'FRESH', evidenceCommit, source, head, dates, mixedDays, changed, message: 'no source or test file changed since the evidence was collected.' });
}

module.exports = { main };
if (require.main === module) cli(main);
