#!/usr/bin/env node
// Turns the log of a CI job, or of a local run, into: what failed, the lines that say why, the test totals, and what KIND
// of failure it is. The kind decides the next move, so decide it from the log, not from "red" or "green".
//
//   node ci-log-digest.cjs <log file> [more files] [--context 12] [--json] [--ci | --local]
//   <command> 2>&1 | node ci-log-digest.cjs -
//
// A log file may be raw text (GitHub Actions raw log, gh run view --log, the saved output of a local command) or the JSON a
// GitHub MCP tool saves ({ "logs_content": "..." } or { "logs": [{ "job_name", "logs_content" }] }).
// Without --ci / --local the tool decides: a text with GitHub markers (##[group], ##[error]) or nearly empty is a CI log.
//
// Kinds, in the order they are looked for (environment first: a dead database makes hundreds of tests fail, and none of
// those failures says anything about the product):
//   NEVER_STARTED          CI only: no step ran. The account (minutes, spending limit, private repository), not the code
//   ENV_SERVICE_DOWN       a service the run needs does not answer (connection refused)
//   ENV_DB_SETUP           the database answers, but the role, password or database is not what the run expects
//   ENV_CONFIG             the program refused its configuration (a missing or too-short variable)
//   ENV_PORT_BUSY          the port is taken
//   ENV_TOOL_MISSING       a tool the run needs is not installed
//   INFRA_DOWNLOAD         an external download or registry failed: re-run once, then remove the dependency
//   TIMEOUT                a step hit its limit: find why it hangs; an informative step that times out is not evidence
//   RUNNER_RESOURCES       disk or memory
//   UNHANDLED_AFTER_GREEN  every test passed, the process still failed on an unhandled error: fix its source
//   MISSING_FILE           an expected file is absent: quoting, packaging output, or a silently skipped download
//   BUILD_ERROR            compile, type or module resolution error
//   TEST_FAILURE           a real failing test: reproduce under the same conditions, never weaken the assertion
//   UNKNOWN_ERROR          an error without a known signature: read the context printed below
//   OK                     nothing failed
// A green suite outranks environment words in the text: tests of a refusal print "password authentication failed" on purpose.
const fs = require('fs');

const argv = process.argv.slice(2);
const context = (() => { const i = argv.indexOf('--context'); return i > -1 ? Math.max(0, parseInt(argv[i + 1], 10) || 12) : 12; })();
const asJson = argv.includes('--json');
const forced = argv.includes('--ci') ? 'ci' : argv.includes('--local') ? 'local' : null;
const inputs = argv.filter((a, i) => !['--json', '--context', '--ci', '--local'].includes(a) && argv[i - 1] !== '--context');
if (!inputs.length) { console.error('usage: node ci-log-digest.cjs <log file | -> [more] [--context N] [--json] [--ci|--local]'); process.exit(2); }

const ADVICE = {
  NEVER_STARTED: 'No step ran. This is the CI account (Actions minutes, spending limit, private-repository billing, disabled Actions), not the code. Re-running does not help: tell the user where to look.',
  ENV_SERVICE_DOWN: 'A service the run needs is not answering (database, server). This is the environment, not the product: start the service, prove it with one command, then run again. Do not read the test failures of this run.',
  ENV_DB_SETUP: 'The database answers, but the role, the password or the database is not what the run expects. Fix the credentials or create the database. Do not change product code.',
  ENV_CONFIG: 'The program refused its configuration (a missing or too-short variable). Give this run a valid value. A refusal with a clear message is the product working as designed.',
  ENV_PORT_BUSY: 'The port is taken, often by your own earlier run. Stop that process by its PID or use another port. Never kill processes broadly.',
  ENV_TOOL_MISSING: 'A tool the run needs is not installed here. Install it, or leave the check out and say it was not run.',
  INFRA_DOWNLOAD: 'An external download or registry failed. Re-run the failed job once. If it fails the same way, remove the dependency on that download (use what is already installed, add a retry step that also verifies the file) instead of re-running again. Do not switch to an unreviewed mirror on your own.',
  TIMEOUT: 'A step hit its time limit. Find why it hangs before touching the limit. An informative (continue-on-error) step that times out proves nothing: do not cite it as evidence.',
  RUNNER_RESOURCES: 'The machine ran out of disk or memory. Reduce what the job downloads or builds, or free space first.',
  UNHANDLED_AFTER_GREEN: 'Every test passed but the run failed on an unhandled error (often a connection ended during teardown). Fix the source of the unhandled error; the exit code is right, do not mask it.',
  MISSING_FILE: 'A file the step expected is not there. Check shell quoting (PowerShell splits "-c.key=value"), the packaging output path, and whether an earlier download was skipped without an error.',
  BUILD_ERROR: 'Compile, type or module error. Fix the code; if it only fails in CI, compare tool versions and the lockfile.',
  TEST_FAILURE: 'Real test failure. Reproduce it under the same conditions (in CI: not root, ICU collation, localhost = ::1, another time zone) before changing anything. Never weaken or skip the assertion.',
  UNKNOWN_ERROR: 'An error without a known signature. Read the context below and the last lines of the failing step.',
  OK: 'Nothing failed in this log. If the job is red anyway, the failing step is in another job: digest that log too.',
};
const ENV = ['ENV_SERVICE_DOWN', 'ENV_DB_SETUP', 'ENV_CONFIG', 'ENV_PORT_BUSY', 'ENV_TOOL_MISSING'];

const RULES = [
  ['ENV_SERVICE_DOWN', /ECONNREFUSED|Connection refused|could not connect to server|connection to server (?:at|on) .{1,80} failed|Is the server running|server closed the connection unexpectedly/i],
  ['ENV_DB_SETUP', /password authentication failed|no password supplied|role "[^"]+" does not exist|database "[^"]+" does not exist|permission denied to create database/i],
  ['ENV_CONFIG', /invalid configuration|must be at least \d+ characters|environment variable \S+ (?:is )?(?:not set|missing|required)|Missing required (?:env|environment)/i],
  ['ENV_PORT_BUSY', /EADDRINUSE|address already in use|port \d+ is already in use/i],
  ['ENV_TOOL_MISSING', /: command not found|is not recognized as an internal or external command|spawn \S+ ENOENT|: not found\s*$|Executable doesn't exist at/im],
  ['INFRA_DOWNLOAD', /status code 5\d\d|cannot resolve https?:\/\/|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|Could not resolve host|50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|Failed to connect to|rate limit exceeded|TLS handshake timeout|unexpected EOF.*(?:download|fetch)|network timeout at/i],
  ['TIMEOUT', /has timed out after|exceeded the maximum execution time|The operation was canceled|timed out after \d+ ?(?:ms|s|minutes)/i],
  ['RUNNER_RESOURCES', /No space left on device|ENOSPC|JavaScript heap out of memory|^Killed\s*$|out of memory/im],
  ['MISSING_FILE', /ENOENT: no such file or directory|is missing after|cannot find the file|The system cannot find the (?:file|path)/i],
  ['BUILD_ERROR', /error TS\d+:|SyntaxError:|Cannot find module|Module not found|error: could not compile|ERR_MODULE_NOT_FOUND/],
  ['TEST_FAILURE', /^not ok \d+|^\s*(?:FAIL|✗|×)\s|AssertionError|Expected .* (?:to|but)|^# fail [1-9]|Tests?\s+\d+ failed|\d+ failed,? /m],
];
const KEY = /⨯|\berror\b|Error:|cannot |\bfailed\b|^not ok|status code|refused|denied|ENOENT|EADDRINUSE|timed out|is missing|does not exist|not found|FAIL\b|must be at least/i;

function readInput(f) {
  const text = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8');
  const jobs = [];
  try {
    const j = JSON.parse(text);
    if (j && typeof j.logs_content === 'string') jobs.push({ name: j.job_name || (j.job_id ? 'job ' + j.job_id : f), text: j.logs_content });
    else if (j && Array.isArray(j.logs)) for (const l of j.logs) jobs.push({ name: l.job_name || 'job ' + l.job_id, text: String(l.logs_content || '') });
    else if (j && Array.isArray(j.jobs)) for (const l of j.jobs) jobs.push({ name: l.name || 'job ' + l.id, text: String(l.logs_content || l.log || '') });
  } catch { /* raw text */ }
  if (!jobs.length) jobs.push({ name: f === '-' ? '(stdin)' : f, text });
  return jobs;
}
const clean = (s) => s.replace(/\r/g, '').split('\n').map(l => l.replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
const keyLines = (body) => body.filter(l => KEY.test(l) && !/^\s+at\s/.test(l) && !/^\s*(?:github\.com|runtime\.|\/Users\/runner)/.test(l)).map(l => l.trim()).filter((l, i, a) => a.indexOf(l) === i).slice(0, 8);

function testTotals(lines) {
  const all = lines.join('\n');
  const tests = [];
  const vt = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?/.exec(all);
  if (vt) tests.push({ runner: 'vitest', passed: +vt[2], failed: +(vt[1] || 0), skipped: +(vt[3] || 0), errors: +((/Errors\s+(\d+) error/.exec(all) || [])[1] || 0) });
  for (const m of all.matchAll(/^# pass (\d+)\n# fail (\d+)/gm)) tests.push({ runner: 'node:test', passed: +m[1], failed: +m[2] });
  const jest = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed/.exec(all);
  if (jest && !vt) tests.push({ runner: 'jest', passed: +jest[3], failed: +(jest[1] || 0), skipped: +(jest[2] || 0) });
  const py = /=+ (?:(\d+) failed, )?(\d+) passed(?:, (\d+) skipped)?[^=\n]*=+/.exec(all);
  if (py) tests.push({ runner: 'pytest', passed: +py[2], failed: +(py[1] || 0), skipped: +(py[3] || 0) });
  const passLines = lines.filter(l => /^PASS\s/.test(l)).length, failLines = lines.filter(l => /^FAIL\s/.test(l));
  if (passLines || failLines.length) tests.push({ runner: 'PASS/FAIL lines', passed: passLines, failed: failLines.length });
  const failedTests = [...lines.filter(l => /^not ok \d+ - /.test(l)).map(l => l.replace(/^not ok \d+ - /, '')), ...failLines.map(l => l.replace(/^FAIL\s+/, ''))].filter((t, i, a) => a.indexOf(t) === i).slice(0, 25);
  return { tests, failedTests, all };
}

function digest(job) {
  const lines = clean(job.text);
  const nonEmpty = lines.filter(l => l.trim()).length;
  const hasMarkers = lines.some(l => /^##\[(?:group|error|endgroup|warning)\]/.test(l));
  const mode = forced || (hasMarkers || nonEmpty < 5 ? 'ci' : 'local');
  const { tests, failedTests, all } = testTotals(lines);
  const greenTests = tests.length > 0 && tests.every(t => !t.failed);
  const anyFailedTest = tests.some(t => t.failed);
  let verdict = 'OK', failing = [], stepsRun = 0;

  if (mode === 'ci') {
    // steps: a "##[group]Run ..." line opens one; everything before the first is set-up
    const steps = [];
    let cur = { title: '(job set-up)', lines: [] };
    for (const l of lines) { const m = /^##\[group\]Run (.*)$/.exec(l); if (m) { steps.push(cur); cur = { title: m[1].trim().slice(0, 160), lines: [] }; } cur.lines.push(l); }
    steps.push(cur);
    stepsRun = steps.length - 1;
    for (const s of steps) {
      const errIdx = s.lines.map((l, i) => (/^##\[error\]/.test(l) ? i : -1)).filter(i => i > -1);
      if (!errIdx.length) continue;
      const body = s.lines.slice(0, errIdx[0]).filter(l => l.trim() && !/^##\[(?:group|endgroup)\]/.test(l));
      const text = s.lines.join('\n');
      const named = errIdx.map(i => (/The action '([^']+)'/.exec(s.lines[i]) || [])[1]).find(Boolean);
      const stepTests = testTotals(s.lines).tests;
      const stepGreen = stepTests.length > 0 && stepTests.every(t => !t.failed);
      // environment words inside a step whose own tests are green come from tests of a refusal, not from the environment
      const classes = RULES.filter(([k, re]) => re.test(text) && !(stepGreen && ENV.includes(k))).map(([k]) => k);
      failing.push({ step: named || s.title, errors: errIdx.map(i => s.lines[i].replace(/^##\[error\]/, '').trim()), key: keyLines(body), context: body.slice(-context), classes, text });
    }
    if (!stepsRun && nonEmpty < 5) verdict = 'NEVER_STARTED';
    else if (failing.length) verdict = (/Unhandled (?:Error|Rejection)|Uncaught Exception/.test(all) && greenTests) ? 'UNHANDLED_AFTER_GREEN' : (failing[0].classes[0] || 'UNKNOWN_ERROR');
    else if (!stepsRun) verdict = 'NEVER_STARTED';
  } else {
    // a local run: one block. An environment class counts only when something actually failed.
    const errorish = lines.filter(l => /^(?:Error|error|ERROR|npm ERR!|fatal):?\s|exit(?:ed with)? code [1-9]|^\s*(?:Uncaught|Unhandled)\b/.test(l));
    const classes = RULES.filter(([, re]) => re.test(all)).map(([k]) => k);
    const hard = anyFailedTest || errorish.length > 0 || classes.some(k => !ENV.includes(k) && k !== 'TEST_FAILURE');
    if (/Unhandled (?:Error|Rejection)|Uncaught Exception/.test(all) && greenTests) verdict = 'UNHANDLED_AFTER_GREEN';
    else if (greenTests && !errorish.length && !classes.some(k => !ENV.includes(k))) verdict = 'OK';
    else if (classes.length && (hard || !tests.length)) verdict = classes[0];
    else if (errorish.length) verdict = 'UNKNOWN_ERROR';
    if (verdict !== 'OK') {
      const body = lines.filter(l => l.trim());
      failing.push({ step: '(local run)', errors: errorish.slice(0, 3).map(l => l.trim()), key: keyLines(body), context: body.slice(-context), classes, text: all });
    }
  }
  const others = [...new Set(failing.flatMap(f => f.classes))].filter(c => c !== verdict);
  const urls = [...new Set((all.match(/https?:\/\/[^\s'")]+/g) || []).map(u => u.replace(/[:.,;]+$/, '')).filter(u => failing.some(f => f.text.includes(u)) && /cannot resolve|status code|Failed|timeout/i.test(all.slice(Math.max(0, all.indexOf(u) - 200), all.indexOf(u) + 200))))].slice(0, 3);
  let advice = ADVICE[verdict];
  if (ENV.includes(verdict) && anyFailedTest) advice += ' The failed tests of this run say nothing about the product until the environment is fixed and the run repeated.';
  return { job: job.name, mode, lines: lines.length, stepsRun, verdict, advice, alsoSeen: others, urls,
    failingSteps: failing.map(f => ({ step: f.step, errors: f.errors, classes: f.classes, key: f.key, context: f.context })), tests, failedTests };
}

const results = inputs.flatMap(readInput).map(digest);
if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(results.some(r => r.verdict !== 'OK') ? 1 : 0); }
for (const r of results) {
  console.log(`=== ${r.job}: ${r.lines} lines, ${r.mode === 'ci' ? `${r.stepsRun} step(s) ran` : 'local run'}`);
  for (const t of r.tests) console.log(`tests (${t.runner}): ${t.passed} passed, ${t.failed} failed${t.skipped ? `, ${t.skipped} skipped` : ''}${t.errors ? `, ${t.errors} unhandled error(s)` : ''}`);
  if (r.failedTests.length) { console.log('failed tests:'); for (const t of r.failedTests) console.log('  - ' + t.slice(0, 200)); }
  for (const f of r.failingSteps) {
    console.log(`\n${r.mode === 'ci' ? 'step with an error: ' : ''}${f.step}${f.classes.length ? '   [' + f.classes.join(', ') + ']' : ''}`);
    for (const l of f.key) console.log('   > ' + l.slice(0, 220));
    if (!f.key.length) for (const l of f.context) console.log('   | ' + l.slice(0, 220));
    for (const e of f.errors) console.log('   X ' + e.slice(0, 220));
  }
  if (r.mode === 'ci' && r.failingSteps.length) console.log('\nnote: a step with an error does not always fail the job (continue-on-error). A green job with a red informative step still needs reading.');
  console.log(`\nVERDICT ${r.verdict}${r.alsoSeen.length ? ' (also: ' + r.alsoSeen.join(', ') + ')' : ''}`);
  if (r.urls.length) console.log('url: ' + r.urls.join('  '));
  console.log(r.advice + '\n');
}
process.exit(results.some(r => r.verdict !== 'OK') ? 1 : 0);
