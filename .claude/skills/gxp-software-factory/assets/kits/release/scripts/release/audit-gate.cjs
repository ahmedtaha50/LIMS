// npm audit with recorded waivers (roadmap M36). Every dependency of this project is a devDependency (the runtime is bundled by
// the build), so `npm audit --omit=dev` would audit nothing; this audits all of them and fails on any high or critical
// advisory that has no current, approved waiver in scripts/release/audit-waivers.json.
//   node scripts/release/audit-gate.cjs            (needs the npm registry; exit 1 on an unwaived advisory)
// A waiver: { id: "GHSA-...", package, reason, approvedBy, expires: "YYYY-MM-DD" }. approvedBy is a named person from QA: this
// script never writes one.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FAIL_AT = new Set(['high', 'critical']);
const advisoryId = (url) => String(url || '').split('/').pop();

/** Which advisories in an `npm audit --json` report block the release? */
function evaluate(report, waivers, now = new Date()) {
  const valid = new Map();
  const problems = [];
  for (const w of waivers) {
    if (!w.id || !w.reason || !w.approvedBy || !/^\d{4}-\d{2}-\d{2}$/.test(String(w.expires))) { problems.push(`waiver ${w.id || '(no id)'} is incomplete (id, reason, approvedBy, expires are required)`); continue; }
    if (new Date(w.expires + 'T23:59:59Z') < now) { problems.push(`waiver ${w.id} expired on ${w.expires}`); continue; }
    valid.set(w.id, w);
  }
  const blocking = [];
  for (const v of Object.values(report.vulnerabilities || {})) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || !FAIL_AT.has(via.severity)) continue;
      const id = advisoryId(via.url);
      if (!valid.has(id)) blocking.push({ id, package: via.name || v.name, severity: via.severity, title: via.title });
    }
  }
  return { ok: !blocking.length && !problems.length, blocking, problems, waived: [...valid.keys()] };
}

if (require.main === module) {
  const root = path.join(__dirname, '..', '..');
  const waivers = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit-waivers.json'), 'utf8')).waivers || [];
  const r = spawnSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 });
  let report;
  try { report = JSON.parse(r.stdout); } catch { console.error('npm audit gave no report:', (r.stderr || r.stdout || '').slice(0, 500)); process.exit(2); }
  if (report.error) { console.error('npm audit failed:', report.error.summary || JSON.stringify(report.error)); process.exit(2); }
  const res = evaluate(report, waivers);
  for (const b of res.blocking) console.error(`BLOCKING ${b.severity} ${b.id} ${b.package}: ${b.title || ''}`);
  for (const p of res.problems) console.error('WAIVER PROBLEM ' + p);
  console.log(`npm audit: ${res.ok ? 'passed' : 'FAILED'} (${res.waived.length} valid waiver(s): ${res.waived.join(', ') || 'none'})`);
  process.exit(res.ok ? 0 : 1);
}
module.exports = { evaluate };
