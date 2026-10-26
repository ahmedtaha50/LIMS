# r2-stability: the stability programme (roadmap M31)

Release R2, wave W4. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-stability.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** The three M31 acceptance criteria pass in a gate simulation (HEAD + this track +
the patch). In the shared tree without the patch the new routes are not mounted and the route table does not know them; the old
`tests/api/equipment-stability.test.ts` and four older tests that start a study with the old body fail there until the patch is in
(they are rewritten inside the patch).

An earlier attempt at this track was cut off before it wrote any file under my patterns; everything here is new.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, reserved 0240 to 0249) | `drizzle/0240_stability.sql` (the roadmap's `drizzle/022*` is taken by r2-custody-labels). Tables `stability_conditions`, `stability_chambers`, `stability_protocols`, `stability_study_links`, `stability_timepoints`. `stability_studies` is **not altered**: a study written before 0240 reads back unchanged (no link row, no timepoints, shown as "started before protocols"). Under the runner only: the 7 ICH Q1A(R2) conditions, meaning `STABILITY_PROTOCOL_APPROVAL`, permissions `stability.manage` / `stability.approve` (positions 240, 241) and grants |
| Schema | `src/db/schema/stability.ts` |
| Calendar (pure date arithmetic) | `src/server/stability/calendar.ts` |
| Engine | `src/server/stability/protocols.ts` (conditions, chambers, protocols, approval), `studies.ts` (create, close, list, pull), `sweep.ts` (the scheduled Due/Missed sweep), `entities.ts` (signable `StabilityProtocol`), `schemas.ts` (strict request schemas) |
| Routes | `src/server/stability/routes.ts` (15 new routes), `src/server/routes/stability.ts` (POST/PUT/GET `/stability` rewritten) |
| Schedule | `src/server/schedules/stability.ts`: `stability.timepoints`, hourly at :05 |
| Screen | `src/components/StabilityStudies.tsx`: Studies, Pull calendar and Protocols tabs; working search and filter; signature dialog for the approval |
| Tests | `tests/unit/stability/calendar.test.ts` (7), `tests/api/stability-programme.test.ts` (13), `tests/api/stability-migration.test.ts` (6), `tests/api/stability-fixture.ts` (arrange helper) |

### Behaviour

* **Condition master** (`stability_conditions`): code (unique ignoring case), name, category, temperature and relative humidity set
  points with tolerances (humidity both or neither). Seven ICH Q1A(R2) conditions are installed (25/60, 30/65 long term, 30/65
  intermediate, 40/75 accelerated, 5 C, 25/60 accelerated for refrigerated product, -20 C). Editable by `stability.manage` with a reason
  (audited per field); deactivated, not deleted. **Chambers**: one condition each, status Active / Inactive / Out of Service.
* **Protocol**: product, test plan code, conditions (a snapshot of each condition's values, so a later edit of the master does not
  alter an approved protocol), month points (0 to 120, ascending, 0 = initial test), pull window in days (0 to 60). Draft, then
  Approved by `STABILITY_PROTOCOL_APPROVAL` (QA, Admin) bound to the new record version. The approver must neither have drafted nor
  edited it (403 `SOD_VIOLATION`, audited `AUTHZ_DENIED`). Refused before the password is checked (no attempt spent): not a Draft,
  SoD, stale version, test plan without an Effective revision or for another material, inactive product or condition. **An Approved or
  Superseded revision is never edited: 409 `PROTOCOL_LOCKED`**; a change is `revise` (a Draft clone), signed again; its approval
  supersedes the earlier revision in the same transaction. One Draft and one Approved revision per code (partial unique indexes).
* **Study** (`POST /stability`): `{protocolId, batchId, startDate, chambers?}`. Product, batch text, conditions and month points come
  from the Approved protocol and the master batch (Quarantine or Released, Active product). In one transaction: the study (`Ongoing`),
  the link row, and one timepoint per (condition, month point) with due date and window, each with an audit entry. A start date for
  which a window has already closed is refused (409 `START_DATE_TOO_EARLY`). `PUT /stability/:id` no longer edits product, batch or
  condition (400): it ends the study, `Completed` (only when every timepoint is Complete or Missed) or `Aborted`, with a reason
  in the audit entry; a finished study is final (423).
* **Calendar** (`calendar.ts`): due date = start date plus the month point **counted from the start date** (never chained); a day the
  month does not have is its last day (31 Jan + 1 month = 28 Feb, 29 in a leap year; 30 Nov 2027 + 3 months = 29 Feb 2028). The window is
  the due date +/- the window days and never opens before the start date.
* **Due and Missed with no user action**: the `stability.timepoints` job (hourly :05, service principal). It decides from the calendar
  date, so one run after a power-off catches up however many days were missed (the scheduler already runs a slot that fell due while the
  PC was off once at start-up). Scheduled to Due when the window opens; Scheduled/Due to Missed when it has closed. **A missed pull opens a
  deviation** (`autoOpenQmsRecord`, new source `stability-pull-missed`, in the same transaction), stored on the timepoint. A pulled
  timepoint follows its sample: InTesting once the sample is in Testing/Pending Review, Complete when Approved/Rejected. Every
  change is audited; the version predicate is used.
* **Pull** (`POST /stability/timepoints/:id/pull`, `sample.register`, so Analyst and Admin): only inside the window. One
  transaction: a normal sample through `insertSamples` (the registration function), bound to the specification in force, with **only
  the result rows of the Effective test plan** (a plan parameter missing from the specification is refused); `sample_context`
  (origin `stability`); the timepoint is Pulled and keeps `sample_id` (unique). Before the window 409 `PULL_NOT_DUE`, after it
  409 `PULL_WINDOW_CLOSED`, again 409 `ALREADY_PULLED`, Missed 409 `PULL_MISSED`.

### API and permissions (rules in the gate patch's route table)

`GET /stability/studies/:id`, `GET /stability/timepoints[?status=]`, `GET /stability/protocols|conditions|chambers`: `stability.view`.
`POST/PUT /stability/protocols`, `POST /stability/protocols/:id/revise`, `POST/PUT /stability/conditions|chambers`: `stability.manage`
(QA, Reviewer, Admin). `POST /stability/protocols/:id/approve`: `stability.approve` (QA, Admin). `POST /stability/timepoints/:id/pull`:
`sample.register`. `POST /stability`, `PUT /stability/:id`: unchanged codes (`stability.create`, `stability.edit`), new strict bodies.

## Why

M31: `pullPoints` was fixed at [1,3,6,9,12]; a study had no link to samples, results, specifications or tests, and no due dates,
chamber or overdue logic; `PUT /stability` let anyone change product, batch and condition with the fixed reason "User Update". Of
`synth.topDefects` in this track's scope, the free-text PUT, the fixed pull points and the dead search / Filter controls of
`StabilityStudies.tsx` are fixed here (the status vocabulary and the 423 lock were already fixed in R1 and stay). 21 CFR 211.166 and
ICH Q1A: a missed pull is a deviation, not a silent edit.

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/unit/stability tests/api/stability-migration.test.ts      # shared tree, no wiring needed (13)
git apply docs/changes/r2-stability.gate.patch                                  # then regenerate the three derived files if other tracks changed them
npx vitest run tests/api/stability-programme.test.ts tests/api/equipment-stability.test.ts   # 13 + 10
npx vitest run && npm run lint
```

## Evidence (2026-10-25)

Simulation `scratchpad/stb-sim`: `git archive HEAD` + this track's files + the gate patch's edits + regenerated files
(`tests/route-table.json`, `docs/permission-matrix.csv` 86 permissions, `desktop/schema.sql`). Sync script `scratchpad/stb-sync.sh`.

* **Test first.** `scratchpad/stb-red-calendar.txt`: the calendar test could not load before `calendar.ts` existed. `scratchpad/stb-red-api.txt`:
  `stability-programme.test.ts` against HEAD: **13 of 13 failed** (every new route 404, no sweep module, no schedule).
* **Acceptance (M31)**, `tests/api/stability-programme.test.ts` and `tests/unit/stability/calendar.test.ts`:
  1. 8 month points x 2 conditions give 16 timepoints; due dates across 30 Nov 2027 start, 29 Feb 2028 (leap year) and a 31 January
     start (28/29 Feb, 31 Mar, 30 Apr ...), windows asserted exactly, 16 timepoint audit entries.
  2. The sweep makes Due (window opens) and Missed (window closed) without a user; a run after a power-off marks two windows Missed
     in one run with two deviations; a second run changes nothing; the scheduler's start-up catch-up (injected clock, real job runner)
     runs the job once as `svc-scheduler` with nobody signed in.
  3. A pull creates a sample linked to its timepoint, with only the test plan's result rows (Dissolution excluded) and the limits of
     the specification; editing an Approved protocol is 409 `PROTOCOL_LOCKED` for every field, and the row is untouched.
* **Mutation checks** (`scratchpad/stb-mutations.txt`), each turned tests red: window closing a day early (1 failed), Approved
  protocol editable (1), missed pull without its deviation (1), month addition without the last-day clamp (4).
* **Whole suite** in the simulation (JWT_SECRET and LIMS_MASTER_KEY unset; `scratchpad/stb-full2.txt`): 135 files passed, 2 skipped;
  **1598 tests passed, 3 skipped, 0 failed**. The first full run (`stb-full1.txt`) had 6 failures, all outside the new files, now
  fixed in the patch: four tests that started a study with the old free-text body or edited its condition (`authz-fuzz` x2, `occ`,
  `robustness`), the upgrade test's meaning count (40) and its rollback comparison (7 installed conditions, `created_at` stripped);
  `spec-schema` failed once with `tuple concurrently updated` (a catalog race in `init-db` under load) and passed on rerun.
* **Lint**: `npm run lint` in the simulation: web clean; server "18 known error(s) in the baseline, none new". In the shared tree the
  server check shows two errors in other W4 tracks' files (`em/routes.ts`, `reagent.ts`), none in mine.
* **Production bundle** (simulation, `npm run build`; fresh database by `dist-server/init-db.cjs`: 23 migrations ending at
  0240_stability, role step "23 append-only tables, 52 guard triggers"; `delete from users`; demo seed; server on 127.0.0.1:3114,
  stopped afterwards): `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**. Neither script
  was edited. (A repeated run against the same server shows false FAILs from the rate limiter and the TOTP step; the clean run is the evidence.)
* **Desktop**, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.

## Decisions that need confirmation (conservative defaults implemented)

* Pull window default: no default; the protocol states it (0 to 60 days each side of the due date). Suggested 7 days; the site's SOP decides.
* Month 0 (initial test) is allowed as a month point; a start date whose window has already closed is refused rather than creating Missed pulls.
* Protocol approval by QA or Admin only; drafting by QA, Reviewer, Admin (`stability.manage`). The approver may not be anyone who drafted or edited it.
* A missed pull always opens a **Deviation in QA Triage** (no classification); the pull cannot be done late. Whether a late pull
  inside a QA-approved extension should be possible is a QA decision (not built).
* Completing a study needs every timepoint Complete or Missed; ending it (either way) takes a reason, not an e-signature.
* The seven installed ICH conditions are the ICH Q1A(R2) examples; QA must review them against the site's registered conditions.
* `Out of Service` chambers are not offered for new studies; existing timepoints keep their chamber.

## Not done

* No excursion handling for chambers (temperature/humidity logging against the condition's tolerance), no chamber inventory of
  stored units, no chamber UI (chambers are API-only; studies can name them at creation via the API).
* No trend/shelf-life evaluation of stability results, no stability summary report, no pull-schedule notification through the
  r2-events outbox (a `stability.pull_due` event is one catalog entry plus one `emitEvent` call in `sweep.ts`).
* No UI for editing the condition master (API only); no browser session was run (the screen is type-checked, built and bundled, and
  the API it calls is tested).
* A study cannot be re-planned (add or move a timepoint); abort and restart.
* No URS/OQ/RTM entries for M31 (r2-validation).

## For the gate

1. `git apply docs/changes/r2-stability.gate.patch` (applies cleanly to the shared tree as of this record). It changes:
   `src/server/routes/index.ts` (mount `stabilityProgrammeRoutes`), `src/db/schema/index.ts` (`./stability`), `src/server/schedules/index.ts`
   and `src/server/jobs/handlers/index.ts` (schedule and handler), `src/server/qms/autoOpen.ts` (source `stability-pull-missed`),
   `src/lib/permissions.ts` (`stability.manage`, `stability.approve`, grants as in the migration), `src/server/authz/routeTable.ts`
   (15 rules; `POST /stability` and `PUT /stability/:id` take the new strict schemas), and the tests: `authz-fuzz`, `occ`,
   `robustness` (new bodies), `equipment-stability` (rewritten for the protocol-based study; every R1 guarantee kept: vocabulary,
   423 lock, 409/400/404, pull points from the protocol), `upgrade-v0.1.0` (meanings 40, 7 conditions, `created_at` strip).
   No assertion was removed without an equivalent for the new contract.
2. The patch includes `tests/route-table.json` (+15 routes), `docs/permission-matrix.csv` and `desktop/schema.sql` regenerated on
   this track alone: **regenerate them after the last W4 track** instead (`tests/helpers/dump-route-table.ts --stdout` with NODE_ENV=test
   and a 32-character JWT_SECRET; `scripts/authz/export-matrix.ts`; `src/server/boot/migrate-cli.ts export-schema`) and merge the
   upgrade-test counts with the other W4 tracks' additions (meanings, tables).
3. Migration numbers 0240/0250 are used by this track and r2-em; 0220 (custody) and 0230 (reagents) sort in between. 0240 reads only
   tables of 0100, 0110, 0180 and the baseline, so the order among W4 files does not matter.

## Needs from other tracks

| Owner | Change |
|---|---|
| Gate | The patch and the regenerations above |
| r2-qms (`src/server/qms/autoOpen.ts`) | Keep the `stability-pull-missed` source in the patch |
| r2-events | Optional: `stability.pull_due` / `stability.pull_missed` events from `sweep.ts` |
| r2-validation | URS/OQ/RTM entries for M31 |
| Owner of `src/lib/validations/stability.ts` and `src/types.ts` | `stabilitySchema`, `stabilityUpdateSchema`, `DEFAULT_PULL_POINTS` and `StabilityStudy` are no longer used by the server; remove or extend them |
