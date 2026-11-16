# Phase 3: CI, from push to a green run you have actually read

## Before the push: what differs from the dev box

| Trap | Symptom in CI | Fix |
|---|---|---|
| Collation | text `ORDER BY` in another order | `COLLATE "C"`, or sort in code; test on an ICU database |
| Root | tests of read-only files pass locally (root ignores modes) | run new tests as `nobody` with writable HOME/TMPDIR |
| `localhost` | resolves to `::1` | use `127.0.0.1`, or allow both |
| Collection time | code inside `describe` needs `dist/` | read build output inside the test, not at import |
| `spawnSync` | worker heartbeat lost on long commands | async `spawn` |
| Time zone, ICU | formatted dates and digits differ | pin them in format tests |
| Create-if-missing race | two first sign-ins make two rows | advisory lock on the natural key in the same transaction |
| Shared database | one agent drops another's database | a database name and port per agent |
| Teardown | suite green, exit 1, "unhandled error" | handle the pool's `error` event before dropping a database `WITH (FORCE)` |

## After the push: read the run

Never say "passed" for a run you have not read; say "running" and come back. **The run you read must be the run of HEAD**: on
the second project CI was red for five pushes while the report said green, because the green run read was the one before
the last push. Save the run (the API's JSON: `head_sha`, `status`, `conclusion`) and let the tool decide:
```bash
node scripts/ci-head.cjs <run.json> --repo <project>      # FAIL: no run of HEAD, HEAD not pushed, still running, not success
``` If a scheduling tool exists (`send_later`), schedule
one check for when the run should be done instead of polling.

```bash
node scripts/ci-log-digest.cjs <saved job log>            # failing step, the lines that say why, test totals, verdict
node scripts/ci-log-digest.cjs <output file> --local      # the same for a run on this machine
```
Digest the log even when the job is green: an informative step (`continue-on-error`) can be red inside a green job. That is how the
Windows database failure was found.

| Verdict | Meaning | Move |
|---|---|---|
| `NEVER_STARTED` | job ends in seconds with no step | the account: minutes, spending limit, private-repository billing. Re-running does not help. Tell the user where to look; a public repository has free minutes (scan tree and history for secrets first and say what becomes visible) |
| `INFRA_DOWNLOAD` | an external download answered 5xx | re-run the failed job **once**; if it repeats, remove the dependency (use what `npm ci` already installed, add a retry step that also checks the file exists). No unreviewed mirror |
| `TIMEOUT` | a step hit its limit | find why it hangs; an informative step that times out is not evidence |
| `UNHANDLED_AFTER_GREEN` | all tests pass, exit 1 | fix the unhandled error; do not mask the exit code |
| `TEST_FAILURE` | a real failing test | reproduce under CI conditions; never weaken the assertion |
| `MISSING_FILE` | ENOENT in packaging | shell quoting, output path, or a download skipped without an error |
| `ENV_SERVICE_DOWN` | connection refused to the database or another local service | start the service; change no code |
| `ENV_DB_SETUP` | the database, role or schema is not there | create and seed a fresh database for this run |
| `ENV_CONFIG` | the application refused a configuration value | set the value the message names; do not loosen the rule |
| `ENV_PORT_BUSY` | the port is taken | another run is alive: stop it, or use the port the plan gave this track |
| `ENV_TOOL_MISSING` | a command is not installed | install it, or say the check was not run |

A green suite outranks environment words in the same log: a test that prints "connection refused" on purpose is not an outage.
An `ENV_*` verdict is never a reason to edit product code or a test (`references/judgement.md`, section 2).

Evidence of a run belongs to that run. Each job writes its results to `$RUNNER_TEMP/evidence` and uploads them as an artifact;
a final job downloads them all and runs the traceability gate (`assets/kits/validation-roadmap/ci/workflows/traceability.yml`).
Evidence copied into the repository from an earlier run proves nothing about this one.

Lessons that cost a run each:
- **Config file over command-line flags** when a step runs in PowerShell: `-c.electronDist=...` was split and read as a file name.
  The same setting in the build config works in every shell.
- **A skipped download does not fail `npm ci`**: check the binary exists (`electron.exe`) in its own step, with retries.
- **New checks start informative** (`continue-on-error`, a `timeout-minutes`, placed after publishing) until seen green once; then
  make them blocking. A blocking step that hangs holds the release; an informative one must never be cited as proof.
- **A failure that was your own mistake is reported as yours**, plainly, with the fix.
- **A script for a platform you do not have is "not run"** until a CI job on that platform has run it. PowerShell broke twice
  on things no Linux run shows; `ps1-lint.cjs` now catches both (`"$name:"`, psql options after the address).
- **Commit through `checked-commit.cjs`**: the checks, the guard and the commit in one command. `checks ; git commit` once
  committed a type error and a failing test.

## Exit gate

`node scripts/factory.cjs exit ci --log <saved log>[,<saved log>] --run <run.json>`: HEAD is pushed, every digested log has the
verdict OK, and `ci-head.cjs` confirms the run is HEAD's, completed and green. The line that stays with you: the informative
steps were read too.

## Moving repository or account

You cannot take access: the user installs the app on the repository or reconnects GitHub. Never ask for tokens. If a push to a new
remote is refused by a permission check, do not work around it and do not retry: the user adds a rule or pushes. If they upload an
archive instead, extract it into a fresh directory, compare it with `git archive HEAD`, commit it on the work branch, and say that
the history stays in the old repository.
