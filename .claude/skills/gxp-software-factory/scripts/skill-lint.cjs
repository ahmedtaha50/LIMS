#!/usr/bin/env node
// Lints this skill itself: the manual must not point at files that are not there, and the kits must be complete.
//
//   node skill-lint.cjs [<skill dir>] [--json]        (default: the skill this file belongs to)
//
// Checks:
//   FRONTMATTER  SKILL.md has name (the folder's name) and a description of at most 1024 characters without angle brackets
//   PATH         every `scripts/...`, `references/...`, `assets/...` path written in backticks in SKILL.md, the references, the
//                briefs and the kit README exists (in the skill, or inside a kit: kits mirror the paths of the target project)
//   REQUIRE      every relative require() in the tools and in the kits resolves to a file that ships with the skill
//   SYNTAX       every .cjs parses (node --check), every .sh parses (bash -n), every .json is valid
//   INDEX        every tool in scripts/ and every file in references/ is named in SKILL.md (a tool nobody is told about is not used)
// Exit 1 on any finding.
// Why: version 1 of this skill shipped a validation kit without a file its own content.cjs required, and a release kit whose
// relative paths only worked in the project it was copied from. Both were found by reading; this makes the reading a check.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const root = path.resolve(argv.find(a => !a.startsWith('--')) || path.join(__dirname, '..'));
const problems = [];
const bad = (kind, where, what) => problems.push({ kind, where, what });
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const read = (f) => fs.readFileSync(f, 'utf8');

// ---- FRONTMATTER
const skillMd = path.join(root, 'SKILL.md');
if (!fs.existsSync(skillMd)) { bad('FRONTMATTER', 'SKILL.md', 'the file is missing'); }
else {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(skillMd));
  if (!m) bad('FRONTMATTER', 'SKILL.md', 'no frontmatter block');
  else {
    const name = (/^name:\s*(.+)$/m.exec(m[1]) || [])[1], desc = (/^description:\s*([\s\S]+?)(?=\n[a-z-]+:|$)/m.exec(m[1]) || [])[1];
    if (!name) bad('FRONTMATTER', 'SKILL.md', 'no name');
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.trim())) bad('FRONTMATTER', 'SKILL.md', `name "${name.trim()}" is not kebab-case`);
    else if (name.trim() !== path.basename(root)) bad('FRONTMATTER', 'SKILL.md', `name "${name.trim()}" differs from the folder "${path.basename(root)}"`);
    if (!desc) bad('FRONTMATTER', 'SKILL.md', 'no description');
    else { if (desc.trim().length > 1024) bad('FRONTMATTER', 'SKILL.md', `description is ${desc.trim().length} characters (limit 1024)`); if (/[<>]/.test(desc)) bad('FRONTMATTER', 'SKILL.md', 'description contains angle brackets'); }
  }
}

// ---- PATH
const kitsDir = path.join(root, 'assets', 'kits');
const kitRoots = fs.existsSync(kitsDir) ? fs.readdirSync(kitsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(kitsDir, e.name)) : [];
const all = walk(root).map(rel);
const globRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + (g.endsWith('/') ? '' : '$'));
const exists = (p) => {
  if (p.includes('*')) { const re = globRe(p); return all.some(f => re.test(f)) || kitRoots.some(k => all.some(f => f.startsWith(rel(k) + '/') && re.test(f.slice(rel(k).length + 1)))); }
  return fs.existsSync(path.join(root, p)) || kitRoots.some(k => fs.existsSync(path.join(k, p)));
};
const docs = [skillMd, ...walk(path.join(root, 'references')), ...walk(path.join(root, 'assets', 'briefs')), path.join(kitsDir, 'README.md')].filter(f => fs.existsSync(f) && /\.md$/.test(f));
for (const f of docs) {
  read(f).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      for (const tok of m[1].split(/[\s,;]+/)) {
        const p = tok.replace(/^(?:node|bash|sh)$/, '').replace(/[.:)]+$/, '');
        if (!/^(scripts|references|assets)\//.test(p) || /[<>{}$]/.test(p)) continue;      // placeholders are not paths
        if (!exists(p)) bad('PATH', `${rel(f)}:${i + 1}`, `${p} does not exist`);
      }
    }
  });
}

// ---- REQUIRE and SYNTAX
const code = [...walk(path.join(root, 'scripts')), ...walk(kitsDir)];
for (const f of code) {
  const ext = path.extname(f);
  if (['.cjs', '.js', '.mjs'].includes(ext)) {
    const src = read(f);
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      if (!['', '.cjs', '.js', '.json', '/index.cjs', '/index.js'].some(s => fs.existsSync(base + s) && fs.statSync(base + s).isFile())) bad('REQUIRE', rel(f), `require('${m[1]}') does not resolve inside the skill`);
    }
    if (ext === '.cjs') { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) bad('SYNTAX', rel(f), (r.stderr || '').trim().split('\n').slice(0, 3).join(' | ')); }
  } else if (ext === '.sh') {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    if (r.status !== 0 && !r.error) bad('SYNTAX', rel(f), (r.stderr || '').trim().split('\n')[0]);
  }
}
for (const f of walk(root).filter(x => x.endsWith('.json'))) { try { JSON.parse(read(f)); } catch (e) { bad('SYNTAX', rel(f), 'not valid JSON: ' + e.message); } }

// ---- INDEX
if (fs.existsSync(skillMd)) {
  const text = read(skillMd);
  for (const f of fs.existsSync(path.join(root, 'scripts')) ? fs.readdirSync(path.join(root, 'scripts')).filter(x => /\.(cjs|sh)$/.test(x)) : []) if (!text.includes(f)) bad('INDEX', 'SKILL.md', `scripts/${f} is not mentioned`);
  for (const f of fs.existsSync(path.join(root, 'references')) ? fs.readdirSync(path.join(root, 'references')).filter(x => x.endsWith('.md')) : []) if (!text.includes(`references/${f}`)) bad('INDEX', 'SKILL.md', `references/${f} is not mentioned`);
}

if (argv.includes('--json')) console.log(JSON.stringify({ root, files: all.length, problems }, null, 2));
else {
  for (const p of problems) console.log(`${p.kind.padEnd(11)} ${p.where}: ${p.what}`);
  console.log(problems.length ? `\nskill-lint: ${problems.length} problem(s) in ${root}` : `skill-lint OK: ${all.length} file(s), ${docs.length} document(s) and ${code.length} code file(s) checked.`);
}
process.exit(problems.length ? 1 : 0);
