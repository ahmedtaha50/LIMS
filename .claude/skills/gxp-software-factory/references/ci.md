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

Never say "passed" for a run you have not read; say "running" and come back. If a scheduling tool exists (`send_later`), schedule
one check for when the run should be done instead of polling.

```bash
node scripts/ci-log-digest.cjs <saved job log>      # failing step, the lines that say why, test totals, verdict
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

Lessons that cost a run each:
- **Config file over command-line flags** when a step runs in PowerShell: `-c.electronDist=...` was split and read as a file name.
  The same setting in the build config works in every shell.
- **A skipped download does not fail `npm ci`**: check the binary exists (`electron.exe`) in its own step, with retries.
- **New checks start informative** (`continue-on-error`, a `timeout-minutes`, placed after publishing) until seen green once; then
  make them blocking. A blocking step that hangs holds the release; an informative one must never be cited as proof.
- **A failure that was your own mistake is reported as yours**, plainly, with the fix.

## Moving repository or account

You cannot take access: the user installs the app on the repository or reconnects GitHub. Never ask for tokens. If a push to a new
remote is refused by a permission check, do not work around it and do not retry: the user adds a rule or pushes. If they upload an
archive instead, extract it into a fresh directory, compare it with `git archive HEAD`, commit it on the work branch, and say that
the history stays in the old repository.
