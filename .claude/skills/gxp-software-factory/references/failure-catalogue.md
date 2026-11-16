# Failure catalogue: what went wrong on the source project, and what catches it now

Every row happened. Search this page for the symptom before you diagnose from nothing; the last column is the guard that
exists because of it. "Guard" names a tool of this skill, a kit file, or a rule in a reference. Where it says "none", the
only protection is that you have read this row.

## Plan and waves

| Symptom | It was | Move | Guard |
|---|---|---|---|
| Two reviewers' "gaps" turned out to be half built already | reviewers overstate; 2 of 16 high-impact gaps were only partly true | fact-check whose brief is to refute; correct the roadmap from the verdicts | `factory.cjs exit discovery` (manual line), `references/discovery.md` |
| Every track repeated a wrong fact about the stack | the agent manual still named an auth service and a message broker that the code had left | fix the manual; say "X is not used and must not be reintroduced" | `manual-check.cjs` |
| A wave lost an afternoon at the gate over one shared file | two tracks edited the same registry | shared files only through gate patches; one owner per file | `roadmap-lint.cjs`, `ownership-audit.cjs` |
| "Complete" tracks whose reports hid unfinished criteria | status was the track's opinion; nobody held it against the plan | numbered acceptance ledger; "met" needs a named test | `reports-digest.cjs --roadmap`, `make-briefs.cjs` |
| 75 "not done" lines and 91 decisions faded after the waves went green | they lived in reports nobody reopened | import them into a register; close only with a reference | `open-items.cjs`, `factory.cjs exit gate` and `exit report` |
| A gate patch stayed in the repository; nobody knew if it was applied | one was applied and kept, one was deferred on purpose | delete applied patches; put a deferred one on the list with the reason | `factory.cjs exit gate` |
| A stop hook asked for a commit while agents were writing | the tree was mid-wave | answer in one line; the gate commits | `references/waves.md` |
| An agent kept sending new "final" reports | it woke on its own background job | one message: stop and clean up | none |
| A track died on a usage limit | its work was in the tree | resume the same agent; never restart a finished track | `make-briefs.cjs --resume` |
| The container was replaced: fresh clone on the default branch, dependencies gone | cloud sessions are temporary | fetch the work branch by name; orient with `factory.cjs status`; push after every gate | `factory.cjs status` |
| A brief sent a track to the wrong database | the brief was typed from memory | briefs are generated from the plan and the project facts | `make-briefs.cjs` |

## Code and commits

| Symptom | It was | Move | Guard |
|---|---|---|---|
| A commit went through although the pre-commit guard refused it | the guard ran as `guard | tail -1 && git commit`: the pipe kept the exit code of `tail`, not of the guard (my mistake, EBR wave 4) | run the guard on its own, or `set -o pipefail`; never pipe a gate's output into the condition of the next step | `factory.cjs exit gate` (runs the guard again on HEAD and reported it) |
| A forced `if (true)` nearly went into a commit | a temporary edit to exercise the Windows branch on Linux | mark every temporary edit `FACTORY-TEMP`; restore and check before committing | `precommit-guard.cjs` |
| New folders never reached the repository | `.gitignore` rules `release/` and `build/` also hid `scripts/release/` and `validation/build/` | `git status --ignored`; anchor the rules (`/release/`) | `precommit-guard.cjs` (SWALLOWED) |
| An accessibility check failed on one colour | a real contrast defect in one component | fixed the component; the baseline did not grow | `ratchet.cjs`, `references/judgement.md` section 7 |
| Suite green, process exits 1, "unhandled error" | a connection pool lost its database when the test dropped it by force | handle the pool's `error` event before the drop | `ci-log-digest.cjs` (UNHANDLED_AFTER_GREEN) |
| The evidence script failed on its second run | lockouts and rate limits left by the first run | a fresh, seeded database for every run | `ci-log-digest.cjs --local`, `references/judgement.md` section 2 |
| Browser and desktop tests failed with "connection refused" | the database service was down after the container resumed | start the service; change no code | `ci-log-digest.cjs --local` (ENV_SERVICE_DOWN) |
| The server refused to start | a signing secret shorter than the production rule | set a proper secret; keep the rule | `ci-log-digest.cjs --local` (ENV_CONFIG) |
| The backup tool reported "audit chain broken" | it ran without the server's secrets | export the same secrets to the tool | `assets/briefs/gate-brief.md` |

## CI

| Symptom | It was | Move | Guard |
|---|---|---|---|
| A job ended in seconds with no steps | the account: minutes or billing | tell the user where to look; re-running does not help | `ci-log-digest.cjs` (NEVER_STARTED) |
| Packaging failed downloading a helper (504) | the download host | re-run once; then stop depending on the download | `ci-log-digest.cjs` (INFRA_DOWNLOAD) |
| ENOENT on a path that began with `.electronDist=` | PowerShell split a `-c.key=value` flag (my mistake) | put the setting in the build configuration | `references/ci.md` |
| The packager found no Electron binary | `npm ci` skipped the download without failing | a step that retries and checks the file exists | `assets/kits/ci/workflows/build-windows-installer.yml` |
| A mirror for the binary was refused by a permission check | a third-party download host | not worked around; the user was told | `references/judgement.md` section 8 |
| A green job hid a red step | the step was informative (`continue-on-error`) | digest green jobs too | `ci-log-digest.cjs`, `factory.cjs exit ci` (manual line) |

## Installer

| Symptom | It was | Move | Guard |
|---|---|---|---|
| The installed application refused to start: integrity failure | the manifest was computed from the source tree; the packager rewrites `package.json` | write the manifest from the packaged folder (`afterPack`) | `assets/kits/release/`, `factory.cjs exit installer` |
| An installer shipped without its database | a missing bundle was only a warning | pin the archive by hash; fail the build without it | `factory.cjs exit installer`, `assets/kits/embedded-pg/` |
| "The server stopped repeatedly" on the user's PC | `postgres.exe` refuses an account with administrator rights | start through `pg_ctl`; watch the PID file | supervisor tests on the Windows runner (`assets/kits/embedded-pg/`) |
| The error screen said only "stopped" | the message carried no cause | append the last lines of the database log to the error | `references/installer.md` |
| The user installed a build that could not start | the link was given before the Windows job was read | smoke-start the real application before publishing; link after reading | `factory.cjs exit installer` |

## Validation and reporting

| Symptom | It was | Move | Guard |
|---|---|---|---|
| The documents described an older product | six source files changed after the evidence run | collect again and regenerate, or state the commit described | `evidence-fresh.cjs`, `factory.cjs exit validation` |
| A requirement stayed "GAP" after its cause was fixed | the content source was not updated with the fix | when a fix closes a deviation: update the verification, close the deviation with its evidence, in the same change | `references/validation.md` (order of work) |
| Windows evidence in the package came from a CI log | evidence from another machine | copy with a header; keep the requirement `P*` under a deviation | `references/judgement.md` section 3 |
| A renamed test would have kept its "Pass" | results typed by hand would not notice | results are looked up in executed evidence; not found is NOT RUN | `assets/kits/validation/` (`results.cjs`, `check.cjs`) |
| A clause number that does not exist could reach a signed document | citations written from memory | cite only what the anchor list holds; a person checks the rest | `citation-check.cjs` |
| The user typed letters that made no word | a word typed on the other keyboard layout | map the keys back before asking | `references/judgement.md` section 9 |

## This skill's own mistakes

| Symptom | It was | Move | Guard |
|---|---|---|---|
| The validation kit could not run in a new project | version 1 shipped without a file its content source requires | add the file | `skill-lint.cjs` (REQUIRE) |
| The release kit's scripts could not find each other | files were flattened; their relative paths expect the project layout | kits mirror the target paths | `skill-lint.cjs`, `assets/kits/README.md` |
| The same leftover was registered twice | import keyed on wording | one key per criterion | `selftest.cjs` (open-items) |
| On a new project kept as a folder inside a repository, status counted changes outside it and the ownership audit missed a foreign edit | git prints paths from the top of the repository | paths relative to the project folder (`statusEntries`, `--relative`); workflows read from the top too | `selftest.cjs` (subfolder project) |
| A folder named `release` inside a kit was flagged as build output | the junk rule matched any path segment | match build folders at the root only | `selftest.cjs` (precommit-guard) |
| The roadmap linter warned about overlaps that could not happen | a wording heuristic for globs | compare the patterns exactly | `selftest.cjs` (roadmap-lint) |
| CI red on the first run of a backup test that passed locally | the runner's pg_dump/pg_restore are newer than the server (`SET transaction_timeout` unknown to PostgreSQL 16); the test needed `dist` but CI builds after testing; a rejection was handled late | restore through `pg_restore --file=-`, filtering only that setting, into `psql --single-transaction`; the test compiles the server when `dist` is missing; catch a promise's outcome at once | CI job `test` of `ebr.yml` |
| The validation sources were left out of a commit although the guard saw them | the guard was run as `precommit-guard.cjs ebr`: the bare argument was ignored, it checked the whole repository, and 40 warnings about `ebr/dist/` filled its list before `validation/build/` (hidden by a top-level `build/` rule) | a bare argument is refused (`--repo <folder>`); warnings beyond the list are counted; the project re-includes `validation/build/` | `selftest.cjs` (precommit-guard) |
| A Windows script shipped in R3 failed at its first real run in R4, before doing anything | `"... $app: ..."` in PowerShell reads `$app:` as a drive-qualified variable: a parse error; the script had been written but never run (no Windows, no PowerShell where it was written) | `${app}:` in strings; a script for a platform the builder lacks is "not run" until a CI job on that platform has run it | `ps1-lint.cjs` (VARCOLON), run by `factory.cjs exit gate`; a CI job on Windows |
| The Windows service restarted every 11 seconds and the install step only said "no health answer" | `psql <url> -c 'create database ebr'` on Windows ignores options after the address (a warning, exit 0): the database was never made; the server died at start and WinSW restarted it | options before the address and `ON_ERROR_STOP`, and check the database exists; the install script prints the end of the server's error log when health fails | `ps1-lint.cjs` (PSQLORDER, PSQLSTOP), run by `factory.cjs exit gate` |
| CI was red for five pushes while the report said green | requirements were pointed at CI evidence copied into the repository, but the CI gate checks only the evidence of its own run; the green run that was read was the one BEFORE the push that added those references | a final CI job gathers the evidence of every job of the same run (artifacts) and runs the gate there; read the run of the LAST push before reporting, every time | `ci-head.cjs` (`factory.cjs exit ci --run <run.json>`); `assets/kits/validation-roadmap/ci/workflows/traceability.yml` |
| A track was committed with a type error and a failing test | lint and tests were chained with `;` before the commit, so the commit ran whatever they said; the summary line was read after | run the checks, READ their result, and only then commit in a separate command; never chain a commit after checks with `;` | `checked-commit.cjs`: the checks, the guard and the commit are one command that commits only when all pass |
| The API was complete and tested, and the user could not find seven functions ("انت بتهزر") | user management, creating a logbook, copying a recipe, the audit review and more existed only as routes; every test called the API directly | a screen for each, then a test that reads the route table and the screens; routes no person calls are named with their reason | `screen-coverage.cjs`, run by `factory.cjs exit gate` (`SCREENS` in the config); `references/product.md` |
| A data migration "passed" and changed nothing | it matched rows on a column the seed did not fill; the test asserted no error, not the rows changed | assert the count of rows changed against a seeded fixture; a migration that touches zero rows on real data is a finding | `references/judgement.md` (section 3, suspicious pass) |
| A setting's change answered with the old value | the answer was read after the transaction, from a cache filled before it | read the answer inside the same transaction as the change | the API test of the settings |
| The demo-data command tripped the guard that no code limits the number of accounts | it counted users to decide "empty" | existence checks (`EXISTS ... OFFSET 1`), never a count | the guard test that greps for account counting |
| "Implement all" of six open decisions | each decision was a person's (session length, lockout, yield limits, directory, language) | implement each as a signed site setting with a conservative default, bounds and a reason on every change; the decision stays the plant's, the code no longer blocks it | `references/product.md` (decisions as settings) |
| The commit that added the roadmap validation kit left its `validation/build/` out, through the new checked commit | the top-level rule `build/` hid it again; the guard only warned, and 40 warnings about `ebr/dist/` (a project in a subfolder) filled the list ahead of it; the old kit had been added with force | the guard ignores build output at any depth, and a folder hidden next to the files of the commit is a FAIL (HIDDEN); `.gitignore` re-includes the kits' `validation/build/`; read the staged list before every commit | `precommit-guard.cjs` (HIDDEN), run by `checked-commit.cjs` |
| Two commits of the skill went out without the session's trailers, through the new checked commit | it read `factory.config.json` from the top of the repository, which has none (the project lives in `ebr/`), and an empty list of trailers was taken as "none required" | no trailers configured is refused unless `--no-trailers`; `--config` names the project's config; check `git log -1 --format=%B` before the push. Pushed history is not rewritten: the miss is reported | `checked-commit.cjs`, drill case "no trailers at the top of the repository" |
