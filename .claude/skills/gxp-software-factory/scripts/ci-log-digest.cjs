#!/usr/bin/env node
// Turns a CI job log into: which step failed, the lines that say why, the test totals, and what kind of failure it is.
//
//   node ci-log-digest.cjs <log file> [more files] [--context 12] [--json]
//   <tool that prints a log> | node ci-log-digest.cjs -
//
// A log file may be raw text (GitHub Actions "View raw logs", gh run view --log) or the JSON a GitHub MCP tool saves
// ({ "logs_content": "..." } or { "logs": [{ "job_name", "logs_content" }] }).
//
// Why: a job conclusion says "failure" or "success", not why. A green job can hide a red informative step
// (continue-on-error), and a red job is often not the code at all (a download that answered 504, a billing stop).
// The class decides the next move, so decide it from the log, not from the conclusion:
//   NEVER_STARTED          no step ran: the account (minutes, spending limit, private repository), not the code
//   INFRA_DOWNLOAD         an external download or registry failed: re-run once, then remove the dependency
//   TIMEOUT                a step hit its limit: find why it hangs; an informative step that times out is not evidence
//   RUNNER_RESOURCES       disk or memory of the runner
//   UNHANDLED_AFTER_GREEN  every test passed, the process still failed on an unhandled error: fix its source
//   TEST_FAILURE           a real failing test: reproduce under CI conditions, never weaken the assertion
//   MISSING_FILE           an expected file is absent: quoting, packaging output, or a silently skipped download
//   BUILD_ERROR            compile, type or module resolution error
//   UNKNOWN_ERROR          an error marker without a known signature: read the context printed below
//   OK                     no error marker in the log
const fs = require('fs');

const argv = process.argv.slice(2);
const context = (() => { const i = argv.indexOf('--context'); return i > -1 ? Math.max(0, parseInt(argv[i + 1], 10) || 12) : 12; })();
const asJson = argv.includes('--json');
const inputs = argv.filter((a, i) => a !== '--json' && a !== '--context' && argv[i - 1] !== '--context');
if (!inputs.length) { console.error('usage: node ci-log-digest.cjs <log file | -> [more] [--context N] [--json]'); process.exit(2); }

const ADVICE = {
  NEVER_STARTED: 'No step ran. This is the CI account (Actions minutes, spending limit, private-repository billing, disabled Actions), not the code. Re-running does not help: tell the user where to look.',
  INFRA_DOWNLOAD: 'An external download or registry failed. Re-run the failed job once. If it fails the same way, remove the dependency on that download (use what is already installed, add a retry step that also verifies the file) instead of re-running again. Do not switch to an unreviewed mirror on your own.',
  TIMEOUT: 'A step hit its time limit. Find why it hangs before touching the limit. An informative (continue-on-error) step that times out proves nothing: do not cite it as evidence.',
  RUNNER_RESOURCES: 'The runner ran out of disk or memory. Reduce what the job downloads or builds, or free space in an earlier step.',
  UNHANDLED_AFTER_GREEN: 'Every test passed but the run failed on an unhandled error (often a connection ended during teardown). Fix the source of the unhandled error; the exit code is right, do not mask it.',
  TEST_FAILURE: 'Real test failure. Reproduce it under CI conditions (not root, ICU collation, localhost = ::1, another time zone) before changing anything. Never weaken or skip the assertion.',
  MISSING_FILE: 'A file the step expected is not there. Check shell quoting (PowerShell splits "-c.key=value"), the packaging output path, and whether an earlier download was skipped without an error.',
  BUILD_ERROR: 'Compile, type or module error. Fix the code; if it only fails in CI, compare tool versions and the lockfile.',
  UNKNOWN_ERROR: 'An error marker without a known signature. Read the context below and the last lines of the failing step.',
  OK: 'No error marker found. If the job is red anyway, the failing step may be in another job: digest that log too.',
};

const RULES = [
  ['INFRA_DOWNLOAD', /status code 5\d\d|cannot resolve https?:\/\/|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|Could not resolve host|50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|Failed to connect to|rate limit exceeded|TLS handshake timeout|unexpected EOF.*(?:download|fetch)|network timeout at/i],
  ['TIMEOUT', /has timed out after|exceeded the maximum execution time|The operation was canceled|timed out after \d+ ?(?:ms|s|minutes)/i],
  ['RUNNER_RESOURCES', /No space left on device|ENOSPC|JavaScript heap out of memory|Killed\s*$|out of memory/i],
  ['MISSING_FILE', /ENOENT: no such file or directory|is missing after|cannot find the file|The system cannot find the (?:file|path)/i],
  ['BUILD_ERROR', /error TS\d+:|SyntaxError:|Cannot find module|Module not found|error: could not compile|ERR_MODULE_NOT_FOUND/],
  ['TEST_FAILURE', /^not ok \d+|^\s*(?:FAIL|✗|×)\s|AssertionError|Expected .* (?:to|but)|^# fail [1-9]|Tests?\s+\d+ failed|\d+ failed,? /m],
];

function readInput(f) {
  const text = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8');
  const jobs = [];
  try {
    const j = JSON.parse(text);
    if (j && typeof j.logs_content === 'string') jobs.push({ name: j.job_name || (j.job_id ? 'job ' + j.job_id : f), text: j.logs_content });
    else if (j && Array.isArray(j.logs)) for (const l of j.logs) jobs.push({ name: l.job_name || 'job ' + l.job_id, text: String(l.logs_content || '') });
    else if (j && Array.isArray(j.jobs)) for (const l of j.jobs) jobs.push({ name: l.name || 'job ' + l.id, text: String(l.logs_content || l.log || '') });
  } catch { /* raw text */ }
  if (!jobs.length) jobs.push({ name: f, text });
  return jobs;
}
const clean = (s) => s.replace(/\r/g, '').split('\n').map(l => l.replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));

function digest(job) {
  const lines = clean(job.text);
  const nonEmpty = lines.filter(l => l.trim()).length;
  // steps: a "##[group]Run ..." line opens one; everything before the first is set-up
  const steps = [];
  let cur = { title: '(job set-up)', start: 0, lines: [] };
  lines.forEach((l, i) => {
    const m = /^##\[group\]Run (.*)$/.exec(l);
    if (m) { steps.push(cur); cur = { title: m[1].trim().slice(0, 160), start: i, lines: [] }; }
    cur.lines.push(l);
  });
  steps.push(cur);
  const ran = steps.length > 1;

  const failing = [];
  for (const s of steps) {
    const errIdx = s.lines.map((l, i) => (/^##\[error\]/.test(l) ? i : -1)).filter(i => i > -1);
    if (!errIdx.length) continue;
    const first = errIdx[0];
    const body = s.lines.slice(0, first).filter(l => l.trim() && !/^##\[(?:group|endgroup)\]/.test(l));
    const text = s.lines.join('\n');
    const classes = RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
    // the lines that say why: error-looking lines of the step, without stack frames
    const KEY = /⨯|\berror\b|Error:|cannot |\bfailed\b|^not ok|status code|refused|denied|ENOENT|timed out|is missing|FAIL\b/i;
    const key = body.filter(l => KEY.test(l) && !/^\s+at\s/.test(l) && !/^\s*(?:github\.com|runtime\.|\/Users\/runner)/.test(l)).map(l => l.trim()).filter((l, i, a) => a.indexOf(l) === i).slice(0, 8);
    const named = errIdx.map(i => (/The action '([^']+)'/.exec(s.lines[i]) || [])[1]).find(Boolean);
    failing.push({ step: named || s.title, errors: errIdx.map(i => s.lines[i].replace(/^##\[error\]/, '').trim()), key, context: body.slice(-context), classes, text });
  }

  // test totals, whatever the runner
  const all = lines.join('\n');
  const tests = [];
  const vt = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?/.exec(all);
  if (vt) tests.push({ runner: 'vitest', passed: +vt[2], failed: +(vt[1] || 0), skipped: +(vt[3] || 0), errors: +((/Errors\s+(\d+) error/.exec(all) || [])[1] || 0) });
  const tap = [...all.matchAll(/^# pass (\d+)\n# fail (\d+)/gm)];
  for (const m of tap) tests.push({ runner: 'node:test', passed: +m[1], failed: +m[2] });
  const jest = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed/.exec(all);
  if (jest && !vt) tests.push({ runner: 'jest', passed: +jest[3], failed: +(jest[1] || 0), skipped: +(jest[2] || 0) });
  const py = /=+ (?:(\d+) failed, )?(\d+) passed(?:, (\d+) skipped)?[^=]*=+/.exec(all);
  if (py) tests.push({ runner: 'pytest', passed: +py[2], failed: +(py[1] || 0), skipped: +(py[3] || 0) });
  const passLines = lines.filter(l => /^PASS\s/.test(l)).length, failLines = lines.filter(l => /^FAIL\s/.test(l));
  if (passLines || failLines.length) tests.push({ runner: 'PASS/FAIL lines', passed: passLines, failed: failLines.length });
  const failedTests = [...lines.filter(l => /^not ok \d+ - /.test(l)).map(l => l.replace(/^not ok \d+ - /, '')), ...failLines.map(l => l.replace(/^FAIL\s+/, ''))]
    .filter((t, i, a) => a.indexOf(t) === i).slice(0, 25);

  let verdict = 'OK';
  const greenTests = tests.length > 0 && tests.every(t => !t.failed);
  if (!ran && nonEmpty < 5) verdict = 'NEVER_STARTED';
  else if (failing.length) {
    const f0 = failing[0];
    if (/Unhandled (?:Error|Rejection)|Uncaught Exception/.test(all) && greenTests) verdict = 'UNHANDLED_AFTER_GREEN';
    else verdict = f0.classes[0] || 'UNKNOWN_ERROR';
  } else if (!ran) verdict = 'NEVER_STARTED';
  const others = [...new Set(failing.flatMap(f => f.classes))].filter(c => c !== verdict);
  const urls = [...new Set((all.match(/https?:\/\/[^\s'")]+/g) || []).map(u => u.replace(/[:.,;]+$/, '')).filter(u => failing.some(f => f.text.includes(u)) && /cannot resolve|status code|Failed|timeout/i.test(all.slice(Math.max(0, all.indexOf(u) - 200), all.indexOf(u) + 200))))].slice(0, 3);
  return { job: job.name, lines: lines.length, stepsRun: Math.max(0, steps.length - 1), verdict, advice: ADVICE[verdict], alsoSeen: others, urls,
    failingSteps: failing.map(f => ({ step: f.step, errors: f.errors, classes: f.classes, key: f.key, context: f.context })), tests, failedTests };
}

const results = inputs.flatMap(readInput).map(digest);
if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(results.some(r => r.verdict !== 'OK') ? 1 : 0); }
for (const r of results) {
  console.log(`=== ${r.job}: ${r.lines} lines, ${r.stepsRun} step(s) ran`);
  for (const t of r.tests) console.log(`tests (${t.runner}): ${t.passed} passed, ${t.failed} failed${t.skipped ? `, ${t.skipped} skipped` : ''}${t.errors ? `, ${t.errors} unhandled error(s)` : ''}`);
  if (r.failedTests.length) { console.log('failed tests:'); for (const t of r.failedTests) console.log('  - ' + t.slice(0, 200)); }
  for (const f of r.failingSteps) {
    console.log(`\nstep with an error: ${f.step}${f.classes.length ? '   [' + f.classes.join(', ') + ']' : ''}`);
    for (const l of f.key) console.log('   > ' + l.slice(0, 220));
    if (!f.key.length) for (const l of f.context) console.log('   | ' + l.slice(0, 220));
    for (const e of f.errors) console.log('   X ' + e.slice(0, 220));
  }
  if (r.failingSteps.length) console.log('\nnote: a step with an error does not always fail the job (continue-on-error). A green job with a red informative step still needs reading.');
  console.log(`\nVERDICT ${r.verdict}${r.alsoSeen.length ? ' (also: ' + r.alsoSeen.join(', ') + ')' : ''}`);
  if (r.urls.length) console.log('url: ' + r.urls.join('  '));
  console.log(r.advice + '\n');
}
process.exit(results.some(r => r.verdict !== 'OK') ? 1 : 0);
