# Inert controls — the nine shapes

A control is **inert** when it exists, reads correctly, and cannot fire. This is
the most dangerous defect class in a regulated system because it manufactures
evidence: a passing test, a "verified" banner, a signature dialog. An absence is
converted into an assurance, and the assurance is what reaches a validation
document.

Every shape below was found in real, running, GxP code. Four were found more
than once in the same system, and two were introduced *by the remediation
written to fix the others*.

## Contents

1. Nothing calls it
2. It reads a field nothing writes
3. It compares different namespaces
4. It covers a value the operation itself changes
5. It verifies the wrong thing
6. No configuration can trigger it
7. It runs inside a transaction that gets rolled back
8. The client enforces it
9. The guard detects by a fragile signal
10. How to search for all nine

---

## 1. Nothing calls it

The function is correct. Its unit test passes. No endpoint imports it.

**Real instance.** A `workflow.ts` exported four segregation-of-duties assert
functions. The only importer in the repository was a test file. CI ran a step
named *"Verify ALCOA+ & Workflow Constraints"* against that test and it passed.
The control was not connected to the application at all.

A pure-function test proves the function is correct. It proves nothing about
whether the application uses it. Collapsing that distinction is how a green
suite coexists with an unguarded system.

**Detection**
```bash
grep -rn "assertSomethingAllowed" --include=*.ts . | grep -v node_modules
```
If every hit is a test file or the definition, the control does not exist. Do
this for every named control function, not only the ones you suspect.

**Fix.** Call it from the path a request actually takes, and rewrite the test to
drive that path.

---

## 2. It reads a field nothing writes

The rule names a column. No code path populates it. The comparison is against
`null` forever, so it never matches, so it never refuses.

**Real instance.** A segregation rule declared the approver must not be the
`qaReviewerId`. No transition ever stamped `qaReviewerId`. The rule was correct,
tested, invoked on every approval — and permanently inert.

This survives review easily: reviewing the rule shows nothing wrong. The defect
is the *absence* of code somewhere else.

**Detection.** For every field a control reads, find what writes it.
```bash
grep -rn "qaReviewerId" --include=*.ts . | grep -v node_modules
```
Reads with no corresponding write is the signature.

**Fix.** Populate the field where the step occurs — then add the structural
test, which is the real fix:

```ts
// Asserts the whole table, not the one case you happened to notice.
expect(sodFieldsWithoutAStamp()).toEqual([]);
```

Populating one field fixes one rule. Asserting the invariant fixes the class.

---

## 3. It compares different namespaces

Two identifiers that can never be equal because they come from different
systems.

**Real instance.** `if (ccr.requesterId === req.user.uid)`. `requesterId` held an
application id (`USR-…`); `uid` held an identity-provider uid. It read as a
correct segregation test and could not fire.

**Detection.** Any comparison of two differently-named identifier variables.
Trace both to their origin.

**Fix.** Resolve the actor once, at the top of every handler, into one canonical
identity. Forbid direct use of the raw provider identifier in business logic,
with a build-gate rule.

---

## 4. It covers a value the operation itself changes

A hash or snapshot that includes a field the very operation being verified is
about to modify. It stops verifying the instant it takes effect.

**Real instance.** An electronic signature's content hash included the record's
`state`. The state change is the *consequence* of the signature, applied in the
same transaction immediately after it — so every signature stopped verifying at
the moment it took effect. The export handled that by reporting "not
re-checkable", which rendered as **Intact**.

Subtle enough that it was introduced deliberately, and correct-seeming, during
remediation. It was found only when a UI test asserted the binding was `true`
for an ordinary signature.

**Detection.** For any hash, snapshot or comparison: list the fields it covers,
then ask which of them the surrounding operation writes. Any overlap is the
defect.

**Fix.** Exclude the fields the operation changes; keep what the signer actually
attested to. Test both directions — unchanged content verifies, altered content
fails.

---

## 5. It verifies the wrong thing

The check runs, produces a result, and the result is not evidence of what it
claims.

**Real instance.** Audit chain verification compared each entry's `prevHash`
against the previous entry's stored `hash` and never recomputed a hash from the
content. Editing `oldValue`, `newValue`, `userName` or `reason` left the chain
reporting itself verified. It could not fail for the case it existed to detect.

**Detection.** Ask what input would make this check return false. If you cannot
construct it, the check is decorative.

**Fix.** Re-derive from the source data, and make the failure informative:
report *which* entry and *why*. A bare `true` is how a non-functioning check
hides.

---

## 6. No configuration can trigger it

The branch exists and no real role, setting or state reaches it.

**Real instance.** A search built a `notSearched` list of entities the caller
lacked permission to read, so an empty result would say "you cannot see these"
rather than "there were none". Every role could read every entity. The path was
unreachable.

Unlike the others, this is sometimes *acceptable* — defensive code for a
configuration that may exist later. What is not acceptable is leaving it
untested, because nobody will notice when it breaks.

**Detection.** For each branch, ask which real configuration reaches it. Check
the actual permission matrix or config table, not the type signature.

**Fix.** Delete it, or exercise it directly with the precondition forced:

```ts
// No role in the current matrix can trigger this, so drive it directly rather
// than through a role that cannot reach it.
ROLE_PERMISSIONS.viewer_auditor = original.filter(p => p !== 'complaint:read');
const res = await searchAll(db, 'viewer_auditor', 'query');
expect(res.notSearched).toContain('complaint');
```

Say in a comment that the path is currently unreachable, so the next reader does
not assume the integration tests cover it.

---

## 7. It runs inside a transaction that gets rolled back

Bookkeeping placed inside the transaction whose failure it exists to record. The
failure rolls back and takes the record of the failure with it.

**This appeared three times in one project.** It is the most repeatable mistake
in the list.

**Real instances.**

- The failed-login counter was incremented inside the transaction, and failure
  was reported by throwing. The increment rolled back. The counter never passed
  one, so **lockout could never engage** — and every happy-path test passed.
- A failed electronic signature threw inside the transaction. The rollback
  correctly left the record untouched and simultaneously erased any audit entry
  for the attempt. Part 11 §11.300(d) expects attempted unauthorised use to be
  detected and reported; nothing recorded it.

**Detection.** For every counter, attempt log or security event: is it written
in the same transaction as the operation that may fail? If yes, and failure is
reported by throwing, it is lost.

**Fix.** Write security bookkeeping on a separate connection, outside the
transaction, before re-throwing:

```ts
try {
  return await runInTransaction(...);
} catch (e) {
  if (isSecurityFailure(e)) {
    await recordAttempt(db, ctx, false, e.code);   // separate connection
    await lockIfRepeatedFailures(db, actor.id);
  }
  throw e;
}
```

The rule to internalise: **a security counter must commit even when — especially
when — the request fails.**

---

## 8. The client enforces it

The check runs in the browser. Anyone with developer tools bypasses it, and it
throws no error while doing so.

**Real instance.** Three signature components compared the typed password
against the literal `'Passw0rd!'` in the browser and called back on success. A
fourth verified server-side but let the record write travel as a *separate*
request, so nothing linked "a password was verified" to "this record changed".

**Detection.** Grep for comparisons of credential-shaped variables in client
code. Separately, check whether the verification and the change it authorises
are one request or two.

**Fix.** One endpoint, one transaction: verify, write the change, write the
signature, write the audit entry — or none of them. Client components collect
input and verify nothing.

Put a comment in the component saying not to add a local check for faster
feedback. It will be suggested again.

---

## 9. The guard detects by a fragile signal

A meta-control watching for the absence of other controls, using a signal that
can silently stop matching.

**Real instance.** A startup assertion refused to boot if any route lacked an
authorisation middleware, detecting it by `Function.name`. A rename, a wrapper
or a minifier would have silently disabled the guard — and a disabled guard
reports success.

**Detection.** Any check that matches on a name, string, file path or line
number rather than an explicit marker.

**Fix.**
```ts
export const PERMISSION_MARKER = Symbol.for('app.permission');
// set on the returned middleware; the startup assertion looks for the symbol
```

---

## 10. How to search for all nine

Cheap mechanical searches first, reasoning last.

```bash
# 1 — controls nothing imports
grep -rn "export function assert" --include=*.ts src/ | while read -r line; do
  fn=$(echo "$line" | sed 's/.*export function \([A-Za-z]*\).*/\1/')
  echo "$fn: $(grep -rl "$fn" --include=*.ts src/ | grep -vc test) non-test file(s)"
done

# 8 — client-side credential checks
grep -rn "password\s*[=!]==" src/components/ src/utils/

# 7 — counters inside transactions
grep -rn -A5 "transaction(" src/ | grep -iE "attempts|counter|failed|locked"

# 9 — name-based detection
grep -rn "\.name ===" src/
```

Shapes 2, 3, 4, 5 and 6 cannot be grepped. They need the two questions:

> For every field this control reads — what writes it?
>
> What input would make this check return false? Construct it.

If the second question has no answer, you have found one.
