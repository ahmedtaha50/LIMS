#!/usr/bin/env node
// Commits only after the project's own checks and the pre-commit guard have passed, in ONE command, so that a failing
// check can never be followed by a commit (the source project once ran "checks ; git commit" and committed a red tree).
//
//   node checked-commit.cjs -m "<message>" [--repo .] [--config <factory.config.json>] [--all] [--check "<command>"]...
//                           [--no-guard] [--no-trailers] [--dry-run]
//
// The checks: each --check, else CHECK_COMMANDS (a list of shell commands) in factory.config.json. None at all is refused:
// a commit with no check is not a checked commit. Each runs in the repository, in order; the first that fails stops it.
// Then precommit-guard.cjs on what is about to be committed. Then the commit, with the TRAILERS lines of the config
// appended when the message lacks them; --config reads another project's config (a project in a subfolder of the repository).
// No TRAILERS anywhere is refused unless --no-trailers: two commits once went out without the session's trailers because the
// repository top had no config. --all stages everything first (git add -A); without it, the index is committed.
// Exit 0 committed (or --dry-run passed), 1 a check, the guard or git refused, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { args, loadConfig, gitTry, isGit } = require('./lib/common.cjs');
const { cli, invoke, sibling } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;
  const { opt, flag, positional } = args(argv, ['--repo', '-m', '--check', '--config']);
  const stray = positional.filter(p => p !== '-m');
  if (stray.length) { console.error(`checked-commit: unexpected argument ${stray.join(' ')} (the message is -m "<message>", a check is --check "<command>")`); return 2; }
  const repo = path.resolve(opt('--repo', '.'));
  const message = opt('-m');
  if (!message || !message.trim()) { console.error('checked-commit: -m "<message>" is required'); return 2; }
  if (!isGit(repo)) { console.error(`checked-commit: ${repo} is not a git repository`); return 2; }
  const cfgFile = opt('--config');
  let cfg;
  try { cfg = cfgFile ? { ...loadConfig(repo), ...JSON.parse(fs.readFileSync(path.resolve(cfgFile), 'utf8')) } : loadConfig(repo); }
  catch (e) { console.error(`checked-commit: cannot read ${cfgFile}: ${e instanceof Error ? e.message : e}`); return 2; }
  const given = argv.flatMap((a, i) => (a === '--check' && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const configured = Array.isArray(cfg.CHECK_COMMANDS) ? cfg.CHECK_COMMANDS.map(String) : [];
  const checks = given.length ? given : configured;
  if (!checks.length) { console.error('checked-commit: no check to run: pass --check "<command>" or set CHECK_COMMANDS in factory.config.json'); return 2; }

  if (flag('--all')) gitTry(repo, ['add', '-A']);
  const staged = gitTry(repo, ['diff', '--cached', '--name-only']);
  if (!staged) { console.error('checked-commit: nothing is staged (stage the files, or pass --all)'); return 1; }

  for (const c of checks) {
    const t0 = Date.now();
    const r = spawnSync(c, { cwd: repo, shell: true, encoding: 'utf8', maxBuffer: 256 << 20 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
    if (r.status !== 0) { console.error(`FAIL  ${c} (exit ${r.status === null ? r.signal : r.status})\n      ${out.slice(-15).join('\n      ')}\nchecked-commit: NOT committed`); return 1; }
    console.log(`PASS  ${c} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (!flag('--no-guard')) {
    const guard = sibling('precommit-guard.cjs');
    if (!guard) { console.error('checked-commit: precommit-guard.cjs is missing'); return 1; }
    const g = invoke(guard, ['--repo', repo]);
    if (g.code !== 0) { console.error(`FAIL  precommit-guard\n      ${g.out.trim().split('\n').slice(-15).join('\n      ')}\nchecked-commit: NOT committed`); return 1; }
    console.log('PASS  precommit-guard');
  }
  // the trailers the session requires, when the message does not carry them already
  const required = String(cfg.TRAILERS || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('<'));
  if (!required.length && !flag('--no-trailers')) { console.error('checked-commit: no TRAILERS in the config: pass --config <the project\'s factory.config.json>, or --no-trailers when none are required'); return 2; }
  const trailers = required.filter(l => !message.includes(l));
  const full = trailers.length ? `${message.replace(/\s+$/, '')}\n\n${trailers.join('\n')}\n` : message;
  if (flag('--dry-run')) { console.log(`checked-commit: every check passed; --dry-run, not committed:\n${full}`); return 0; }
  const r = spawnSync('git', ['commit', '-q', '-F', '-'], { cwd: repo, input: full, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`checked-commit: git commit failed\n${(r.stdout || '') + (r.stderr || '')}`); return 1; }
  console.log(`checked-commit: committed ${gitTry(repo, ['rev-parse', '--short', 'HEAD'])} after ${checks.length} check(s)${flag('--no-guard') ? '' : ' and the guard'}`);
  return 0;
}

module.exports = { main };
if (require.main === module) cli(main);
