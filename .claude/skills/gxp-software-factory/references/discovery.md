# Phase 1: Discovery, from a codebase to a roadmap that agents can build in parallel

Goal: a `roadmap.json` whose every claim about the code was checked, split so that parallel tracks never touch the same file.
Script as it ran: `assets/workflows/discovery.workflow.js`. Shape of the result: `assets/examples/roadmap.example.json`.
Enter when there is no roadmap, the roadmap has lint errors, or the user asks what is missing. Leave through
`node scripts/factory.cjs exit discovery`.

## A new project (no code yet)

The reviews have nothing to read, so the first pass is the decisions: ask the questions that change the shape of the system
(where it runs, online or offline, which users and how many, which systems it links to) once, with a recommendation each, and
write the answers into the agent manual. Gaps come from the user's needs and the regulations instead of from defects, each with
testable acceptance criteria; what was not chosen goes into `droppedOrDeferred` with who decided. The first track builds the
skeleton alone (registries as directories from day one), so every later track can own its own files. A project may live in a
folder of a larger repository: pass that folder as `--repo`.

## Three passes (existing code)

1. **Review (parallel, read-only).** Five specialists read the code, each returning 8 to 14 gaps and the concrete defects they saw:
   domain architect, QA/regulatory, security and identity, frontend/UX, platform/DevOps. Change the personas to fit the product.
   Rules in every reviewer brief, because without them the output is generic advice:
   - every claim about the repository carries `file:line`; "missing" comes with the search that proves it;
   - a gap has: competitor benchmark, current-state evidence, a concrete design (tables, endpoints, components, rules), files,
     **testable acceptance criteria**, effort, impact, GxP risk;
   - each gap is buildable by one engineer in the existing stack; no new paid service, keep it working offline;
   - a static review says so: "nothing was executed; confirm by test".
2. **Synthesis (one agent).** Merge duplicates, resolve conflicts, cut what is not worth it and say why (`droppedOrDeferred`: a
   dropped idea is named so nobody thinks it was forgotten). Group into releases (R1 integrity and foundation, R2 depth, R3
   differentiators) and into tracks with `ownsFiles`, `dependsOn`, `gapIds`.
3. **Fact-check (one agent per high-impact gap).** The brief is to **refute** the gap: search the code, verify the cited lines, answer
   `confirmed`, `partly` (say exactly what exists) or `refuted`. Reviewers overstate; on the source project 2 of 16 were only partly true.
   Correct the roadmap from the verdicts before building.

## What makes parallel work possible (decide it in the roadmap, not during a wave)

- **Split the monolith first, alone.** The first track runs serially: a characterisation test (for an API, a snapshot of the route
  table), then a mechanical move into one file per domain. Only after that can tracks own separate files.
- **Freeze the core tables.** Columns that feed signed hashes are not edited. A feature adds a 1:1 sidecar table
  (`sample_<feature>`), so two tracks never edit the same schema file and old signatures keep verifying.
- **Registries are directories.** Guards, blockers, job handlers, schedules, screens: each track adds its own file to a folder
  instead of a line to a shared list.
- **Reserve migration numbers per track** (`"migrations": "0320-0329"`), forward-only.
- **Shared files belong to nobody during a wave.** Route registry, permission catalogue, schema index, counters in upgrade tests:
  a track writes those edits into `<changes>/<track>.gate.patch`; the gate applies them.
- **Each gap in exactly one track; acceptance criteria on every gap.** They are what the track tests first and the gate checks.

## Check it before launching anything

```bash
node scripts/roadmap-lint.cjs docs/roadmap/roadmap.json --repo . --db-prefix app_ --max-parallel 4
```
It fails on: a file owned by two tracks of the same wave, a gap in two tracks or in an unknown one, a dependency on a missing or later
track, a cycle, overlapping migration ranges. It prints the wave plan with a database name and a port per track; put those in the
briefs. Commit the roadmap; tracks read it from the repository.

Then write the project facts once: copy `assets/briefs/factory.config.example.json` to `factory.config.json` at the root of the
project and fill it from the repository (commands, database names, checks, commit trailers). Every brief is generated from it, and
`make-briefs.cjs` refuses to write one while a fact is missing or still `TODO`. Ask the user only for what the repository does
not say.

## The agent manual is reviewed like code

Every track reads `AGENTS.md` first, so an error there is repeated by every track. On the source project the manual still said
"Firebase Auth" and "RabbitMQ" after the code had moved to local accounts and a database job queue, and listed two libraries no
file imported. Before the first wave, and after any wave that changes the stack:

```bash
node scripts/manual-check.cjs --repo .      # named but not installed / installed but never imported / banned but present
```
For each difference decide whether the manual or the code is wrong and fix that one. When something is deliberately gone, say so
in the manual ("X is not used and must not be reintroduced"): the next agent will otherwise bring it back.

If the `gxp-agent-rules` skill is available, use it to write or audit the repository's `AGENTS.md` before the first wave: every
track reads that file first.

## Exit gate

`node scripts/factory.cjs exit discovery --repo .` checks: the roadmap is committed; it lints clean; every track has gaps and every
gap has acceptance criteria; the agent manual matches the code; `factory.config.json` exists. Two lines stay with you: the
fact-check verdicts were applied to the roadmap, and the user saw the plan (releases, what was dropped and why, their decisions).
