#!/usr/bin/env node
// Does the agent manual (AGENTS.md / CLAUDE.md) describe the code that exists?
//
//   node manual-check.cjs [--repo .] [--manual AGENTS.md] [--src src,server,desktop] [--json]
//
// Why: every agent reads the manual first. A manual that names a technology the code does not use (the source project said
// "Firebase Auth" and "RabbitMQ" long after both were gone) makes every track build on something that is not there.
// Checks, for a Node project (package.json):
//   MENTIONED, NOT INSTALLED   a known technology named in the manual that is in no dependency list
//   INSTALLED, NEVER IMPORTED  a dependency named in the manual that no source file imports (described, but dead)
//   BANNED BUT PRESENT         "X is not used / must not be reintroduced" in the manual, and X is installed or imported
// It reports; a person decides whether the manual or the code is wrong. Exit 1 when anything is found.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const repo = path.resolve(opt('--repo', '.'));
const manualFile = opt('--manual') || ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'].find(f => fs.existsSync(path.join(repo, f)));
if (!manualFile || !fs.existsSync(path.join(repo, manualFile))) { console.error('manual-check: no AGENTS.md or CLAUDE.md found (write one before the first wave)'); process.exit(2); }
const pkgFile = path.join(repo, 'package.json');
if (!fs.existsSync(pkgFile)) { console.error('manual-check: no package.json (this check reads Node dependencies only)'); process.exit(2); }
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
const manual = fs.readFileSync(path.join(repo, manualFile), 'utf8');

// name in prose -> packages that would prove it
const TECH = {
  firebase: ['firebase', 'firebase-admin'], rabbitmq: ['amqplib'], amqplib: ['amqplib'], redis: ['redis', 'ioredis'], mongodb: ['mongodb', 'mongoose'],
  prisma: ['prisma', '@prisma/client'], drizzle: ['drizzle-orm'], sequelize: ['sequelize'], typeorm: ['typeorm'], knex: ['knex'],
  express: ['express'], fastify: ['fastify'], nestjs: ['@nestjs/core'], 'socket.io': ['socket.io'], 'node-cron': ['node-cron'], bullmq: ['bullmq'],
  zod: ['zod'], joi: ['joi'], bcryptjs: ['bcryptjs'], bcrypt: ['bcrypt'], argon2: ['argon2'], helmet: ['helmet'], 'express rate limit': ['express-rate-limit'],
  jspdf: ['jspdf'], xlsx: ['xlsx'], html2canvas: ['html2canvas'], react: ['react'], vue: ['vue'], vite: ['vite'], tailwind: ['tailwindcss'],
  electron: ['electron'], playwright: ['playwright', '@playwright/test'], vitest: ['vitest'], jest: ['jest'], otplib: ['otplib'], '@google/genai': ['@google/genai'], openai: ['openai'], passport: ['passport'],
};
const srcDirs = opt('--src', 'src,server,desktop,app,lib').split(',').map(d => path.join(repo, d)).filter(d => fs.existsSync(d));
const sources = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.((c|m)?(j|t)sx?|css)$/.test(e.name)) sources.push(p); } };
srcDirs.forEach(walk);
for (const f of fs.readdirSync(repo).filter(f => /^(server|index|main|app)\.(c|m)?(j|t)s$|\.config\.(c|m)?(j|t)s$/.test(f))) if (fs.existsSync(path.join(repo, f))) sources.push(path.join(repo, f));
const code = sources.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const imported = (p) => new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*|@import\\s+|@plugin\\s+|import\\s+)['"]@?${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(code) || new RegExp(`['"]@${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`).test(code);

const findings = [], notes = [];
const lines = manual.split('\n');
for (const [name, pkgs] of Object.entries(TECH)) {
  const re = new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i');
  const hits = lines.map((l, i) => ({ l, i })).filter(x => re.test(x.l));
  if (!hits.length) continue;
  // the SENTENCE that names it must say so, not just the same line
  const banned = hits.some(x => x.l.split(/(?<=[.;:!?])\s+/).some(sen => re.test(sen) && /\b(?:not used|no longer used|must not|removed|do not use)\b/i.test(sen)));
  const installed = pkgs.filter(p => deps.has(p));
  const used = pkgs.filter(imported);
  const where = `${manualFile}:${hits[0].i + 1}`;
  if (banned && installed.length && !used.length) { notes.push(`${name}: the manual says it is not used; ${installed.join(', ')} is still a dependency that nothing imports (remove it when convenient)`); continue; }
  if (banned) { if (installed.length || used.length) findings.push({ kind: 'BANNED BUT PRESENT', tech: name, where, detail: `${installed.length ? 'installed: ' + installed.join(', ') : ''}${used.length ? ' imported: ' + used.join(', ') : ''}`.trim() }); continue; }
  if (!installed.length) findings.push({ kind: 'MENTIONED, NOT INSTALLED', tech: name, where, detail: `none of ${pkgs.join(', ')} is in package.json` });
  else if (!used.length && sources.length) findings.push({ kind: 'INSTALLED, NEVER IMPORTED', tech: name, where, detail: `${installed.join(', ')} is a dependency but no file under ${srcDirs.map(d => path.relative(repo, d)).join(', ')} imports it` });
}
if (argv.includes('--json')) { console.log(JSON.stringify({ manual: manualFile, sources: sources.length, findings }, null, 2)); process.exit(findings.length ? 1 : 0); }
console.log(`${manualFile} against package.json (${deps.size} dependencies) and ${sources.length} source files`);
for (const f of findings) console.log(`  ${f.kind.padEnd(26)} ${f.tech.padEnd(20)} ${f.where}  ${f.detail}`);
for (const n of notes) console.log('  note: ' + n);
console.log(findings.length ? `\n${findings.length} difference(s). Decide for each whether the manual or the code is wrong, and fix that one. A dependency used through a wrapper or only at build time is a false alarm: say so in the manual.` : 'The manual names nothing the code lacks.');
process.exit(findings.length ? 1 : 0);
