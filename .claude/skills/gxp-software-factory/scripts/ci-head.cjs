#!/usr/bin/env node
// Refuses a CI result that is not the result of HEAD. On the source project CI was red for five pushes while the status
// report said green: the run that had been read was an earlier commit's.
//
//   node ci-head.cjs <run.json> [--repo .] [--allow-pending]
//   node ci-head.cjs --sha <sha> --conclusion <success|failure|...> [--status completed] [--repo .]
//
// run.json: a workflow run as the GitHub API or MCP tools return it ({ head_sha, status, conclusion, html_url, ... }),
// or a list of them / { workflow_runs: [...] } (each is checked; the newest for HEAD decides). "-" reads standard input.
// FAIL (exit 1): no run for HEAD (the runs read belong to other commits), HEAD not pushed to its upstream, the run of HEAD
// still running (unless --allow-pending, then exit 3) or not successful. Exit 0 only for a completed, successful run of HEAD.
'use strict';
const fs = require('fs');
const path = require('path');
const { args, gitTry, isGit } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;
  const { opt, flag, positional } = args(argv, ['--repo', '--sha', '--conclusion', '--status']);
  const repo = path.resolve(opt('--repo', '.'));
  if (!isGit(repo)) { console.error(`ci-head: ${repo} is not a git repository`); return 2; }
  /** @type {Array<{ head_sha?: string, status?: string, conclusion?: string | null, html_url?: string, created_at?: string, name?: string }>} */
  let runs;
  if (opt('--sha')) runs = [{ head_sha: opt('--sha'), conclusion: opt('--conclusion', ''), status: opt('--status', 'completed') }];
  else if (positional.length === 1) {
    let raw;
    try { raw = JSON.parse(positional[0] === '-' ? io.stdin() : fs.readFileSync(positional[0], 'utf8')); } catch (e) { console.error(`ci-head: cannot read the run: ${e instanceof Error ? e.message : e}`); return 2; }
    runs = Array.isArray(raw) ? raw : Array.isArray(raw.workflow_runs) ? raw.workflow_runs : [raw];
  } else { console.error('ci-head: give one run file (or -), or --sha <sha> --conclusion <c>'); return 2; }

  const head = gitTry(repo, ['rev-parse', 'HEAD']);
  if (!head) { console.error('ci-head: the repository has no commit'); return 2; }
  const fails = [];
  const upstream = gitTry(repo, ['rev-parse', '--verify', '--quiet', '@{u}']);
  if (upstream === null) fails.push('HEAD has no upstream branch: push it (git push -u origin <branch>) and read the run of that push');
  else if (gitTry(repo, ['merge-base', '--is-ancestor', 'HEAD', '@{u}']) === null) fails.push(`HEAD ${head.slice(0, 7)} is not pushed: CI has not run on it`);

  const mine = runs.filter(r => r.head_sha && (head.startsWith(r.head_sha) || r.head_sha.startsWith(head)))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!mine.length) {
    const others = [...new Set(runs.map(r => String(r.head_sha || '?').slice(0, 7)))].join(', ');
    fails.push(`no run of HEAD ${head.slice(0, 7)}: the run(s) read belong to ${others || 'no commit'}; their result says nothing about HEAD`);
  } else {
    const r = mine[0];
    const where = r.html_url ? ` (${r.html_url})` : '';
    if (r.status && r.status !== 'completed') {
      if (flag('--allow-pending') && !fails.length) { console.log(`ci-head: the run of HEAD ${head.slice(0, 7)} is ${r.status}${where}: wait for it`); return 3; }
      fails.push(`the run of HEAD is ${r.status}${where}: green is not known yet`);
    } else if (r.conclusion !== 'success') fails.push(`the run of HEAD ended ${r.conclusion || 'without a conclusion'}${where}`);
  }
  if (fails.length) { for (const f of fails) console.error(`FAIL  ${f}`); console.error('ci-head: do NOT report CI as green'); return 1; }
  console.log(`PASS  the run of HEAD ${head.slice(0, 7)} completed successfully${mine[0].html_url ? ' (' + mine[0].html_url + ')' : ''}`);
  return 0;
}

module.exports = { main };
if (require.main === module) cli(main);
