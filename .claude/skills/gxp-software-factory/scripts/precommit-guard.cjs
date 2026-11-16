#!/usr/bin/env node
// Looks at what is about to be committed (everything that differs from HEAD, untracked files included) for the mistakes
// that are invisible in a green test run.
//
//   node precommit-guard.cjs [--repo .] [--base HEAD] [--allow-skip] [--max-mb 5] [--json]
//
// FAIL (exit 1):
//   TEMP          a line carrying the marker FACTORY-TEMP, or a forced branch "if (true)" / "if (false)" added in this change.
//                 Convention: every temporary edit made for an experiment carries the comment FACTORY-TEMP, so it cannot be committed.
//                 (A manual may name the marker: in a Markdown file, the marker written inside backticks is not a finding.)
//   FOCUSED       .only( / fit( / fdescribe( added: the rest of the suite silently stops running
//   SKIPPED       .skip( / xit( / xdescribe( / it.todo( / @pytest.mark.skip added (allowed only with --allow-skip, and then named in the gate record)
//   DEBUGGER      a "debugger" statement added
//   SECRET        a private key block or a token-shaped string added
//   JUNK          .env, key and certificate files, logs, dumps, backups, dependency or build output, or a file larger than --max-mb
// WARN:
//   SWALLOWED     source-like files that a .gitignore rule hides (the rule "build/" once hid validation/build/)
//   ASSERTIONS    more assertion lines removed than added in test files: say why in the gate record
//   PASSWORD      a quoted literal assigned to a password-like name (test fixtures are fine; real ones are not)
// Why: each of these went wrong, or nearly did, on the source project, and none of them makes a test fail.
const fs = require('fs');
const path = require('path');
const { args, gitTry, isGit, statusEntries } = require('./lib/common.cjs');
const { cli } = require('./lib/runtime.cjs');

/** @param {string[]} argv @param {import('./lib/runtime.cjs').IO} io @returns {number | void} */
function main(argv, io) {
  const console = io.console;

  const { opt, flag, positional } = args(argv, ['--repo', '--base', '--max-mb']);
  // a bare argument was once taken for the project folder and silently ignored: the guard then checked the whole repository
  if (positional.length) { console.error(`precommit-guard: unexpected argument ${positional.join(' ')} (the project is --repo <folder>)`); return io.exit(2); }
  const repo = path.resolve(opt('--repo', '.'));
  const base = opt('--base', 'HEAD');
  const maxBytes = (parseFloat(opt('--max-mb', '5')) || 5) * 1048576;
  if (!isGit(repo)) { console.error(`precommit-guard: ${repo} is not a git repository`); io.exit(2); }

  const fails = [], warns = [];
  const F = (kind, where, text) => { if (!fails.some(x => x.kind === kind && x.where === where)) fails.push({ kind, where, text: String(text).trim().slice(0, 160) }); };
  const W = (kind, where, text) => warns.push({ kind, where, text: String(text).trim().slice(0, 160) });

  // added and removed lines per file (tracked changes), and the whole text of untracked files
  const added = [], removed = [];
  const diff = gitTry(repo, ['diff', '--no-color', '--unified=0', '--no-renames', '--relative', base]) || '';   // --relative: this project's folder only
  let file = null, ln = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { ln = parseInt(h[1], 10); continue; }
    if (!file || file === '/dev/null') continue;
    if (l.startsWith('+')) { added.push({ file, ln, text: l.slice(1) }); ln++; }
    else if (l.startsWith('-')) removed.push({ file, text: l.slice(1) });
  }
  const status = statusEntries(repo, ['-uall', '--ignored']).map(e => `${e.code} ${e.file}`);
  const untracked = status.filter(l => l.startsWith('?? ')).map(l => l.slice(3).replace(/^"|"$/g, ''));
  const ignored = status.filter(l => l.startsWith('!! ')).map(l => l.slice(3).replace(/^"|"$/g, ''));
  const changedFiles = [...new Set([...added.map(a => a.file), ...untracked])];
  const isText = (f) => /\.(c|m)?(j|t)sx?$|\.(py|rb|go|rs|java|cs|sql|sh|ps1|json|ya?ml|md|txt|html|css|toml|ini|cfg)$/i.test(f);
  for (const f of untracked) {
    const abs = path.join(repo, f);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile() && st.size < 1 << 20 && isText(f)) fs.readFileSync(abs, 'utf8').split('\n').forEach((text, i) => added.push({ file: f, ln: i + 1, text }));
  }

  const isTest = (f) => /(^|\/)(tests?|__tests__|spec|e2e)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);
  const selfSkill = (f) => /(^|\/)skills\/[^/]+\/(scripts|references|assets)\//.test(f) || /precommit-guard|selftest/.test(f);   // the guard's own patterns and fixtures
  for (const a of added) {
    const where = `${a.file}:${a.ln}`, t = a.text;
    if (selfSkill(a.file)) continue;
    if (/FACTORY-TEMP/.test(/\.(md|markdown)$/i.test(a.file) ? t.replace(/`[^`]*`/g, '') : t)) F('TEMP', where, t);   // in a Markdown file, the marker inside backticks is a mention of the rule, not a use of it
    if (/\bif\s*\(\s*(true|false)\s*\)/.test(t) && !/^\s*(\/\/|\*|#)/.test(t)) F('TEMP', where, t);
    if (/\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/.test(t)) F('FOCUSED', where, t);
    if (/\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\b(?:it|test)\.todo\s*\(|@pytest\.mark\.skip|@unittest\.skip|@Disabled\b|@Ignore\b/.test(t) && !flag('--allow-skip')) F('SKIPPED', where, t);
    if (/^\s*debugger\s*;?\s*$/.test(t)) F('DEBUGGER', where, t);
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(t)) F('SECRET', where, 'private key block');
    else if (/\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35})\b/.test(t)) F('SECRET', where, 'token-shaped string');
    else if (/\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i.test(t) && !isTest(a.file) && !/example|placeholder|changeme|your[_-]|<|\$\{/i.test(t)) W('PASSWORD', where, t.replace(/(['"])[^'"]{4}[^'"]*\1/, '$1****$1'));
  }
  // build and dependency output: only as the FIRST path segment (scripts/release/ is source), except folders that are junk anywhere
  const JUNK = /^(dist|dist-server|release|coverage|out|\.cache)\/|(^|\/)(node_modules|__pycache__)\//;
  const JUNK_FILE = /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$|\.(pem|key|pfx|p12|jks|log|dump|bak|sqlite|sqlite3)$|(^|\/)id_(rsa|ed25519|ecdsa)$/i;
  for (const f of changedFiles) {
    if (JUNK.test(f)) F('JUNK', f, 'dependency or build output');
    else if (JUNK_FILE.test(f) && !/public[-_]?key\.pem$/i.test(f)) F('JUNK', f, 'secret, log, dump or backup file');
    else { try { const s = fs.statSync(path.join(repo, f)); if (s.isFile() && s.size > maxBytes) F('JUNK', f, `${(s.size / 1048576).toFixed(1)} MB (limit ${maxBytes / 1048576} MB)`); } catch { /* deleted */ } }
  }
  // source-like files hidden by an ignore rule: only when their FIRST path segment is not a junk folder
  const TOP_JUNK = /^(node_modules|dist|dist-server|build|release|coverage|out|target|\.cache|\.venv|venv|__pycache__|\.next|\.turbo|tmp|temp|backups?)\//;
  const swallowed = ignored.filter(f => !TOP_JUNK.test(f) && !/(^|\/)(node_modules|__pycache__|\.git)\//.test(f) && (f.endsWith('/') ? !/(^|\/)(dist|coverage|\.cache|logs?)\/$/.test(f) : isText(f) && !JUNK_FILE.test(f)));
  for (const f of swallowed.slice(0, 40)) W('SWALLOWED', f, 'hidden by a .gitignore rule: is that intended?');
  if (swallowed.length > 40) W('SWALLOWED', `${swallowed.length - 40} more`, 'not listed: a source folder may be among them (git status --ignored)');
  const ASSERT = /\b(?:expect|assert[A-Za-z.]*|should)\s*[.(]/;
  const testFiles = new Set([...added, ...removed].filter(x => isTest(x.file)).map(x => x.file));
  for (const f of testFiles) {
    const plus = added.filter(a => a.file === f && ASSERT.test(a.text)).length, minus = removed.filter(r => r.file === f && ASSERT.test(r.text)).length;
    if (minus > plus) W('ASSERTIONS', f, `${minus} assertion line(s) removed, ${plus} added`);
  }

  if (flag('--json')) { console.log(JSON.stringify({ ok: !fails.length, files: changedFiles.length, fails, warns }, null, 2)); io.exit(fails.length ? 1 : 0); }
  console.log(`${changedFiles.length} changed or new file(s), ${added.length} added line(s) checked against ${base}`);
  for (const [title, list] of [['FAIL', fails], ['WARN', warns]]) for (const x of list) console.log(`  ${title} ${x.kind.padEnd(10)} ${x.where}  ${x.text}`);
  console.log(fails.length ? `\n${fails.length} thing(s) must not be committed.` : `\nNothing blocks the commit${warns.length ? ` (${warns.length} warning(s): read them)` : ''}.`);
  io.exit(fails.length ? 1 : 0);
}

module.exports = { main };
if (require.main === module) cli(main);
