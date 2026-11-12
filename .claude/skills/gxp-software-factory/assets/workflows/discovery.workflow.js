// Discovery: five specialist reviews -> one file-disjoint roadmap -> a fact-check that tries to REFUTE every gap.
// This is the script as it ran on the LIMS project (Workflow tool: agent(), parallel(), pipeline(), phase(), log()).
// To reuse: change COMMON (repository, stack, benchmark products), the PERSONAS, and the release rule in the synthesis prompt.
// Without a Workflow tool, run the same three phases with ordinary agents: see references/discovery.md.
export const meta = {
  name: 'lims-competitive-gap-analysis',
  description: 'Five senior engineers review the B-Pharma LIMS code against market leaders, then synthesize and fact-check a build roadmap',
  phases: [
    { title: 'Review', detail: '5 specialist engineers read the code and list gaps' },
    { title: 'Synthesize', detail: 'merge into one ordered, file-disjoint roadmap' },
    { title: 'Fact-check', detail: 'verify every "missing" claim against the code' },
  ],
}

const GAP = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    competitorBenchmark: { type: 'string', description: 'How LabWare / STARLIMS / Thermo SampleManager / LabVantage / Benchling etc. do it' },
    currentStateEvidence: { type: 'string', description: 'What the repo has today, with file:line evidence, or "absent" with the grep you ran' },
    design: { type: 'string', description: 'Concrete implementable design: tables/columns, endpoints, components, rules' },
    files: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Testable acceptance criteria' },
    effort: { type: 'string', enum: ['S', 'M', 'L'] },
    impact: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    gxpRisk: { type: 'string', description: 'Part 11 / Annex 11 / data-integrity implications of building it' },
  },
  required: ['id', 'title', 'competitorBenchmark', 'currentStateEvidence', 'design', 'files', 'acceptance', 'effort', 'impact'],
}
const REVIEW = {
  type: 'object',
  properties: {
    persona: { type: 'string' },
    strengthsToKeep: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: GAP },
    defectsFound: { type: 'array', items: { type: 'string' }, description: 'Concrete bugs found with file:line' },
  },
  required: ['persona', 'strengthsToKeep', 'gaps', 'defectsFound'],
}

const COMMON = `Repository: /home/user/taha (B-Pharma LIMS: React 19 + Express + PostgreSQL/Drizzle + Electron desktop, GxP/Part 11 oriented). READ-ONLY review: do not edit, commit or run long-lived servers. Read AGENTS.md first (project rules), then the code relevant to your specialty (src/server/api.ts is ~3000 lines, src/db/schema.ts, src/components/*.tsx, src/lib, desktop/, tests/, validation/). Benchmark against what the strongest products do (LabWare LIMS, STARLIMS, Thermo Fisher SampleManager, LabVantage, Benchling, Veeva/MasterControl for QMS). Be specific and honest: every claim about the repo needs file:line evidence; if you assert something is missing, show the grep that proves it. No generic advice. Rank by real value to a pharma QC lab that will run this on a single Windows PC today and grow later. Return 8-14 gaps, most valuable first. Each gap must be implementable by one engineer in the existing stack (no new paid services, no cloud dependency; keep it working offline).`

const PERSONAS = [
  { key: 'lims-domain', p: `You are a LIMS domain architect with 10+ years implementing LabWare/STARLIMS/SampleManager in pharma QC labs. Focus: sample lifecycle and chain of custody, storage locations, labels/barcodes, test plans and method library linked to specifications, worklists/batch runs, result entry and calculation engine, instrument data import (HPLC/balance/pH CSV parsers), CoA generation, stability protocols and pull schedules, environmental monitoring trending, reagent/standard inventory with expiry, customer/product/batch master data, turnaround-time tracking.` },
  { key: 'qa-reg', p: `You are a senior QA/regulatory computerised-systems engineer (GAMP 5, 21 CFR Part 11, EU Annex 11, PIC/S PI 011, ALCOA+, MHRA data integrity guidance). Focus: electronic records/signatures completeness (signature manifestation, re-authentication rules, signature meanings), audit trail review workflow and reason-for-change, data integrity controls, QMS processes a LIMS buyer expects (deviation, CAPA, change control, OOS/OOT workflow phases, document/SOP control with versioning and read-and-understood, training matrix by role), periodic review, retention/archival, controlled reports, validation-readiness features.` },
  { key: 'security', p: `You are a senior application-security and identity engineer. Focus: role/permission model (is there a real RBAC matrix or hard-coded role checks?), authorisation on every route (IDOR, missing checks), session handling and timeout, password policy/expiry/history/complexity, MFA, brute-force protection, secrets handling, input validation coverage (zod strict on every route?), file/attachment handling and size limits, SQL/XSS/CSRF/SSRF, dependency risk, encryption of sensitive data at rest, read-access auditing, SSO/LDAP/AD options for a Windows desktop deployment, Electron hardening (CSP, permissions, update channel). List concrete vulnerabilities as defectsFound with file:line and propose fixes as gaps.` },
  { key: 'frontend-ux', p: `You are a senior frontend/UX engineer who has built enterprise lab software. Focus: information architecture and navigation (src/App.tsx, Layout.tsx), data tables (search/sort/filter/pagination/export), global search, dashboards and role-based home screens, task inbox/worklists, forms and validation feedback, accessibility, responsive/touch (tablet at the bench), Arabic/English i18n with RTL (the customer is in Saudi Arabia), dark mode, charts (Levey-Jennings / control charts, trend plots), print/PDF layouts, performance (the bundle is 2.3 MB single chunk: code-splitting, virtualisation), error/empty/loading states, keyboard workflows, barcode-driven flows. Identify what is mock/placeholder UI vs real.` },
  { key: 'platform', p: `You are a senior platform/backend/devops engineer. Focus: structure of src/server/api.ts (monolith: how to split safely), schema design and the absence of migrations (drizzle push only: design a safe migration strategy for installed desktop databases), indexes, N+1 queries (db.query.*.findMany of whole tables), pagination, transaction usage, background jobs, event/webhook outbound integration, REST/OpenAPI docs, instrument/ERP integration surface, logging/observability/health checks, config management, auto-update and installer (electron-builder, GitHub Releases), CI (.github/workflows), test pyramid (currently shell scripts: propose a real test framework), the 143 patch-*.cjs/fix-*.cjs scripts in the repo root (configuration-management finding: what to delete/archive), performance with 100k+ samples.` },
]

phase('Review')
const reviews = (await parallel(PERSONAS.map(x => () =>
  agent(`${COMMON}\n\n${x.p}`, { label: `review:${x.key}`, phase: 'Review', schema: REVIEW })
))).filter(Boolean)
log(`reviews returned: ${reviews.length}/5; gaps total: ${reviews.reduce((n, r) => n + r.gaps.length, 0)}`)

phase('Synthesize')
const SYN = {
  type: 'object',
  properties: {
    vision: { type: 'string' },
    releases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          goal: { type: 'string' },
          tracks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                track: { type: 'string' },
                gapIds: { type: 'array', items: { type: 'string' } },
                ownsFiles: { type: 'array', items: { type: 'string' }, description: 'Files ONLY this track edits, so tracks can run in parallel without conflicts' },
                dependsOn: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
              },
              required: ['track', 'gapIds', 'ownsFiles', 'summary'],
            },
          },
        },
        required: ['name', 'goal', 'tracks'],
      },
    },
    mergedGaps: { type: 'array', items: GAP },
    topDefects: { type: 'array', items: { type: 'string' } },
    droppedOrDeferred: { type: 'array', items: { type: 'string' } },
  },
  required: ['vision', 'releases', 'mergedGaps', 'topDefects', 'droppedOrDeferred'],
}
const synth = await agent(
  `You are the engineering lead. Five reviewers produced findings (JSON below) about /home/user/taha, a pharma LIMS. Merge duplicates (same gap raised by several reviewers: keep the best design, note who agreed), resolve conflicts, and produce ONE roadmap split into 3 releases (R1 = foundation and highest-value/critical, R2 = competitive feature depth, R3 = differentiators). Inside each release group work into parallel TRACKS whose ownsFiles sets are disjoint (src/server/api.ts is shared: require that R1 first splits it into route modules under src/server/routes/ so later tracks own separate files). Each gap id must appear in exactly one track. Keep GxP rules from AGENTS.md (audit in same transaction, e-signatures with meaning and recordVersion, optimistic concurrency, strict zod, actor from req.user). Put real defects the reviewers found into topDefects. Be decisive; defer what is not worth it and say why.\n\nREVIEWS:\n${JSON.stringify(reviews)}`,
  { label: 'synthesize-roadmap', phase: 'Synthesize', schema: SYN })

phase('Fact-check')
const top = synth.mergedGaps.filter(g => g.impact === 'critical' || g.impact === 'high').slice(0, 16)
const checks = await pipeline(
  top,
  g => agent(
    `Fact-check one claim about /home/user/taha. Gap: "${g.title}". Claimed current state: ${g.currentStateEvidence}. Try to REFUTE "this is missing/inadequate" by searching the code (grep, read the files, check src/components and src/server and src/db/schema.ts). Also verify any file:line evidence cited. Return verdict 'confirmed' only if the gap is real; 'partly' if some of it already exists (say exactly what); 'refuted' if the capability already exists.`,
    { label: `check:${g.id}`, phase: 'Fact-check', schema: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'partly', 'refuted'] }, whatAlreadyExists: { type: 'string' }, correctedEvidence: { type: 'string' } }, required: ['id', 'verdict', 'whatAlreadyExists'] } }
  ).then(v => ({ gap: g.id, title: g.title, ...v }))
)
const verdicts = checks.filter(Boolean)
log(`fact-check: ${verdicts.filter(v => v.verdict === 'confirmed').length} confirmed, ${verdicts.filter(v => v.verdict === 'partly').length} partly, ${verdicts.filter(v => v.verdict === 'refuted').length} refuted`)
return { synth, verdicts, reviewDefects: reviews.map(r => ({ persona: r.persona, defects: r.defectsFound, strengths: r.strengthsToKeep })) }

