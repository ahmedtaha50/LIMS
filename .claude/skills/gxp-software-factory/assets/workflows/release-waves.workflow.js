// One release in dependency waves, with one integration gate per wave (as it ran for release R1 of the LIMS project).
// To reuse: change WAVES (take them from scripts/roadmap-lint.cjs), the repository, branch and database lines in RULES,
// the checks in gatePrompt, and the commit trailers. On resume, drop the waves that are already merged from WAVES,
// otherwise finished tracks run again. Without a Workflow tool: assets/briefs/*.md with Agent + SendMessage.
export const meta = {
  name: 'lims-r1-foundation',
  description: 'Implement roadmap release R1 (foundation and integrity) in dependency waves with a verification gate after each wave',
  phases: [
    { title: 'W0 core', detail: 'split api.ts, core primitives, test harness' },
    { title: 'W1 migrations + shell', detail: 'versioned migrations, repo/build/HTTP hardening' },
    { title: 'W2 identity, audit, backup', detail: 'auth, audit v2, backup v2 and jobs' },
    { title: 'W3 esign, authz, client', detail: 'signature service, permissions, client shell' },
    { title: 'W4 spec + quality fixes', detail: 'specification lifecycle, ELN and reagent fixes' },
    { title: 'W5 results + OOS', detail: 'result guards, auto-OOS, release blockers' },
  ],
}

const WAVES = [
  { title: 'W0 core', tracks: ['r1-core'] },
  { title: 'W1 migrations + shell', tracks: ['r1-migrations', 'r1-build-shell'] },
  { title: 'W2 identity, audit, backup', tracks: ['r1-identity', 'r1-audit', 'r1-backup-jobs'] },
  { title: 'W3 esign, authz, client', tracks: ['r1-esign', 'r1-authz', 'r1-client-shell'] },
  { title: 'W4 spec + quality fixes', tracks: ['r1-spec', 'r1-quality-fixes'] },
  { title: 'W5 results + OOS', tracks: ['r1-results-oos'] },
]
const ALL = WAVES.flatMap(w => w.tracks)

const REPORT = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    done: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    testEvidence: { type: 'string', description: 'Exact commands run and their pass/fail totals' },
    decisionsForUser: { type: 'array', items: { type: 'string' }, description: 'GxP or product judgements implemented as conservative defaults that need human confirmation' },
    needsFromOtherTracks: { type: 'array', items: { type: 'string' } },
  },
  required: ['track', 'status', 'done', 'notDone', 'filesChanged', 'testsAdded', 'testEvidence', 'decisionsForUser', 'needsFromOtherTracks'],
}
const GATE = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    commit: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' }, description: 'Each gate with its result' },
    integrationFixes: { type: 'array', items: { type: 'string' } },
    remainingFailures: { type: 'array', items: { type: 'string' } },
  },
  required: ['green', 'commit', 'checks', 'integrationFixes', 'remainingFailures'],
}

const RULES = `
HOUSE RULES (all agents):
- Repository: /home/user/taha, branch claude/project-implementation-tirr4j. Several engineers work IN THE SAME working tree at the same time (other tracks of your wave). Therefore: NEVER run git commit, git add -A, git stash, git reset, git checkout -- <path>, git clean or any command that changes other people's files or the index. Leave your changes uncommitted; the wave gate commits. Never push.
- Read AGENTS.md first: audit entry in the SAME transaction as the change; e-signatures with meaning and recordVersion; optimistic concurrency (WHERE id AND version); strict zod on every input with server-controlled fields stripped; actor always from req.user; no silent failures. Part 11 / Annex 11 / ALCOA+ apply.
- The roadmap is docs/roadmap/roadmap.json (also readable as docs/roadmap/ROADMAP.md). Your track: releases[0].tracks where track == YOUR_TRACK; your gaps: synth.mergedGaps with id in track.gapIds (read their full design, files and acceptance). Use python3/jq to extract them. Also read synth.topDefects: fix every defect that falls inside your track's scope.
- Edit ONLY files matching your track's ownsFiles (plus new files inside directories you create under those patterns). If you need a change in a file you do not own, do not edit it: list it in needsFromOtherTracks. Earlier waves' outputs (new modules, harness, migration runner) are yours to USE; read their docs/changes/<track>.md first.
- TEST-FIRST. Write the regression test, run it on the OLD behaviour and see it FAIL, then fix. A test that never failed proves nothing. Test the real engine (PostgreSQL 16 is installed locally), never mocks of the database.
- Isolation: use YOUR OWN database and port so parallel engineers do not collide. Env for you: SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims (superuser) and SQL_DB_NAME=<your db name given below>; create it with: PGPASSWORD=lims psql -h 127.0.0.1 -U lims postgres -c "create database <name>". PostgreSQL may be stopped when you start: check pg_lsclusters and run pg_ctlcluster 16 main start. Run any server you need on YOUR port with HOST=127.0.0.1 and kill only your own process afterwards (never pkill -f broadly; keep the PID you started).
- The shared checks tests/security-controls.sh and tests/backup-restore.sh are validation evidence. Keep them passing. If a deliberate behaviour change forces an edit, make the MINIMAL edit, explain it in your report. Do not weaken an assertion to get green.
- Whole-project 'npm run lint' (tsc) can fail because of OTHER tracks' in-flight edits. Only your own files must be type-clean; re-run later if the errors are elsewhere. 
- Never invent regulatory citations, approvals or signatures. Where a GxP judgement is needed (retention, permissions, SoD cycles, rounding policy), implement a conservative default and list it under decisionsForUser.
- Do not bloat: no speculative abstractions, no features outside your gaps. Match surrounding code style.
- Finish by writing docs/changes/<track>.md (what changed, why, how to verify, decisions needing confirmation, what was NOT done) and return the structured report. Be honest: status 'partial' if acceptance criteria are unmet, and say which.`

function trackPrompt(track, idx, doneSoFar) {
  const db = 'lims_' + track.replace(/-/g, '_')
  const port = 3100 + idx
  return `You are the senior engineer who owns roadmap track "${track}" of the B-Pharma LIMS (release R1: foundation and integrity).
YOUR_TRACK = ${track}
Your database name: ${db}   Your port: ${port}
Tracks already completed and merged before you: ${doneSoFar.length ? doneSoFar.join(', ') : '(none; you are first)'}.
${RULES}`
}
function gatePrompt(wave, reports, doneSoFar) {
  return `You are the integration engineer and release gatekeeper for wave "${wave.title}" of release R1 of the B-Pharma LIMS (/home/user/taha).
Tracks of this wave: ${wave.tracks.join(', ')}. Previously merged: ${doneSoFar.join(', ') || '(none)'}.
Their reports (JSON): ${JSON.stringify(reports)}

Your job: make the combined working tree GREEN and commit it. Steps:
1. Inspect: git status, git diff --stat. Make sure no junk is staged/untracked that should not be committed (node_modules, dist, release, backups, *.log, .env). Respect .gitignore; add anything legitimately new.
2. Run every gate on a FRESH database (your own: lims_gate, port 3190; env SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_gate; drop and recreate the db first; PostgreSQL may need pg_ctlcluster 16 main start):
   a) npm run lint (tsc) and the unit/API test suite (npm test or the vitest command the harness defines), if the harness exists yet.
   b) npm run build.
   c) Create the schema the way a real install does (the repo's init path: dist/init-db.cjs and, once it exists, the migration runner; fall back to drizzle-kit push --force only if the migration path does not exist yet), seed (npx tsx src/server/seed_pg.ts or the new seed path), start the server on port 3190 (HOST=127.0.0.1) and run tests/security-controls.sh and tests/backup-restore.sh against it (BASE=http://127.0.0.1:3190/api, plus SQL_* envs; SERVER_BACKUP_DIR must match the server's BACKUP_DIR). Stop only your own server process.
   d) If a route table snapshot test exists (tests/route-table.json), it must still match except for intentional changes noted by the tracks.
3. If something fails, find the root cause and fix it with the smallest change (you may edit any file now; this is integration). Never skip, delete or weaken a test to get green. If a failure comes from a deliberate behaviour change, update the test minimally and say so. Iterate until green or until you are sure it cannot be fixed within this wave.
4. When green: git add the intended files and commit with message "R1 ${wave.title}: ${wave.tracks.join(', ')}" ending with the two trailer lines:
<the commit trailer lines the session requires>
   Return the commit hash. If not green, do NOT commit; return green=false and the exact remaining failures.
${RULES.split('HOUSE RULES (all agents):')[1].split('\n').filter(l => /Never push|PostgreSQL|pkill/.test(l)).join('\n')}`
}

const results = {}
const done = []
const gates = []
for (let wi = 0; wi < WAVES.length; wi++) {
  const wave = WAVES[wi]
  phase(wave.title)
  log(`starting ${wave.title}: ${wave.tracks.join(', ')}`)
  const reports = (await parallel(wave.tracks.map(t => () =>
    agent(trackPrompt(t, ALL.indexOf(t), done.slice()), { label: t, phase: wave.title, schema: REPORT })
  ))).filter(Boolean)
  reports.forEach(r => { results[r.track] = r })
  const blocked = reports.filter(r => r.status === 'blocked')
  if (reports.length !== wave.tracks.length || blocked.length) {
    log(`STOP: wave ${wave.title} incomplete (reports ${reports.length}/${wave.tracks.length}, blocked ${blocked.map(b => b.track).join(',') || 'none'})`)
    return { stoppedAt: wave.title, results, gates }
  }
  const gate = await agent(gatePrompt(wave, reports, done.slice()), { label: `gate:${wave.title}`, phase: wave.title, schema: GATE })
  gates.push({ wave: wave.title, ...gate })
  log(`${wave.title} gate: ${gate && gate.green ? 'GREEN ' + gate.commit : 'NOT GREEN'}`)
  if (!gate || !gate.green) return { stoppedAt: wave.title + ' (gate)', results, gates }
  done.push(...wave.tracks)
}
return { completed: true, results, gates }

