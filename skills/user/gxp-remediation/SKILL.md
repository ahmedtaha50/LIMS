---
name: gxp-remediation
description: Audit and remediate an EXISTING GxP/pharma system that already runs — finding controls that look correct but cannot actually fire, then fixing them in dependency order and proving the fixes hold. Use whenever someone asks you to review, assess, audit, fix, harden, or "find the gaps in" a regulated system they already have (eQMS, deviation/CAPA/change control, LIMS-adjacent, batch or equipment records, calibration, any validated application) — including when they just upload a codebase and ask what is wrong with it, ask whether a system is Part 11 or Annex 11 compliant, ask why an audit trail or signature or segregation-of-duties rule "isn't working", or ask you to write validation documents for a system whose controls have never been verified. Also trigger when a system passes its tests but a defect keeps recurring, when someone says their controls are implemented but an inspector or auditor disagreed, or when reviewing your OWN prior remediation work. Distinct from gxp-software-architecture (designs a new system), gxp-agent-rules (rules for writing code in one), gxp-validation-package (documents one), csv-vendor-system (vendor-supplied equipment) and gxp-di-assessment (installed equipment). This one is for a bespoke application that exists, that people rely on, and whose controls may be decorative.
---

# Remediating a GxP system that already runs

The hardest defect in a regulated system is not a crash. It is a control that
is present, reads correctly, passes review, passes its own unit test, and
**cannot fire**.

Such a control is worse than a missing one. A missing control is a gap someone
can find. An inert control produces evidence — a green test, a "verified"
banner, a signature dialog — that the thing is handled. It converts an absence
into a false assurance, and false assurance is what reaches a validation
document.

This skill is the method for finding them, fixing them in an order that holds,
and proving the fix is wired rather than merely written.

## Read this first

The single governing question, applied to every control:

> **If someone bypassed the user interface entirely and called the API or the
> database directly, would this control still hold?**

And its harder sibling, which is where the real damage lives:

> **Can this control fail? Construct the case where it should refuse — and
> verify it refuses. If you cannot construct that case, the control is inert.**

## The nine shapes of an inert control

Read `references/inert-controls.md` for the full catalogue with detection
methods and worked examples. In summary, a control is inert when:

1. **Nothing calls it.** The function is correct, tested, and imported by no
   endpoint.
2. **It reads a field nothing writes.** The rule names an ownership column that
   no code path ever populates, so the comparison never matches.
3. **It compares the wrong namespaces.** Two identifiers from different systems
   (a database id against a provider uid) can never be equal.
4. **It covers a value the operation itself changes.** A signature hash that
   includes the status the signature is about to change stops verifying the
   instant it takes effect.
5. **It verifies the wrong thing.** A chain check that compares link columns
   without re-deriving the content.
6. **No configuration can trigger it.** An exclusion path that no real role or
   setting can reach.
7. **It runs in a transaction that gets rolled back.** Bookkeeping placed
   inside the transaction whose failure it is meant to record.
8. **The client enforces it.** A password compared in the browser.
9. **A guard detects by a fragile signal.** A startup check that matches on a
   function name, silently disabled by a rename or a minifier.

Shapes 2, 4, 6 and 7 are the ones that recur most and are the hardest to see in
review, because the code is correct in isolation. Each was found more than once
in the project this skill came from, **including in remediation work written to
fix the others**.

## Method

### 1. Read before judging

Read the whole tree before forming conclusions. Specifically read:

- the entry point and every route registration — not to review style, but to
  list what is reachable
- the auth middleware, in full, line by line
- the audit writer, the signature module, the workflow guard
- the migration files and the database grants
- **the test files** — this is where false assurance is manufactured
- the CI configuration and every script it invokes

Then grep for the specific shapes. `assets/check-guardrails.mjs` automates the
mechanical ones; run it early to get the shape of the problem.

### 2. Trace each control from the interface inward

For every control the system claims, find the path from an HTTP request to the
enforcement, and confirm it is unbroken. A control that cannot be reached from
a request is inert regardless of how correct it is.

The two questions that find shape 1 and shape 2:

- Who imports this? (`grep -rn "assertX" --include=*.ts .`) If only a test
  imports it, the control does not exist.
- What writes this field? If a rule reads `qaReviewerId`, find the code that
  sets it. If nothing does, the rule is decorative.

### 3. Judge severity by detectability, not by noise

Rank findings by whether the failure is visible. A control failure that throws
an error will be found. A control failure that lets the system continue
normally and report success will not.

In the source project, eleven of twenty-four failure modes scored maximum on
undetectability. Those are the ones to fix first, regardless of how alarming
the others sound.

### 4. Fix in dependency order

Read `references/remediation-sequence.md`. The order matters because later work
is meaningless without earlier work — there is no point enforcing segregation
of duties on top of an identity anyone can forge.

### 5. Prove it, and prove it can fail

Read `references/proving-controls.md`. Every control gets a test that drives
the real interface, and a negative case that must fail when the control is
removed. A test that confirms the expected result is insufficient for any
control whose absence is invisible, because the expected result also occurs
when the control is absent.

### 6. Gate it

Add `assets/check-guardrails.mjs` to the build. Rules constrain the developer
who reads them; a build gate constrains everyone, permanently. Every defect
found should end as either a test, a gate rule, or both.

## Honesty rules that this domain specifically requires

These are not general good manners. Each one exists because breaking it
produces a document that certifies something untrue.

**Never claim execution you did not perform.** Environment qualification runs
on the customer's server. If you cannot reach it, deliver the protocol and say
plainly that the evidence is theirs to produce. A collector that cannot check
something must name what it could not check — a clean report with silent
omissions proves less than it appears to.

**Never re-hash history to make verification pass.** Audit entries written by a
broken implementation cannot be honestly re-verified. Mark the boundary, state
it as a residual risk, and leave the entries unaltered. Rewriting them is
falsification.

**Never declare a residual risk that does not exist.** On a fresh install, do
not record a legacy segment as unverifiable. An inspector reading "not
independently verifiable" about entries that never existed is worse than
silence.

**State uncovered requirements as uncovered.** A traceability matrix that
reports coverage from inference rather than explicit declaration is the same
defect as a test asserting a constant.

**When your own fix introduces the pattern you were fixing, say so.** In the
source project this happened twice. Recording it is what stops the third time.

## What to expect to find

Read `references/recurring-defects.md` for the full catalogue with fixes. The
defects that appear in nearly every bespoke regulated application:

| Area | What is usually wrong |
|---|---|
| Identity | A bypass path — a header, a test token, a fallback that decodes an unverified token |
| Authorisation | A role-check helper that exists and is attached to nothing |
| Audit | Two competing writers, non-transactional writes, truncated hashes, a placeholder actor fallback |
| Signature | Verified client-side, or applied in a separate operation from the change it authorises |
| Workflow | A generic endpoint that writes whatever status it is sent |
| Concurrency | A version compared in memory and not in the write predicate |
| Persistence | A client-side store whose transport failure is swallowed |
| Numbering | A counter on the client |
| Lists and exports | A page shown without the matching total |
| Tests | Assertions of constants, tagged with requirement identifiers |

## Working with the person

They are usually the author of the system, or responsible for it. The findings
are severe and the tone matters.

Be direct about what is wrong and precise about why it matters — evasion here
costs them more than bluntness does. But separate the design from the defect:
in the source project the domain modelling, the state machine for change
control and the root-cause gate were genuinely good work, and saying so was
accurate rather than kind.

Where a decision belongs to them — retention periods, whether a configurable
workflow stays, whether task completion carries a signature — ask once, state
the trade-off, and if they delegate it back, decide with the reasoning written
down rather than buried.

## Reference files

| File | Read it when |
|---|---|
| `references/inert-controls.md` | Auditing; this is the core content |
| `references/audit-method.md` | Starting an assessment — the forensic order |
| `references/proving-controls.md` | Writing tests for any control |
| `references/remediation-sequence.md` | Planning the work |
| `references/recurring-defects.md` | You have found something and want the known fix |

| Asset | Use |
|---|---|
| `assets/check-guardrails.mjs` | Drop into the repo; wire into CI |
| `assets/build-rtm.mjs` | Traceability from code, coverage from explicit tags |
| `assets/evaluate-risk.mjs` | Assessing component-level vulnerabilities automatically |
