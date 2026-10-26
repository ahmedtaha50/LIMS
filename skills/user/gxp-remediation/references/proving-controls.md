# Proving a control is wired, not merely written

A test that confirms the expected result is insufficient for any control whose
absence is invisible — because the expected result also occurs when the control
is absent.

That sentence is the whole of this file. Everything below is its consequences.

## The test-suite failure modes

A test suite is a control, and controls get risk-assessed. Eight ways a suite
produces false assurance, all observed:

| # | Failure mode | Why dangerous | Countermeasure |
|---|---|---|---|
| T1 | Asserts a tautology (`expect(true).toBe(true)`) | Reports a requirement verified when nothing ran. Nine such tests existed, each tagged with a requirement id. | Build gate fails on constant assertions |
| T2 | Tests a function the application never calls | The strongest false assurance available: logic correct, test correct, system unguarded | Test through the interface a user reaches |
| T3 | Cannot fail | Passes whether or not the control works | Pair every control test with a negative case |
| T4 | Premise is wrong | Fails against correct behaviour, then gets weakened until it passes | Diagnose before changing. Three such tests were found; the code was right each time |
| T5 | Runs against a different schema than production | Passes against a schema the system does not have | Assert a column from every migration exists |
| T6 | Masks an empty result | A fallback turns "nothing matched" into a pass | Assert empty and populated cases separately |
| T7 | Tests one direction only | A rule blocking everyone passes a test that only checks it blocks the wrong person | Assert the refusal *and* the permitted case |
| T8 | Exercises a path no configuration reaches | Present, correct, permanently inert | Drive it directly with the precondition forced |

T5 deserves emphasis because it is invisible. In one project a test harness
stripped `DO $$ ... $$` blocks so an embedded database could skip role creation.
A later migration used a `DO` block to add columns — and its entire body was
stripped. Had the schema happened to line up, the suite would have passed
**against a schema the system does not have**, which is the one thing that makes
a suite worthless.

## Four properties every control test needs

**1. It drives the real interface.** Not the function. The path from an HTTP
request through the middleware chain to the enforcement. This is the only thing
that distinguishes shape 1 from a working control.

**2. It has a negative case that must fail without the control.** Before
trusting a test, remove the control and confirm the test goes red. If it stays
green, it was testing something else.

**3. It uses genuinely separate actors where the control is about separation.**
Two independent authenticated sessions, not one session with a reassigned
variable. Segregation of duties tested with one session is not tested.

**4. It asserts the state afterwards, not just the response code.** A 401 tells
you the request was refused. It does not tell you the record is unchanged, that
no partial signature was written, or that no orphan audit entry exists. Check
the database.

```ts
it('a wrong password leaves the record COMPLETELY unchanged', async () => {
  const before = await countAuditEntries();
  const res = await session.post(`/api/records/deviation/${id}/transition`,
    { action: 'submit', expectedVersion: 1, password: 'wrong' });
  expect(res.status).toBe(401);

  // The response code is the least interesting assertion here.
  const row = await db.query(`SELECT state, version FROM deviations WHERE id=$1`, [id]);
  expect(row.state).toBe('Draft');
  expect(row.version).toBe(1);
  expect(await countAuditEntries()).toBe(before);
  expect(await countSignatures(id)).toBe(0);
});
```

## Tests that must stay permanently green

Loss of any of these returns the system to its pre-remediation state. Treat
their removal as a change to a validated system.

- Segregation of duties across two independent sessions
- No ownership field named by a segregation rule is left unstamped
- Chain verification detects an altered value
- The database refuses to alter an audit entry
- No audit entry references a non-existent or placeholder actor
- A failed signature leaves no partial state — and IS recorded
- A signature binding survives the transition it authorises
- Configuration cannot widen a permission
- A record written in one session is visible from a fresh one
- A list states its total, and an empty result says so

## Diagnose before you weaken

When a test fails, the code is wrong more often than the test — but not always.
Three tests in one project were wrong while the code was right:

- A test expecting `notSearched` to contain an entity, for a role that could
  read that entity. It would have failed forever against correct behaviour.
- A test expecting more than one audit entry after a create. A create writes
  exactly one entry, because there is no previous value to record.
- A test using an `initiator` for a step only investigators may perform. The
  role matrix refused correctly.

In each case the fix was the test. Changing the code would have removed a
working control to satisfy a wrong expectation — which is how controls quietly
disappear during maintenance.

The discipline: **read the failure, decide which side is wrong, and say which
in the commit.** Never adjust an assertion because it is faster than
understanding it.

## Coverage: gate on regression, not on a number

Demanding 100% coverage immediately is how a team ends up writing tests that
assert nothing to make a number go green — the exact defect being remediated.

Instead: generate the requirement catalogue from the code, take coverage only
from explicit tags in test titles, commit a baseline, and fail the build when a
requirement **loses** coverage.

State uncovered requirements as uncovered. An uncovered requirement declared as
uncovered is honest. A matrix inferring coverage from file names is the same
defect as a test asserting a constant.
