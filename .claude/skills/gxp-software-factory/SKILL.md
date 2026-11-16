---
name: gxp-software-factory
description: End-to-end method, guards and toolkits for taking regulated software (GxP, 21 CFR Part 11, Annex 11; LIMS, QMS, batch or equipment records, or any large codebase with a roadmap) from a code review to a validated, installable release using parallel agents. Covers discovery and a file-disjoint roadmap, building in waves with an integration gate, CI follow-up and failure triage, a Windows desktop installer with integrity check and built-in database, an evidence-driven validation package (RTM computed from executed tests, generated URS/FRS/IQ/OQ/PQ/VSR and Functional Specification), and honest status reporting, with an exit gate per stage that holds the work against the plan and the regulations. Use whenever the user says continue, كمل, next release or wave, run the tests, build the installer, CI failed, the installed app shows an error, make the validation or CSV files, functional specification, or asks what is verified, even if they name only one of these.
---

# GxP software factory

A production line for regulated software, distilled from one real project: a pharma LIMS taken from a five-reviewer audit through
three releases (39 tracks, 2,183 passing tests), a Windows installer with a built-in database, and a validation package whose
traceability is computed from executed evidence.

Two ideas hold it together.

**Every claim carries its receipt.** A requirement is "verified" because a named test ran and passed; an installer is "ready"
because the real application started on the target OS in a job you read; a wave is "done" because its exit gate passed. Where
there is no receipt, the words are "not verified", and the item goes on a list. Regulated work fails quietly, by sounding finished.

**Every guard was seen catching its fault.** The tools below are not advice; each one refuses a specific mistake that happened,
and `scripts/selftest.cjs` plants that mistake and watches the tool refuse it.

## Start here, every time

```bash
node scripts/factory.cjs status --repo <project>          # where the project stands, and which station comes next
```
Then, for that station: read its reference, do the work with its tools, and close it with its exit gate.
```bash
node scripts/factory.cjs exit <station> --repo <project>  # discovery | wave | gate | ci | installer | validation | report
```
PASS and FAIL lines are checked by tools. MANUAL lines are yours to prove, and each says what counts as proof. A FAIL is fixed, or
the station is reported as not done: it is never argued away, and no check is loosened to turn it green. Paste the gate's result
into your report; it is the receipt.

The scripts live in this skill's folder: call them by their full path and point `--repo` at the project. On a new machine, and
after editing any tool, run `node scripts/selftest.cjs` (or `bash scripts/selftest.sh`): it must end with "selftest OK".

## Stations

| The user says / the situation | Station | Read | Exit gate |
|---|---|---|---|
| "review this system", "what is missing", "make a plan", a new codebase | 1 Discovery | `references/discovery.md` | `exit discovery` |
| "continue", "كمل", "start the wave / release", many features to build | 2 Waves | `references/waves.md` | `exit wave`, then `exit gate` |
| pushed; CI red, or failed in seconds; "is it green?"; moving repository | 3 CI | `references/ci.md` | `exit ci` |
| "build the installer", "one file that just runs", built-in database, an error screenshot from the installed app | 4 Installer | `references/installer.md` | `exit installer` |
| "validation files", CSV, URS/FRS/RTM/IQ/OQ/PQ, "functional specification" | 5 Validation | `references/validation.md` | `exit validation` |
| any status message, "what is done / verified?", a mistake to own | 6 Reporting | `references/reporting.md` | `exit report` |

Three references serve every station:
- `references/judgement.md`: look-alike situations and the move for each (environment or product, how strong a proof is, what a
  leftover is, ask or act, when to stop, how to read a short message). Read the fitting table before a decision that is not obvious.
- `references/failure-catalogue.md`: every failure of the source project with its cause, the move, and the guard that now catches it.
  Search it for the symptom before diagnosing from nothing.
- `references/regulatory-anchors.md`: how to cite a regulation, and the words ("validated", "compliant", "approved") that may be
  used only when their condition holds.

## Four promises, and what enforces each

| Promise | Enforced by |
|---|---|
| The plan is followed | `roadmap-lint.cjs` (no file with two owners, every gap in one track), `make-briefs.cjs` (briefs generated from the plan), `ownership-audit.cjs` (tracks stayed in their files), `reports-digest.cjs --roadmap` (every acceptance criterion answered with a named test), `open-items.cjs` (leftovers stay on a list), the exit gates |
| The references are followed | `citation-check.cjs` (no clause that does not exist), `manual-check.cjs` (the agent manual matches the code), `evidence-fresh.cjs` (evidence belongs to the code that is checked in), the traceability gate of `assets/kits/validation/` (nothing claimed beyond what was executed) |
| Mistakes are caught before they ship | `precommit-guard.cjs` (temporary edits, focused or skipped tests, secrets, junk), `ratchet.cjs` (known debt can only shrink), `ci-log-digest.cjs` (the verdict decides the move), `skill-lint.cjs` and `selftest.cjs` (this skill itself) |
| Look-alikes are told apart | `references/judgement.md`, `references/failure-catalogue.md`, the verdict classes of `ci-log-digest.cjs` |

## The line in one page

1. **Discovery.** Five specialist reviews (read-only, every claim with `file:line`), one synthesis into releases and tracks, then a
   fact-check whose job is to refute each gap. Decide the structure that makes parallel work possible: split the monolith first,
   freeze core tables and add sidecar tables, registries as directories, a migration range per track, shared files only through
   gate patches. Write the project facts once (`factory.config.json`). The roadmap lints clean before any agent starts.
2. **Waves.** Briefs are generated, not typed. Tracks build in their own files, test-first against the real database, never commit,
   and end with a change record, a gate patch and a report that answers each acceptance criterion with a test. The lead audits
   ownership and the ledger; one gate agent merges, sums shared counters, regenerates derived files once, runs every check on a
   fresh database under CI conditions, and commits. Leftovers go into the open-items register before the push.
3. **CI.** A push is "running" until its jobs are read. Digest the log, green jobs included; the verdict decides the move. New
   checks start informative and become blocking once seen green on the target.
4. **Installer.** The manifest is written from the packaged folder; the real application is started on the Windows runner before
   anything is published; the database bundle is pinned by hash and the build fails without it. The link goes to the user only
   after the green job is read.
5. **Validation.** One content source, no typed results, a gate that fails when the package claims more than the evidence shows,
   documents generated from the repository, evidence tied to a commit. Draft until people sign; AI execution is stated as such.
6. **Reporting.** Outcome first; verified here, verified in CI, or not verified; what is not done, read from the register;
   decisions only a person can make.

## Rules that hold at every station

- **Never weaken a control to get green.** No deleted assertion, loosened schema, skipped test, or baseline that grew.
- **Never invent** approvals, signatures, regulatory citations, retention numbers, requirement ids presented as approved, keys or
  certificates. Implement a conservative default and list it as a decision for the user.
- **Test the thing the user will touch**: the built bundle, the packaged folder, the installed application on its OS; the real
  database engine, never a mock. Claim at the rung of evidence you reached (`references/judgement.md`, section 3).
- **Environment before product.** "Connection refused", a job with no steps, a 504 from a download: fix or report the environment;
  product code is not changed to make it pass.
- **Temporary edits carry the marker `FACTORY-TEMP`**, so the pre-commit guard refuses them. Do not commit a tree that is
  mid-change (agents writing, a file patched for an experiment): say why in one line, commit when it is coherent.
- **Start agents only when you are allowed to.** If the session permits agents only on request, ask once or build the tracks in
  sequence yourself; the ledger, the gate and the exit gates are the same.
- **A refused permission is an answer.** Do not route around it; tell the user what you needed and why.
- **Diagnosable failures.** An error message carries its cause (the last log lines, the file that differs), so the next failure
  can be read from a screenshot.

## Tools (in `scripts/`; each prints its usage in its first lines)

| Tool | Answers |
|---|---|
| `factory.cjs` | where does the project stand (`status`); may this station be called done (`exit <station>`) |
| `roadmap-lint.cjs` | can this roadmap be built in parallel; which tracks run in which wave, with a database and a port each |
| `make-briefs.cjs` | the brief of every track of a wave, and of its gate, filled from the plan and `factory.config.json` |
| `ownership-audit.cjs` | did each track stay inside the files the plan gave it |
| `reports-digest.cjs` | are all reports in, and did each answer its acceptance criteria with evidence |
| `open-items.cjs` | what is still open: not done, unmet criteria, decisions for the user, open deviations |
| `precommit-guard.cjs` | does this commit carry a temporary edit, a focused or skipped test, a secret, or junk |
| `ratchet.cjs` | did a list of known findings grow |
| `ci-log-digest.cjs` | why did this run fail: account, infrastructure, timeout, environment, or a real failure (`--local` for this machine) |
| `evidence-fresh.cjs` | is the validation evidence about the code that is checked in |
| `citation-check.cjs` | does every cited clause exist (`--list` prints what may be cited) |
| `manual-check.cjs` | does the agent manual describe the code that exists |
| `skill-lint.cjs` | does this skill point only at files that ship with it, and are its kits complete |
| `selftest.cjs`, `selftest.sh` | do all of the above work here: clean cases pass, planted faults are caught |
| `typecheck.sh` | optional, for whoever edits the tools: strict TypeScript check of the JavaScript (JSDoc types, data shapes in `scripts/lib/types.d.ts`); installs a pinned TypeScript into a cache folder |

How the tools are built, so that changing one stays safe: every tool is a module that exports `main(argv, io)` and returns its
exit code (`scripts/lib/runtime.cjs`); none touches `process.exit` or the console directly. The conductor and the drill call the
tools as functions in one process, which is why the drill runs in about 3 seconds instead of 8. Pure logic (glob matching and
overlap, CSV, arguments, the runner) lives in `scripts/lib/` with unit tests in `scripts/tests/` (`node:test`), including
randomised tests checked against brute force. After editing a tool: `node scripts/selftest.cjs`, and `bash scripts/typecheck.sh`
when Node can reach the npm registry.

Templates and kits: `assets/briefs/` (track and gate briefs, report schema, project facts), `assets/workflows/` (discovery and
release scripts for a Workflow tool), `assets/examples/roadmap.example.json`, `assets/kits/` (release integrity, built-in
PostgreSQL, validation engine, CI workflows; `assets/kits/README.md` says what each one was proven on).

## Working with the sibling skills, if they are installed

`gxp-agent-rules` (repository manual and per-change checklist, before the first wave), `gxp-software-architecture` (the controls
themselves), `gxp-validation-package` (document conventions; this skill adds the evidence engine and gate), `gxp-di-assessment`,
`csv-vendor-system`. This skill's `references/waves.md` is the newer form of `gxp-wave-delivery`. None of them is required.

## What to tell the user, every time

Short, in their language (the source project: Egyptian Arabic), failure first if there is one: what was built or fixed; the
numbers; what is not done or not verified; decisions for them; what happens next and when you will check again.
Details: `references/reporting.md`.
