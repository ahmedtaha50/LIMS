#!/usr/bin/env node
// The open-items register: what a wave left undone can be scheduled, turned into a deviation, or dropped by a person, but not lost.
//
//   node open-items.cjs add-reports <dir-with-report-*.json> [--roadmap <file>]     notDone, unmet acceptance, decisionsForUser
//   node open-items.cjs add-deviations <deviations.csv>                             OPEN deviations (and closes the ones the CSV closed)
//   node open-items.cjs add --kind not-done|decision --source "<where it comes from>" "<text>"   one item by hand: a gate patch
//                                                                                   deferred on purpose, a question the user left open
//   node open-items.cjs list [--all] [--kind decision|not-done|acceptance|deviation]
//   node open-items.cjs resolve OI-0007 --by "<commit, deviation id, test name or the user's decision>"
//   node open-items.cjs drop OI-0007 --reason "..." --decided-by "<name of the person>"
//   node open-items.cjs check                                                       integrity + counts (exit 1 when the register is inconsistent)
//   options: --repo .   --file <register.json>   (default: OPEN_ITEMS of factory.config.json, else docs/roadmap/open-items.json)
//
// Why: on the source project fifteen track reports carried 75 "not done" lines and 91 decisions for the user. Each was true and
// each was easy to forget once the wave was green. A plan is kept when its leftovers are still on a list.
// Rules the tool enforces: an item is closed only with a reference (--by); dropping planned work names the person who decided
// (an agent does not drop scope); imports are idempotent (the same line is never added twice).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { args, loadConfig, loadRoadmap, parseCsv, today } = require('./lib/common.cjs');

const { opt, flag, positional } = args(process.argv.slice(2), ['--repo', '--file', '--roadmap', '--by', '--reason', '--decided-by', '--kind', '--source']);
const [cmd, arg1] = positional;
const repo = path.resolve(opt('--repo', '.'));
const file = path.resolve(repo, opt('--file', loadConfig(repo).OPEN_ITEMS));
const KINDS = ['not-done', 'acceptance', 'decision', 'deviation'];
const usage = () => { console.error('usage: node open-items.cjs add-reports <dir> | add-deviations <csv> | add --kind not-done|decision --source "..." "<text>" | list [--all] | resolve <id> --by "..." | drop <id> --reason "..." --decided-by "..." | check'); process.exit(2); };
if (!cmd) usage();

const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { comment: 'Open items of the delivery plan. An item leaves this list only as resolved (with a reference) or dropped (by a named person).', items: [] };
const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n'); };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const keyOf = (kind, source, text) => crypto.createHash('sha1').update([kind, source, norm(text).toLowerCase()].join('|')).digest('hex').slice(0, 16);
const nextId = () => 'OI-' + String(reg.items.reduce((m, i) => Math.max(m, parseInt(String(i.id).slice(3), 10) || 0), 0) + 1).padStart(4, '0');
function add(kind, source, text, keyText = text) {
  const key = keyOf(kind, source, keyText);
  if (reg.items.some(i => i.key === key)) return false;
  reg.items.push({ id: nextId(), kind, source, text: norm(text), status: 'open', opened: today(), key });
  return true;
}
const counts = () => { const c = {}; for (const i of reg.items.filter(x => x.status === 'open')) c[i.kind] = (c[i.kind] || 0) + 1; return c; };
const summary = () => { const c = counts(); const n = Object.values(c).reduce((a, b) => a + b, 0); return `${n} open item(s)${n ? ': ' + KINDS.filter(k => c[k]).map(k => `${c[k]} ${k}`).join(', ') : ''}; ${reg.items.length - n} closed`; };

if (cmd === 'add-reports') {
  if (!arg1 || !fs.existsSync(arg1)) usage();
  const road = opt('--roadmap') ? loadRoadmap(path.resolve(opt('--roadmap'))) : null;
  let added = 0;
  for (const f of fs.readdirSync(arg1).filter(x => /^report-.+\.json$/.test(x)).sort()) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(arg1, f), 'utf8')); } catch { console.error(`skipped ${f}: not valid JSON`); continue; }
    const src = 'report:' + (r.track || f);
    for (const t of (Array.isArray(r.notDone) ? r.notDone : [])) added += add('not-done', src, t) ? 1 : 0;
    for (const t of (Array.isArray(r.decisionsForUser) ? r.decisionsForUser : [])) added += add('decision', src, t) ? 1 : 0;
    for (const e of (Array.isArray(r.acceptance) ? r.acceptance : [])) {
      if (!e || e.status === 'met') continue;
      const crit = road && road.gapById.get(e.gap) ? (road.gapById.get(e.gap).acceptance || [])[Number(e.n) - 1] : '';
      added += add('acceptance', src, `${e.gap}#${e.n} ${e.status}${crit ? ': ' + crit : ''}`, `${e.gap}#${e.n}`) ? 1 : 0;   // one item per criterion, whatever its wording
    }
  }
  save(); console.log(`${added} item(s) added. ${summary()}`);
} else if (cmd === 'add') {
  const kind = opt('--kind', ''), source = norm(opt('--source', '')), text = norm(arg1 || '');
  if (!['not-done', 'decision'].includes(kind) || source.length < 2 || text.length < 10) { console.error('open-items: add needs --kind not-done|decision, --source "<the gate, the message or the file it comes from>" and a text that says what is open'); process.exit(2); }
  const added = add(kind, source, text);
  save(); console.log(`${added ? '1 item added' : 'already on the list'}. ${summary()}`);
} else if (cmd === 'add-deviations') {
  if (!arg1 || !fs.existsSync(arg1)) usage();
  const rows = parseCsv(fs.readFileSync(arg1, 'utf8')).slice(1).filter(r => r.length >= 4 && r[0]);
  let added = 0, closed = 0;
  for (const [id, desc, , status] of rows) {
    const src = 'deviation:' + id;
    const have = reg.items.find(i => i.source === src);
    if (/^open$/i.test(status.trim())) { if (!have) { reg.items.push({ id: nextId(), kind: 'deviation', source: src, text: norm(desc), status: 'open', opened: today(), key: keyOf('deviation', src, '') }); added++; } }
    else if (have && have.status === 'open') { have.status = 'resolved'; have.by = `${id} is ${status.trim()} in ${path.basename(arg1)}`; have.closed = today(); closed++; }
  }
  save(); console.log(`${added} deviation(s) added, ${closed} closed. ${summary()}`);
} else if (cmd === 'list') {
  const kind = opt('--kind');
  const items = reg.items.filter(i => (flag('--all') || i.status === 'open') && (!kind || i.kind === kind));
  for (const i of items) console.log(`${i.id}  ${i.status.padEnd(8)} ${i.kind.padEnd(10)} [${i.source}] ${i.text.length > 220 ? i.text.slice(0, 219) + '…' : i.text}${i.by ? '  => ' + i.by : ''}${i.reason ? '  => dropped: ' + i.reason + ' (' + i.decidedBy + ')' : ''}`);
  console.log(summary());
} else if (cmd === 'resolve' || cmd === 'drop') {
  const it = reg.items.find(i => i.id === arg1);
  if (!it) { console.error(`open-items: no item ${arg1}`); process.exit(2); }
  if (it.status !== 'open') { console.error(`open-items: ${it.id} is already ${it.status}`); process.exit(2); }
  if (cmd === 'resolve') {
    const by = norm(opt('--by', ''));
    if (by.length < 5) { console.error('open-items: resolve needs --by "<the commit, deviation, test or decision that closes it>"'); process.exit(2); }
    Object.assign(it, { status: 'resolved', by, closed: today() });
  } else {
    const reason = norm(opt('--reason', '')), who = norm(opt('--decided-by', ''));
    if (reason.length < 5 || who.length < 2) { console.error('open-items: drop needs --reason "..." and --decided-by "<the person who decided>": an agent does not drop planned work'); process.exit(2); }
    Object.assign(it, { status: 'dropped', reason, decidedBy: who, closed: today() });
  }
  save(); console.log(`${it.id} ${it.status}. ${summary()}`);
} else if (cmd === 'check') {
  const bad = [];
  const seen = new Set();
  for (const i of reg.items) {
    if (seen.has(i.id)) bad.push(`${i.id}: duplicate id`); seen.add(i.id);
    if (!KINDS.includes(i.kind)) bad.push(`${i.id}: unknown kind ${i.kind}`);
    if (!['open', 'resolved', 'dropped'].includes(i.status)) bad.push(`${i.id}: unknown status ${i.status}`);
    if (i.status === 'resolved' && !norm(i.by || '')) bad.push(`${i.id}: resolved without a reference`);
    if (i.status === 'dropped' && (!norm(i.reason || '') || !norm(i.decidedBy || ''))) bad.push(`${i.id}: dropped without a reason and a person`);
  }
  for (const b of bad) console.error('X ' + b);
  console.log(`${path.relative(repo, file)}: ${summary()}`);
  const c = counts();
  if (c.decision) console.log(`${c.decision} decision(s) wait for the user: list them in the next status message.`);
  process.exit(bad.length ? 1 : 0);
} else usage();
