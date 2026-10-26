# Auditing an existing system — the forensic order

The goal of the first pass is not a fix list. It is an accurate picture of which
controls exist, which are connected, and which merely appear to be.

## Order of reading

Read in this order, because each step changes how you read the next.

**1. The build and CI configuration, and every script it invokes.**
Do this first. It tells you what the team believes is being verified. In one
project three referenced scripts were 0-byte files, so `npm run verify` passed
by doing nothing — and a CI step named after a compliance standard ran tests
that asserted `true === true`. Knowing that before reading the code changes how
much weight you give a green pipeline.

**2. The test files.**
Before the source. This is where false assurance is manufactured, and it tells
you what the team thinks the controls are. Look for constant assertions,
requirement identifiers with no traceable origin, and tests that call functions
directly rather than driving an interface.

**3. The entry point and every route registration.**
Not for style. Build a list of what is reachable, and note which routes carry an
authorisation middleware. In one project the role-check helper was imported and
applied to zero routes.

**4. The authentication middleware, in full.**
Line by line. This is where bypasses live, and they are usually written as
conveniences: a header for testing, a fixed token, a fallback that decodes an
unverified token when verification fails. All three appeared in one function.

**5. The audit writer, the signature module, the workflow guard.**
For each, answer: who calls this? Is it in the same transaction as the change it
records? What would make it fail?

**6. Migrations and database grants.**
Does the application's own role hold UPDATE and DELETE on the audit table? If
so, immutability is a convention. Check for foreign keys — their complete
absence is common and means orphaned records accumulate silently.

**7. The client-side data layer.**
Look for a local store. Then look at what happens when its sync fails. A
swallowed transport error plus a local write is the persistence defect, and it
reports success.

## What to run early

```bash
# Shape of the problem, mechanically
node check-guardrails.mjs        # from assets/

# Are the "controls" imported by anything but tests?
grep -rn "export function assert" --include=*.ts src/

# Does anything write the fields the rules read?
grep -rn "qaReviewerId\|investigatorId\|ownerId" --include=*.ts src/

# Is there a second audit writer?
grep -rn "insert.*audit" --include=*.ts src/

# Repository hygiene — usually diagnostic of everything else
ls | grep -cE '^(patch|fix|test|update|revert)_'
```

That last count is worth taking seriously. A tree with a hundred ad-hoc scripts
that rewrite source in place has a configuration-management finding regardless
of what the code says: **it is not possible to state what the controlled version
is, or to reconstruct how it reached its present state.** Annex 11 §4 and §10.

## Rank by detectability, not by alarm

The instinct is to lead with the most alarming finding. Resist it. Rank by
whether the failure is *visible*.

A hardcoded password is alarming and obvious — someone will eventually find it.
A list that omits records without saying so is not alarming and nobody will ever
find it, because nothing about the output looks wrong. The second is worse.

In one assessment, eleven of twenty-four failure modes scored maximum on
undetectability. Those set the remediation order.

## Writing the assessment

**Give file and line for every finding.** "The audit trail is not immutable" is
an opinion. "`src/utils/auditLogger.ts:41` truncates the digest to 16 characters"
is a finding. The person receiving this often wrote the code; precision is what
makes it actionable rather than an accusation.

**State what a regulator would see, not just what is technically wrong.** The
consequence is the argument.

**Say what is genuinely good.** In one system the change-control state machine
and the root-cause gate were real quality engineering. Saying so was accurate,
and it made the rest credible.

**Do not soften the verdict.** If validation documents written now would certify
controls that do not exist, say that. It is worse than having no validation
package, and the person needs to hear it before they commission one.

## The question to end on

For every control the system claims: **construct the case where it should
refuse.** If you cannot, you have found an inert control — and that is the
finding, not the missing feature you were originally looking for.
