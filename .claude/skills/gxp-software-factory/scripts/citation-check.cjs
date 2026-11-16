#!/usr/bin/env node
// Checks every regulatory citation in the project's documents against the anchor list (scripts/lib/anchors.json).
//
//   node citation-check.cjs [paths...] [--repo .] [--strict] [--json]
//   node citation-check.cjs --list          prints the anchor list (what may be cited without a person opening the text)
//   default paths: AGENTS.md README.md docs validation/build validation/README.md   (text files; evidence logs are skipped)
//
//   VALID     the clause exists in the anchor list (21 CFR Part 11, EU GMP Annex 11 of 2011, GAMP 5 categories, PIC/S PI 011 and PI 041, ICH Q-numbers)
//   INVALID   it cannot exist: "21 CFR 11.20", "11.10(z)", "Annex 11 clause 23", "GAMP category 2"                       -> exit 1
//   UNLISTED  a real-looking citation the list does not cover (21 CFR 211.68, another annex): a person checks the text   -> exit 1 with --strict
// Why: a wrong clause number written by an agent in a comment or a change record ends up in a validation document, and an
// inspector reads it. The rule of the method is "cite nothing you have not checked"; this is the check for the clauses that
// can be checked mechanically. It does not judge whether the clause is the RIGHT one for the claim: that stays with QA.
const fs = require('fs');
const path = require('path');
const { args } = require('./lib/common.cjs');
const A = require('./lib/anchors.json');

const { opt, flag, positional } = args(process.argv.slice(2), ['--repo']);
if (flag('--list')) {
  // The anchor list in readable form: the single source is lib/anchors.json, so this print cannot drift from what is checked.
  console.log(A.part11.title);
  for (const [s, v] of Object.entries(A.part11.sections)) {
    console.log(`  ${s.padEnd(7)} ${v.name}${v.paragraphs === null ? '  (has paragraphs; not enumerated here)' : v.paragraphs ? `  (${v.paragraphs[0]}) to (${v.paragraphs[v.paragraphs.length - 1]})` : '  (no lettered paragraphs)'}`);
    for (const ch of v.paragraphs || '') { const k = `${s}(${ch})`; if (A.part11.paragraphNames[k]) console.log(`    ${k.padEnd(10)} ${A.part11.paragraphNames[k]}`); }
  }
  console.log('\n' + A.annex11.title);
  for (const [c, v] of Object.entries(A.annex11.clauses)) console.log(`  ${c.padStart(2)}  ${v.name}${v.sub ? `  (${c}.1 to ${c}.${v.sub})` : ''}`);
  console.log('\n' + A.gamp.title); for (const [c, v] of Object.entries(A.gamp.categories)) console.log(`  ${c}  ${v}`);
  console.log('\nPIC/S'); for (const v of Object.values(A.pics)) console.log('  ' + v);
  console.log('\nICH quality guidelines: ' + A.ich.join(', '));
  console.log('ALCOA+: ' + A.alcoaPlus.join(', '));
  console.log('\nWatch (the list is not a calendar of revisions):'); for (const w of A.watch || []) console.log(`  ${w.what} (checked ${w.checked}): ${w.note}`);
  console.log('\nThese are pointers to clause numbers, in paraphrase. They are never quoted as regulatory text.');
  process.exit(0);
}
const repo = path.resolve(opt('--repo', '.'));
const roots = positional.length ? positional : ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs', 'validation/build', 'validation/README.md'];
const TEXT = /\.(md|markdown|txt|cjs|mjs|js|ts|tsx|json|csv|ya?ml)$/i;
const SKIP = /(^|\/)(node_modules|\.git|evidence|dist|dist-server|release|build\/pgsql)(\/|$)/;
const files = [];
const walk = (p) => {
  const abs = path.resolve(repo, p);
  if (!fs.existsSync(abs)) return;
  const rel = path.relative(repo, abs).split(path.sep).join('/');
  if (SKIP.test(rel)) return;
  if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(p, e)); }
  else if (TEXT.test(abs) && fs.statSync(abs).size < 2 << 20) files.push(rel);
};
roots.forEach(walk);

const found = [];
const add = (file, line, cite, status, why) => found.push({ file, line, cite, status, why });
const PART11 = Object.keys(A.part11.sections).map(s => s.slice(3));
for (const file of files) {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  lines.forEach((text, i) => {
    const ln = i + 1;
    const cfrContext = /CFR|Part\s*11\b|§/i.test(text);
    // 21 CFR Part 11: 11.<section>(<paragraph>)
    for (const m of text.matchAll(/(?<![\d.\w])11\.(\d{1,3})(\([a-z]\))?(?![\d.]*\d)/g)) {
      if (!cfrContext && !m[2]) continue;                       // "11.10" alone, with nothing saying it is the regulation
      const sec = '11.' + m[1], S = A.part11.sections[sec], para = m[2] ? m[2][1] : null, cite = sec + (m[2] || '');
      if (!S) { if (cfrContext) add(file, ln, '21 CFR ' + cite, 'INVALID', `Part 11 has no section ${sec} (sections: ${Object.keys(A.part11.sections).join(', ')})`); continue; }
      if (!para) add(file, ln, '21 CFR ' + cite, 'VALID', S.name);
      else if (S.paragraphs === null) add(file, ln, '21 CFR ' + cite, 'UNLISTED', `${sec} has paragraphs, but this list does not enumerate them`);
      else if (S.paragraphs.includes(para)) add(file, ln, '21 CFR ' + cite, 'VALID', A.part11.paragraphNames[cite] || S.name);
      else add(file, ln, '21 CFR ' + cite, 'INVALID', S.paragraphs ? `${sec} has paragraphs (${S.paragraphs[0]}) to (${S.paragraphs[S.paragraphs.length - 1]}) only` : `${sec} has no lettered paragraphs`);
    }
    // other CFR parts: real, but not covered here
    for (const m of text.matchAll(/21\s*CFR\s*(?:Part\s*)?(\d{2,4})(?:\.(\d+))?/gi)) if (m[1] !== '11') add(file, ln, m[0].replace(/\s+/g, ' '), 'UNLISTED', 'outside the anchor list (only Part 11 is listed)');
    // Annex 11 clauses: "Annex 11 s.10", "Annex 11, clause 4.3", "... and s.17" on the same line
    if (/Annex\s*11\b/i.test(text)) {
      for (const m of text.matchAll(/(?:\bs\.|\bsection\s|\bclause\s|§\s?|\bparagraph\s|\bpoint\s)\s*(\d{1,2})(?:\.(\d{1,2}))?(?![\d(])/gi)) {
        if (m[1] === '11' && m[2] && PART11.includes(m[2]) && /CFR/i.test(text)) continue;   // that is 21 CFR 11.x on a line that also names the annex
        const C = A.annex11.clauses[String(Number(m[1]))], cite = 'Annex 11 clause ' + Number(m[1]) + (m[2] ? '.' + Number(m[2]) : '');
        if (!C) add(file, ln, cite, 'INVALID', 'Annex 11 (2011) has clauses 1 to 17');
        else if (m[2] && (C.sub === 0 || Number(m[2]) < 1 || Number(m[2]) > C.sub)) add(file, ln, cite, 'INVALID', C.sub ? `clause ${Number(m[1])} has sub-clauses .1 to .${C.sub}` : `clause ${Number(m[1])} (${C.name}) has no numbered sub-clauses`);
        else add(file, ln, cite, 'VALID', C.name);
      }
    }
    for (const m of text.matchAll(/Annex\s*(\d{1,2})\b/gi)) if (m[1] !== '11') add(file, ln, 'EU GMP Annex ' + m[1], 'UNLISTED', 'outside the anchor list (only Annex 11 is listed)');
    // GAMP categories
    if (/GAMP/i.test(text)) for (const m of text.matchAll(/\bcategor(?:y|ies)\s*(\d)\b/gi)) {
      if (A.gamp.categories[m[1]]) add(file, ln, 'GAMP category ' + m[1], 'VALID', A.gamp.categories[m[1]]);
      else add(file, ln, 'GAMP category ' + m[1], 'INVALID', 'GAMP 5 has categories 1, 3, 4 and 5 (category 2 was withdrawn)');
    }
    for (const m of text.matchAll(/PI[\s-]?0?(\d{2,3})(?:-\d+)?\b/g)) { if (!/PIC\/?S|PI[\s-]?0\d\d/.test(text)) continue; const k = m[1].padStart(3, '0'); add(file, ln, 'PIC/S PI ' + k, A.pics[k] ? 'VALID' : 'UNLISTED', A.pics[k] || 'outside the anchor list'); }
    for (const m of text.matchAll(/\bICH\s*(Q\d{1,2}[A-E]?)/g)) add(file, ln, 'ICH ' + m[1], A.ich.includes(m[1]) ? 'VALID' : 'UNLISTED', A.ich.includes(m[1]) ? 'ICH quality guideline' : 'outside the anchor list');
  });
}
const by = (s) => found.filter(f => f.status === s);
const invalid = by('INVALID'), unlisted = by('UNLISTED');
const fail = invalid.length > 0 || (flag('--strict') && unlisted.length > 0);
if (flag('--json')) { console.log(JSON.stringify({ files: files.length, valid: by('VALID').length, invalid, unlisted }, null, 2)); process.exit(fail ? 1 : 0); }
console.log(`${files.length} file(s) read, ${found.length} citation(s): ${by('VALID').length} valid, ${invalid.length} invalid, ${unlisted.length} unlisted`);
if (invalid.length) { console.log('\nINVALID: this clause does not exist. Remove it or replace it after reading the regulation.'); for (const f of invalid) console.log(`  ${f.file}:${f.line}  ${f.cite}  (${f.why})`); }
if (unlisted.length) {
  console.log('\nUNLISTED: outside the anchor list. A person checks these against the text before the document is approved.');
  const seen = new Map(); for (const f of unlisted) { const k = f.cite; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(`${f.file}:${f.line}`); }
  for (const [k, where] of [...seen].slice(0, 40)) console.log(`  ${k}  x${where.length}  (${where.slice(0, 3).join(', ')}${where.length > 3 ? ', ...' : ''})`);
}
console.log(fail ? '\ncitation check FAILED.' : '\ncitation check OK: no clause that cannot exist. Whether each clause fits its claim is for QA to judge.');
process.exit(fail ? 1 : 0);
