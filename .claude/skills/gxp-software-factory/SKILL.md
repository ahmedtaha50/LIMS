---
name: gxp-software-factory
description: End-to-end method and toolkits for taking regulated software (GxP, 21 CFR Part 11, Annex 11; LIMS, QMS, batch or equipment records, or any large codebase with a roadmap) from a code review to a validated, installable release using parallel agents. Covers discovery and a file-disjoint roadmap, building in waves with an integration gate, CI follow-up and failure triage, a Windows desktop installer with integrity check and built-in database, an evidence-driven validation package (RTM computed from executed tests, generated URS/FRS/IQ/OQ/PQ/VSR and Functional Specification), and honest status reporting. Use whenever the user says continue, كمل, next release or wave, run the tests, build the installer, CI failed, the installed app shows an error, make the validation or CSV files, functional specification, or asks what is verified, even if they name only one of these.
---

# GxP software factory

A production line for regulated software, distilled from one real project: a pharma LIMS taken from a five-reviewer audit through
three releases (39 tracks, 2,183 tests), a Windows installer with a built-in database, and a validation package whose traceability
is computed from executed evidence. The line has six stations. Most requests enter at one of them; find which, read that station's
reference, and use its tools instead of improvising.

One idea runs through all six: **every claim carries its receipt.** A requirement is "verified" because a named test ran and
passed; an installer is "ready" because the real application started on the target OS in a job you read; a wave is "done" because
a gate ran every check on a fresh database. Where there is no receipt, say "not verified" and open a deviation or a task. Regulated
work fails quietly, by sounding finished.

## Where am I? Pick the station

| The user says / the situation | Station | Read | Tools |
|---|---|---|---|
| "review this system", "what is missing", "make a plan", new codebase | 1 Discovery | `references/discovery.md` | `scripts/roadmap-lint.cjs`, `assets/workflows/discovery.workflow.js`, `assets/examples/roadmap.example.json` |
| "continue", "كمل", "start the wave / release", many features to build | 2 Waves | `references/waves.md` | `assets/briefs/*`, `scripts/reports-digest.cjs`, `scripts/ratchet.cjs`, `assets/workflows/release-waves.workflow.js` |
| pushed; CI red, or failed in seconds; "is it green?"; repo move | 3 CI | `references/ci.md` | `scripts/ci-log-digest.cjs`, `assets/kits/ci/` |
| "build the installer", "I want one file that just runs", built-in database, an error screenshot from the installed app | 4 Installer | `references/installer.md` | `assets/kits/release/`, `assets/kits/embedded-pg/` |
| "validation files", CSV, URS/FRS/RTM/IQ/OQ/PQ, "functional specification" | 5 Validation | `references/validation.md` | `assets/kits/validation/` |
| any status message, "what is done / verified?", a mistake to own | 6 Reporting | `references/reporting.md` | |

First visit to a project: look before acting. Is there a roadmap, an agent manual (`AGENTS.md`), change records, CI workflows, a
`validation/` folder, an installer config? What is the last gate record and the state of the last CI run? Then say in two lines
where the project stands and what you are starting.

Run `bash scripts/selftest.sh` once on a new machine: it proves the tools work there (16 checks).

## The line in one page

1. **Discovery.** Five specialist reviews (read-only, every claim with `file:line`), one synthesis into releases and tracks, then a
   fact-check whose job is to refute each gap. Decide the structure that makes parallel work possible: split the monolith first,
   freeze core tables and add sidecar tables, registries as directories, a migration range per track, shared files only through
   gate patches. `roadmap-lint.cjs` must pass before any agent starts.
2. **Waves.** Tracks build in their own files, test-first against the real database, never commit, and end with a change record, a
   gate patch and a JSON report. One gate agent merges, sums shared counters, regenerates derived files once, runs every check on
   a fresh database and under CI conditions, and commits. The lead only coordinates, verifies and pushes.
3. **CI.** A push is "running" until its jobs are read. Digest the log; the verdict decides the move (account, infrastructure,
   timeout, unhandled error, real failure). New checks start informative and become blocking once seen green.
4. **Installer.** The manifest is written from the packaged folder; the real application is started on the Windows runner before
   anything is published; the database bundle is pinned by hash and the build fails without it. The link goes to the user only
   after the green job is read.
5. **Validation.** One content source, no typed results, a gate that fails when the package claims more than the evidence shows,
   documents generated from the repository. Draft until people sign; AI execution is stated as such.
6. **Reporting.** Outcome first; verified here / verified in CI / not verified; what is not done; decisions only a person can make.

## Rules that hold at every station

- **Never weaken a control to get green.** No deleted assertion, loosened schema, skipped test, or baseline that grew. Known debt
  goes behind a ratchet that can only shrink, tied to a deviation.
- **Never invent** approvals, signatures, regulatory citations, retention numbers, requirement ids presented as approved, or keys
  and certificates. Implement a conservative default and list it as a decision for the user.
- **Test the thing the user will touch**: the built bundle, the packaged folder, the installed application on its OS; the real
  database engine, never a mock.
- **Environment before product.** "Connection refused", a job with no steps, a 504 from a download: fix or report the environment;
  do not change product code to make it pass.
- **Do not commit a tree that is mid-change** (agents writing, a file patched for an experiment). Say why, commit when coherent.
- **A refused permission is an answer.** Do not route around it; tell the user what you needed and why.
- **Diagnosable failures.** An error message carries its cause (the last log lines, the file that differs), so the next failure
  can be read from a screenshot.

## Working with the sibling skills, if they are installed

`gxp-agent-rules` (repository manual and per-change checklist, before the first wave), `gxp-software-architecture` (the controls
themselves), `gxp-validation-package` (document conventions; this skill adds the evidence engine and gate), `gxp-di-assessment`,
`csv-vendor-system`. This skill's `references/waves.md` is the newer form of `gxp-wave-delivery`. None of them is required.

## What to tell the user, every time

Short, in their language (the source project: Egyptian Arabic), failure first if there is one:
what was built or fixed; the numbers; what is not done or not verified; decisions for them; what happens next and when you will
check again. Details: `references/reporting.md`.
