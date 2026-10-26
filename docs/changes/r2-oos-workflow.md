# r2-oos-workflow: the OOS investigation workflow (roadmap M26)

Release R2, wave W3. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-oos-workflow.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** The three M26 acceptance criteria pass in the combined W3 simulation (all four W3
gate patches and every in-flight W3 file). In the shared tree without the patch the workflow routes are not mounted, so
`tests/api/oos-workflow.test.ts` cannot start the app (the route table and the registered routes disagree) or answers 404, as earlier
tracks' API tests did before their patches. `oos-workflow-migration` and `oos-workflow-ui` pass in the shared tree as it is.

This track was resumed after a usage limit. The earlier attempt had written the migration, schema, engine, routes, guard, release
blocker, screen, tests and gate patch, and had run a first simulation; it had no record. I reviewed all of it and kept it. I found three
defects and one missing piece and fixed them test-first (see "Changed on the resume"), rebuilt the simulation from the current tree, and
re-ran the evidence.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, reserved 0210 to 0219) | `drizzle/0210_oos_workflow.sql`. New columns on `oos_investigations` (all nullable, no row rewritten): `due_date`, `phase2_started_at`, `assignable_cause_category`, `assignable_cause`, `assignable_cause_by`, `assignable_cause_at`, `invalidated_by`, `invalidated_at`. New tables `oos_settings`, `oos_checklist_templates`, `oos_tasks`, `oos_retest_plans`, `oos_retests`. Append-only triggers on plans and retests. Under the runner only: the settings row, two checklist templates, 3 signature meanings, 2 permissions (positions 210, 211) and their grants |
| Schema | `src/db/schema/oos.ts` |
| Rules shared by server and screen | `src/lib/validations/oos.ts`: strict request schemas, `OOS_CLOSURE_DECISIONS`, `oosClosureProblems` (the closure rule) |
| Engine | `src/server/oos/workflow.ts` (due dates, tasks, cause, invalidation, retest plan, retests, settings, templates), `entities.ts` (the three signable record types), `vocabulary.ts`, `protections.ts` (the append-only triggers, for the registry) |
| Routes | `src/server/oos/routes.ts` (12 new routes); `src/server/routes/oos.ts` (list with due date and `overdue`; Phase II start; the closure rule; the deviation on a confirmed OOS) |
| Sample guard and release blocker | `src/server/workflow/guards/oos.ts` (`oos-vocabulary` under `Approved`), `src/server/release-blockers/oos.ts` |
| Screen | `src/components/OOSInvestigations.tsx`: due date and Overdue badge, workflow panel (tasks, cause, invalidation, retest plan, retests, linked deviation), required decision with the reasons it is refused shown before the signature, AI output as a labelled optional suggestion |
| Tests | `tests/api/oos-workflow.test.ts` (15), `tests/api/oos-workflow-migration.test.ts` (6), `tests/api/oos-workflow-ui.test.ts` (7) |

### Workflow (FDA guidance "Investigating OOS Test Results"; 21 CFR 211.192)

* **Due dates.** Phase I is due `phase1DueDays` (10) calendar days after the date raised. Moving to Phase II stores when it started and
  its due date (`phase2DueDays`, 30). An open investigation past its due date is `overdue` (the due day itself is not). Shown on the record,
  in `GET /oos`, in `GET /oos/overdue` (most overdue first, with `daysOverdue`) and, with the gate patch, on the dashboard.
* **Tasks.** A checklist template is applied once per investigation (partial unique index), or a task is added by hand, with owner and
  due date. A task is completed (Done or Not applicable) only with a finding, and is then frozen (423). Every open task blocks the closure.
* **Assignable cause (Phase I only).** The investigator records it (category from the coded OOS reasons, description with evidence). QA
  confirms it with a signature (`OOS_INVALIDATION`, reason required), which invalidates the original result. The signer must not be the
  investigator (now or earlier), the author of the cause or the original analyst. The cause is frozen once confirmed.
* **Retest plan.** One per investigation, signed by QA (`OOS_RETEST_AUTHORISATION`) before any retest, after a confirmed cause (basis
  "Assignable cause") or in Phase II (basis "Phase II protocol"). It carries the justification and the maximum number of retests, at most
  the setting `maxRetests` (2). Append-only.
* **Retests.** Entered by an Analyst or Admin who did not enter the original OOS value (setting `retestAnalystMustDiffer`, on). They are
  evaluated against the limit of the original result, through the result guards of that result (instrument, method, SST, and the
  qualification guard once r2-docs-training's gate adds it). They are numbered, append-only, and refused once the plan's maximum is reached
  (409 `RETEST_LIMIT`; the investigation row lock serialises concurrent retests).
* **Closure** (`POST /oos/:id/close`, `OOS_CLOSURE`). The decision is required: `Confirmed OOS`, `Inconclusive` or `Invalidated`. Refused
  before the password is checked, and again inside the signing transaction:
  * 403 `SOD_VIOLATION` (recorded as `AUTHZ_DENIED`) for the investigator now or earlier, the author of the cause and the original analyst;
  * 409 `TASKS_OPEN` while a task is open;
  * `Invalidated`: 409 `ASSIGNABLE_CAUSE_REQUIRED` without the signed invalidation, 409 `RETEST_REQUIRED` without a retest, 409
    `RETEST_OOS` while any retest is OOS;
  * `Confirmed OOS` and `Inconclusive`: 409 `PHASE_II_REQUIRED` before Phase II.
  A `Confirmed OOS` opens a deviation (r2-qms `autoOpenQmsRecord`, source `oos-confirmed`) in the closure's transaction; the detail lists
  the linked quality records.
* **Settings** (`oos_settings`): changed only with a signature (`OOS_SETTING_CHANGE`, reason required), with the version predicate.
* **Vocabulary guard.** An investigation whose status, phase or decision is outside the OOS vocabulary blocks the approval of its sample
  and the release of its batch (fail closed). A closure with no decision (before 0210) is accepted.
* **AI checklist.** The Gemini output is shown as "AI suggestion: not part of the record". It reaches the draft closure fields only when
  the person clicks "Copy into the draft closure fields" and is then edited and signed by them; it never opens the closure by itself.

Every write is audited in its own transaction (`writeAudit`, or `signRecord`'s audit entry for the signed steps). Every update uses the
version predicate (`updateVersioned`). Signatures are bound to the version the step produces. The actor is always `req.user`.

### API (permissions in the gate patch's route table)

| Route | Permission |
|---|---|
| `GET /oos/overdue`, `GET /oos/settings`, `GET /oos/checklist-templates`, `GET /oos/:id` | `oos.view` |
| `POST /oos/settings` (signed), `POST /oos/checklist-templates` | `oos.settings` |
| `POST /oos/:id/tasks`, `PUT /oos/:id/tasks/:taskId`, `PUT /oos/:id/assignable-cause`, `POST /oos/:id/retests` | `oos.edit` |
| `POST /oos/:id/assignable-cause/confirm` (signed), `POST /oos/:id/retest-plan` (signed) | `oos.approve` |
| `POST /oos/:id/close` (existing; the decision is now required) | `oos.close` |

## Why

M26: `oos_investigations` had no task, retest, impact or due-date structure; the Phase I checklist was Gemini text merged into free
text; there was no retest linkage, no invalidation with an assignable cause and no retest limit; closure required QA but with no SoD
against the investigator. Retesting and invalidation are the classic "testing into compliance" finding, so every state change is signed
and audited. Of `synth.topDefects`, the OOS parts inside this track's files were already fixed in R1 and stay fixed: no `isOOS` read is left in
`src/`; `PUT /oos/:id` takes no status and answers 423 on a closed investigation; a failed signature's counter and `SignatureFailed`
entry are committed in their own transaction (`src/server/esign/authorize.ts`), which the new signed steps use too; the OOS "Verify Seal"
shows `SignatureVerdict` and the ALCOA+ claims only when `valid === true`. "OOS investigations are never created automatically" was
fixed by r1-results-oos (`saveResult` opens one).

## Changed on the resume (test first; each new test was run red against the earlier attempt's code)

| Change | Red evidence before the fix |
|---|---|
| An `Invalidated` closure is refused (409 `RETEST_OOS`) while any retest under the plan is OOS. Before, a failing retest 1 and a passing retest 2 could be closed as Invalidated: testing into compliance | `expected 200 to be 409`: the closure was signed |
| The investigator stays excluded after handing the investigation over: everyone who has been the assignee (from the `assigned_to` audit entries) may not confirm the cause, authorise retests or close. Before, QA could assign the investigation to someone else and then sign its invalidation | `expected 200 to be 403`: the invalidation was signed |
| Overdue investigations reach the dashboard (gate patch: `overdueOos` count, the item marked overdue with urgency Critical, the Active OOS tile says how many are past their due date) | `expected undefined to be 1` |
| The screen kept the draft of a task finding, a new task or a retest only on success; a refused step cleared it after the error toast | (UI flow; no automated render test) |

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/oos-workflow-migration.test.ts tests/api/oos-workflow-ui.test.ts   # shared tree, no wiring needed (13)
# after the gate steps below:
npx vitest run tests/api/oos-workflow.test.ts                                                # 15
npx vitest run && npm run lint
```

## Evidence (2026-10-21)

The simulation is `scratchpad/oosw-w3`: a copy of r2-coa-reports' combined W3 simulation (`git archive HEAD`, the four W3 gate patches,
the hand merges, every in-flight W3 file, the derived files regenerated). Its code was compared file by file with the shared tree before
use (only records differed), then this track's current files and the new dashboard hunk were put in.

* **Test first.** The earlier attempt's red runs: `scratchpad/oosw-red.txt` (UI and migration tests: missing exports and module) and
  `oosw-red-api.txt` (13 of 13 API tests failing, routes not mounted). On the resume: `oosw-red3.txt` (3 failed: RETEST_OOS in the API and
  the UI rule, the dashboard) and `oosw-red4.txt` (1 failed: the reassigned investigator).
* **Acceptance (M26)**, all in `tests/api/oos-workflow.test.ts`:
  1. Closing as Invalidated without an assignable cause (409), with a recorded but unconfirmed cause (409), and with a confirmed cause
     but no retest (409) is rejected, and costs the signer no attempt. Closing by the assignee is 403 `SOD_VIOLATION`, also after a
     reassignment.
  2. A retest by the original analyst is 403 `SOD_VIOLATION`; a retest without a signed plan is 409; the third retest on a plan limited
     to two is 409 `RETEST_LIMIT`, and two retests stay on record.
  3. A Phase I investigation past its due date is `overdue` on the record, in the list, in `GET /oos/overdue` (20 days overdue) and on
     the dashboard.
* **OOS-related suites** in the simulation (`oos-workflow`, `-ui`, `-migration`, `oos-lifecycle`, `authz-states`, `esign-verify`,
  `samples-workflow`): 7 files, 74 tests passed (`oosw-green4.txt`). `equipment-dashboard` with the dashboard hunk: passes.
* **Mutation checks** (`oosw-mutations.txt`), each turned a test red: OOS retest ignored at closure (2 failed); former investigators not
  excluded at closure (1); former investigator allowed to confirm the cause (1); dashboard ignoring overdue (1).
* **Whole suite** (simulation, JWT_SECRET and LIMS_MASTER_KEY unset; `oosw-full3.txt`): 132 files passed, 2 skipped; **1574 tests
  passed, 3 skipped, 0 failed**. Vitest reported 3 unhandled errors, none in this track: two `57P01 terminating connection` at teardown
  of scratch databases in `rawdata-migration.test.ts` and `qms-migration.test.ts` (the forced drop while a pool is closing, the harness
  race already recorded by r2-coa-reports) and one `Timeout calling "onTaskUpdate"` (worker RPC under load).
* **Lint**: `npm run lint` in the simulation: web clean; server "18 known error(s) in the baseline, none new". In the shared tree:
  `lint:server` the same; `lint:web` shows only the 2 known `src/server/lib/evaluate.ts` errors that r2-result-ui's gate patch removes.
* **Shared tree, no wiring**: `oos-workflow-migration` and `oos-workflow-ui` 13 of 13; `git apply --check` of the gate patch: applies.
* **Production bundle** (simulation, `npm run build`; fresh database by `dist-server/init-db.cjs`: 22 migrations to 0210_oos_workflow,
  the lims_app role step "23 append-only tables, 52 guard triggers"; `delete from users`; demo seed; server on 127.0.0.1:3111, stopped
  afterwards): start-up anchor check "0 checked, the audit trail matches"; `tests/security-controls.sh` **34 PASS, 0 FAIL**;
  `tests/backup-restore.sh` **18 PASS, 0 FAIL** (run as the simulation's copy, with the server's JWT_SECRET exported and
  `SERVER_BACKUP_DIR` set to the server's backup folder; a first run from the shared tree's copy looked for the backup in the shared
  tree's `backups/` and failed 8 checks: an invocation error, nothing written there). Neither script was edited. As QA, `GET`
  `/oos/overdue`, `/oos/settings`, `/oos/checklist-templates`, `/oos/OOS-2026-001` and `/dashboard` answer 200; the dashboard reports
  `overdueOos: 1` and the seeded investigation as "OOS Investigation overdue (due 2026-09-28, 23 d)".
* **Desktop** (simulation, after `npm run build`): `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed.

## Decisions that need confirmation (conservative defaults implemented)

* Defaults: Phase I due in 10 calendar days, Phase II in 30, at most 2 retests per plan, retest analyst must differ from the original
  analyst. All changeable only by QA with a signature. The setting range is 1 to 10 retests and 1 to 365 days.
* An `Invalidated` closure needs a confirmed assignable cause, at least one retest and **no OOS retest**. A failing retest sends the
  investigation to Phase II (Confirmed OOS or Inconclusive); no averaging, no "best of" retests.
* Independence: the investigator (every person ever assigned), the author of the cause and the analyst of the original OOS value may not
  confirm the cause, authorise retests or close. The person who confirmed the cause may still close the investigation.
* The decisions are `Confirmed OOS`, `Inconclusive`, `Invalidated`. Confirmed OOS and Inconclusive need Phase II; only a Confirmed OOS
  opens a deviation automatically (an Inconclusive one does not).
* Retests are entered by Analyst or Admin (`RESULT_ENTRY_ROLES`); the retest plan and the invalidation are signed by QA or Admin.
* Checklist templates are versioned configuration (`oos.settings`, audited, not signed). The installed Phase I and Phase II item lists
  are a starting point written from the FDA guidance's headings; QA must review them against the site SOP.
* Overdue uses the server's local calendar day; the due day itself is not overdue.
* Migration number 0210 (reserved 0210 to 0219); the roadmap's `ownsFiles` names `drizzle/017*`, which r2-audit-tamper uses.

## Not done

* **The original result row is not marked invalid.** The invalidation is on the investigation (`invalidated_at`, signed), and the
  retests are in `oos_retests`; `results` keeps the original OOS value. The CoA snapshot (r2-coa-reports) therefore prints the original
  as "Does not comply" and no retests, which errs on the safe side. Which value is reportable is now defined by this track: after an
  `Invalidated` closure every retest under the plan is reportable and all of them comply; the invalidated original is shown as not
  reported, with the investigation. Changing the snapshot is r2-coa-reports' follow-up (needs below).
* No notification (r2-events outbox) when an investigation becomes overdue; it is shown, not pushed.
* No OOT (out-of-trend) rules; the roadmap's title names OOT, the design and acceptance do not.
* No browser run in this session (the earlier attempt's screen code and the render tests are the evidence for the screen).
* No URS/OQ/RTM entries for M26 (r2-validation).

## For the gate

1. Apply the W3 patches. In the order the other W3 tracks used (r2-result-ui, r2-docs-training, r2-coa-reports, then this one) with
   `patch -p1 -F3`, every hunk of this patch applies except two, which are one-line merges next to the other tracks' lines:
   * `src/db/protections.ts`: append `oosProtections` to `protectionSets` (the import line applies).
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: the comment and the counts. Signature meanings: 28 + 2 (coa) + 6 (docs) + 3 (this track) =
     **39**; `oos_settings` 1 row and `oos_checklist_templates` 2 rows next to `qms_settings`/`audit_review_settings`/`training_curricula`;
     strip `oos_settings.updated_at` and `oos_checklist_templates.created_at` in the rollback comparison. No assertion removed.
   Alone on HEAD, `git apply docs/changes/r2-oos-workflow.gate.patch` applies cleanly. It changes:
   * `src/server/routes/index.ts`: register `oosWorkflowRoutes` (`src/server/oos/routes.ts`).
   * `src/server/authz/routeTable.ts`: 12 rules with their strict body schemas and the `editable` state check.
   * `src/lib/permissions.ts`: `oos.approve` and `oos.settings` for QA (and Admin), as the migration grants them.
   * `src/db/protections.ts`: `oosProtections`.
   * `src/server/release-blockers/index.ts` and `src/server/workflow/guards/index.ts`: the vocabulary blocker and guard.
   * `src/server/routes/dashboard.ts` and `src/components/Dashboard.tsx` (r2-tat-kpi's, not yet run): overdue investigations.
   * Tests of other tracks that close an investigation (`authz-states`, `esign-verify`, `oos-lifecycle`, `samples-workflow`): the decision
     is now required, and a Confirmed OOS closure goes through Phase II first (deliberate behaviour change). No assertion weakened;
     `esign-verify` now expects `recordVersion` 3 because the Phase II move is one more version.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: as above.
2. Regenerate after all patches: `tests/route-table.json` (12 routes added), `docs/permission-matrix.csv` (84 permissions with all W3
   tracks), `desktop/schema.sql` (`migrate-cli.ts export-schema`, now through 0210).

## Needs from other tracks

| Owner | Change |
|---|---|
| Gate | The patch and the regenerations above |
| r2-coa-reports (`src/server/reports/snapshot.ts`) | After an `Invalidated` closure, print the original result as invalidated (not reported, with the investigation id and the signed cause) and the retests of `oos_retests` as the reportable values |
| r2-tat-kpi (`routes/dashboard.ts`, `Dashboard.tsx`) | Keep the overdue-OOS lines of this gate patch when the dashboard is reworked |
| r2-events | Optional: an outbox event when an investigation becomes overdue |
| r2-validation | URS/OQ/RTM entries for M26; the acceptance tests and runs above are the material |
| Owner of the demo seed (`scripts/dev/seed/`) | The seeded investigation `OOS-2026-001` has the status `Phase II QA Review`, outside the OOS vocabulary: by design it cannot be edited (the workflow refuses it) and it blocks the approval of its sample and the release of its batch. Seed it as `Open` with phase `Phase II` |
