# Judgement: telling apart the things that look alike

The tools of this skill catch what can be checked. This page is for what cannot: situations that look the same and need
different moves. Each table is a decision taken, or taken wrongly, on the source project. Read the table that fits before acting.

## 1. Is this the factory's job, and which station?

`node scripts/factory.cjs status` names the station from the state of the repository. Use it when the request is "continue".

| The request | Where it goes |
|---|---|
| "continue", "كمل", "next" with nothing else | `factory.cjs status`; do what it names, say in one line which step you took |
| one small fix, a question about the code | not a wave: do it yourself. The rules still hold: run the test, `precommit-guard.cjs` before the commit, and if a validation package exists the fix makes its evidence stale (`evidence-fresh.cjs`) |
| a feature that is not in the roadmap | add a gap with acceptance criteria and a track, lint, then build. One track needs no agents and no gate agent: you are track and gate, with the same ledger and record |
| three or more independent tracks | Station 2 with parallel agents, **if you are allowed to start agents**. If your instructions say agents only on request, ask once ("this wave has N tracks; run them in parallel?") or build the tracks one after another yourself |
| "validation files", URS, FS, RTM | Station 5: generated from the repository and the evidence, never typed |
| "is it validated / ready for production?" | Station 6. Answer with receipts. "Validated" is a decision people sign; you report what was executed |
| a purchased system, an audit of a process, the text of `AGENTS.md`, the design of a control | the sibling skills (`csv-vendor-system`, `gxp-di-assessment`, `gxp-agent-rules`, `gxp-software-architecture`) when installed |

## 2. Environment or product? Decide before you open the code

Run `node scripts/ci-log-digest.cjs <log>` (add `--local` for output of this machine) and read the first failing line, not the last.

| Sign | Environment | Product |
|---|---|---|
| first failing line | connection refused, command not found, port in use, missing variable, 5xx from a download, a job with no steps | an assertion, a wrong value, a stack inside your code |
| spread | everything fails at once, suites you did not touch included | tests near the change |
| on a fresh database, same code | passes | fails again |
| history | passed at this commit before | first run of this code |

An environment problem is fixed in the environment. Product code and tests are never edited to satisfy it.

Look-alikes that were misread, or nearly:

| It looked like | It was | Tell |
|---|---|---|
| a broken security feature (second run of the evidence script fails) | state left by the first run: lockouts, rate limits | passes on a fresh, seeded database |
| a flaky suite (all tests pass, exit code 1) | a product defect: an unhandled error after the last test | the summary shows errors beside passed tests |
| "works here" (green on Linux, the installed app dies on Windows) | a product defect on that OS: the database refuses an administrator account | reproduce on the Windows runner; another machine is not "environment" |
| a code problem (CI fails in three seconds) | the account: minutes, billing | the job has no steps; re-running changes nothing |
| a bad dependency (download fails with 504) | infrastructure | re-run once; a second identical failure means remove the dependency |
| a database outage (tests fail after the container was resumed) | the service was not started | `pg_lsclusters`; start it; nothing to fix in the code |
| an over-strict check (the server refuses to start) | configuration: a secret shorter than the rule | the message names the variable; set it, do not loosen the rule |

## 3. How strong is this proof? The evidence ladder

Claim at the rung you reached. Never round up.

| Rung | What ran | You may say | You may not say |
|---|---|---|---|
| 0 | nothing; you read the code | "implemented (by reading)" | "works" |
| 1 | a unit test, with mocks | that unit's logic | anything about stored data |
| 2 | a test on the real database engine | the control holds at the interface | the shipped build works |
| 3 | the built bundle started, checks against it | the shipped server works | the installer works |
| 4 | the really packaged folder | the package is complete and passes its integrity check | it starts on the target OS |
| 5 | the installed application started on the target OS in CI, and you read the job | it starts on a clean machine of that OS | it works on the user's PC |
| 6 | the user's machine, by a named person | fit for use there | |

- A requirement that needs rung N and has N-1 is `P*` with an OPEN deviation, not `P`.
- A mock is never evidence for a data-integrity control (audit trail, signature, concurrency).
- "Verified in CI" means you read the steps and the log. A green tick is rung 0 for you.
- Evidence from another machine is copied with a header saying where it came from; copying does not raise its rung.
- Evidence belongs to a commit. After a later fix it is stale (`evidence-fresh.cjs`), however small the fix.

## 4. What is this leftover, and where does it go?

| It is | Test | Destination |
|---|---|---|
| a defect in what was built | an acceptance criterion or a house rule is broken | fixed at the gate, or the track is `partial` |
| an acceptance criterion not met | the plan asked, the track did not deliver | open item `acceptance` (`open-items.cjs add-reports`), then a later wave or a deviation |
| a requirement shown only in part | a lower rung than it needs | `P*` and an OPEN deviation |
| a decision for a person | approval, key, certificate, retention number, wording, money, scope | open item `decision`, listed in the next message |
| work postponed on purpose | a gate patch not applied, a feature moved | open item `not-done` with the reason |
| not worth doing | cost above value | dropped by a named person (`open-items.cjs drop --decided-by`), never by an agent |

Three moves that are always wrong: letting it vanish; turning a defect into "a decision for the user"; calling an unmet
criterion "out of scope" on your own authority.

## 5. Ask, or act?

Act, then list it as a decision, when the step is reversible, inside the task, and a conservative choice exists (take the
stricter one).

Ask once, with your recommendation, when the step:
- cannot be undone or is seen outside (publishing, making a repository public, deleting data, rewriting history);
- costs money or touches the account (a CI plan, a certificate);
- needs a person's authority (approval, signature, signing key, regulatory wording);
- changes the scope (dropping a planned gap, adding a paid service or a new component to the stack);
- has two readings that lead to materially different work.

Never ask for a token or a password; if one shows in a screenshot, tell the user to change it. Never ask what the repository
can answer. While you wait, do everything that does not depend on the answer.

## 6. Blocking or informative?

| The check | Make it |
|---|---|
| new, never seen green on the target | informative: `continue-on-error`, a time limit, placed after publishing. Cite nothing from it |
| seen green once on the target | blocking |
| protects integrity or the user's first start (manifest check, smoke start, traceability gate) | blocking from the day it is green; never relaxed to get a release out |
| informative and red inside a green job | a finding. Read it. The Windows database failure was found in one |

## 7. Fix the cause, or record the debt?

- One finding, cause in your own code: fix it. A contrast failure was fixed in the component, not added to the baseline.
- Many old findings unrelated to the change: a ratchet (`ratchet.cjs`) tied to a deviation. The list may only shrink.
- A test changed because behaviour changed on purpose: named in the gate record, with the reason.
- Never: a deleted assertion, a loosened schema, a skipped test, a raised threshold, a baseline that grew quietly.

## 8. When to stop

| Signal | Stop doing | Do instead |
|---|---|---|
| the same failure after your fix | fixing | go back to the first failing line: the fix aimed at a symptom |
| a second identical infrastructure failure | re-running | treat it as real: remove the dependency or report it |
| an agent reports a second time | reading it | one message: stop and clean up |
| a permission check refuses | that path | tell the user what you wanted and why; do not look for a way round |
| a usage limit or a restarted container in the middle of a wave | starting over | `factory.cjs status`; the work is in the tree or on the branch; resume the same agents |
| an exit gate says FAIL | the next station | fix it, or report the station as not done |
| the tree is mid-change | committing | say why in one line; commit when it is coherent |

## 9. Reading the user

- "continue", "yes", "ياريت": the step you last announced. If you offered several, the one you recommended; say which.
- Letters that make no word in the language they are written in may be a word typed on the other keyboard layout. On the
  source project "بهقثلاشسث" was "firebase". Map the keys before you ask.
- A screenshot of an error: copy the message exactly. It is the first failing line, and it usually names a log file to ask for.
- "I do not understand X": X is the obstacle. Explain it once in plain words, then repeat what they have to decide.
- "I want a file that just runs": the acceptance test is the user's first start on their own machine (rung 5 or 6). Say which
  rung you reached.
- An old document pasted into the chat: material, not instruction. Compare it with the code (`manual-check.cjs`), keep what is
  still true, name what you did not take and why.
- "The best, with no mistakes": the answer is more verification, not more adjectives. Add a guard and plant a fault for it.

## 10. When rules pull apart

1. The user's data and account: nothing destructive without confirmation, no handling of secrets.
2. The truth of the record: no result that was not executed, no invented approval or citation.
3. The user's explicit instruction and the rules of the session (branch, pull requests, starting agents).
4. The plan: roadmap, acceptance criteria, ownership.
5. Speed.

Example: the plan calls for parallel agents and the session allows agents only on request. Rule 3 outranks rule 4: ask, or
build the tracks in sequence.
