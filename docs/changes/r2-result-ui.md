# r2-result-ui: bench-side result workbench (roadmap M19)

Release R2, wave W3. Branch `claude/project-implementation-tirr4j`. The changes are left uncommitted for the wave gate.
Companion file: `docs/changes/r2-result-ui.gate.patch`. It holds the edits to files this track does not own (route registration,
route-table rule, one narrowing fix in the evaluator, the two regenerated tables). See "For the gate".

Status: **partial**. The three acceptance criteria of M19 are met and tested on the real application and PostgreSQL 16, through the API
and in Chromium. The **CoA panel** of r2-coa-reports (`CoaPanel.tsx`, same wave) is mounted and the browser-side CoA generator is gone;
the history panel (r1-audit `RecordHistory`) stays mounted. Not done: reagent **lot** selection in the grid (no result-to-lot link
exists yet; r2-reagents owns it) and the **custody panel** (`Custody.tsx` does not exist in the tree yet; r2-custody-labels).

This track was resumed three times after a usage limit. The second resumption reviewed the work in the tree (kept as it was), mounted
`CoaPanel`, re-ran the gate simulation, the shared checks and the browser check, and updated this file. The third resumption changed
no code: it reviewed the four owned files and both tests again against the other W3 tracks' in-flight work (r2-oos-workflow's OOS
schema and statuses, r2-docs-training's qualification guard in `saveResult`), and re-ran everything on a simulation of the whole wave
(see "Third resumption" under Evidence). No migration was needed, so none of the reserved numbers 0180-0189 is
used (0180 is already taken by r2-qms's `0180_qms.sql`; see decisions).

## What changed

| Area | Files |
|---|---|
| Route | `src/server/routes/results-batch.ts` (new): `PUT /samples/:id/results-batch` |
| Validation | `src/lib/validations/results-batch.ts` (new): strict request schema, 1 to 200 rows, a row once, no server-controlled field |
| Grid | `src/components/ResultGrid.tsx` (new): the workbench, its pure pieces (keyboard, advisory chip, instrument option, what a save sends, refused-save mapping) and the presentational table. `ResultRow`, `formatResultLimit` and `ResultEvaluation` moved here from SampleDetail (re-exported there, so `Reports.tsx` and older tests are unchanged) |
| Sample screen | `src/components/SampleDetail.tsx`: the pencil-per-row editor is replaced by `ResultGrid`; "Open investigation" posts `POST /oos`; `CoaPanel` (r2-coa-reports) is mounted for an Approved or Rejected sample, and the browser "Download CoA" (jsPDF in the page) is removed: the certificate is issued, numbered, signed and rendered on the server, with the unit beside the value (`src/server/reports/pdf.ts`) |
| Tests | `tests/api/result-ui-batch.test.ts` (11, real app + PostgreSQL), `tests/api/result-ui-grid.test.ts` (16, react-dom/server, pure functions, and the panels the sample screen mounts) |

### PUT /samples/:id/results-batch

Body `{ items: [{ resultId, value, expectedVersion, instrumentId?, reason?, reasonCode?, oosId? }] }`. One transaction:

1. The sample row is locked (same order as `saveResult`). 403 unless the role may enter results; 423 if the sample is Approved or
   Rejected; 409 unless it is in Testing.
2. Every row must belong to the sample: 404 otherwise.
3. **Stale check before any write:** every row whose `expectedVersion` is not the stored version is collected; if there is one, the
   whole save is refused with **409 `RESULTS_STALE`**, `details: [{ path: 'items.<n>', resultId, parameter, message }]` for every stale
   row. Nothing is written, no audit entry exists.
4. Overwriting a value needs the row's own reason (400 naming the parameter). A first entry without a typed reason is audited with
   the reason `Initial entry`. A row that changes nothing (same evaluated value, same instrument) is 400, so no audit row exists
   without a change.
5. Each row goes through `saveResult` (r1-results-oos), unchanged: evaluation by the server, OOS replacement rule, coded correction
   reason (r2-raw-data), result guards (instrument Active and calibrated: the existing `GxP Violation` text; method and SST guards of
   r2-methods-calc), version predicate, **one audit row per value** (`Result` / `value`, old value, new value, reason), the result
   version, and the OOS investigation opened in the same transaction with its outbox event (r2-events). A refusal of any row rolls
   back all rows and answers that refusal with the row in `details`.
6. Answer: `{ sampleId, saved: [result + oosInvestigationId] }` in request order.

The stored value is what the analyst typed (unrounded); rounding is only applied by the evaluator for the comparison, so the audit
trail keeps the entered value (tested: `97.96` is stored and audited as `97.96`).

### The grid

* One row per parameter: specification, unit, value, instrument, evaluation, investigation.
* Keyboard: Enter / ArrowDown next row, Shift+Enter / ArrowUp previous row (rows that cannot be typed are skipped), Tab keeps the
  browser order (value, instrument, next value), **Ctrl+S / Cmd+S saves all dirty rows**. There is a Save all and a Discard button.
  Nothing is saved automatically; leaving the page with unsaved rows asks first (`beforeunload`).
* **Advisory chip**: a dashed chip with the word "advisory" applies the server's own evaluator (`src/server/lib/evaluate.ts`) to
  the typed value (PASS, OOS, or "Not acceptable" with the parser's reason). The caption says the server evaluates on save. After the
  save the server's evaluation (`isOos`) is shown.
* Instrument dropdown: an instrument that is not Active is disabled with its status; one past its calibration due date is disabled
  with "calibration overdue, was due <date>" (`calibrationState`, the rule the server guard uses).
* A dirty row that already holds a value shows "Reason for change" and the coded reason (the OOS Phase I codes when the value is
  OOS, with the open investigation's id). Until both are given the row is held back on the screen, highlighted with the reason, and
  nothing is sent (all or nothing on the screen too).
* A refused save: the rows named in `details` are highlighted (`data-stale="true"` for stale rows) with the server's message, and a
  toast says nothing was saved. "Reload latest values" reloads the sample and keeps what the analyst typed, so a stale row becomes an
  overwrite of the colleague's value that needs its own reason.
* OOS rows link to their investigation (`#/oos/<id>`, with its status); an OOS row with no investigation offers "Open
  investigation" (`POST /oos`; the parameter and date are the server's).
* The sample screen mounts the CoA panel only for an Approved or Rejected sample; nothing on the screen composes a certificate.

## Why

* M19: results were edited one row at a time through a pencil icon; units were not shown beside values; after an OOS the screen
  offered nothing.
* Top defect "SampleDetail save payload omits instrumentId": already fixed by r1-results-oos for the single-row editor; the grid sends
  the instrument per row, and the calibration block is reachable (tested in the browser: G2, and via the API).
* Top defect `isOOS`: the grid and the CoA read `isOos` (r1's static check still passes).

## Deliberate behaviour changes

1. The sample screen saves through `PUT /samples/:id/results-batch` instead of `PUT /samples/:id/results/:resultId`. The single-row
   route is unchanged and still used by `tests/security-controls.sh`.
2. A first entry may be saved without a typed reason; it is audited as `Initial entry` (the single-row route still requires a
   reason). The free-text reason is still required for any overwrite, with its coded reason.
3. A batch row that changes nothing is refused (400). The single-row route is unchanged.
4. The old "attachment on the result row" link is still shown for rows that carry an inline attachment; new files go through
   r2-raw-data's attachment panel below the grid.
5. The "Download CoA" button (a certificate composed in the browser, unnumbered and unsigned) is gone; the CoA panel replaces it. This
   is r2-coa-reports' `docs/changes/r2-coa-reports.sampledetail.patch`, applied here because this track owns `SampleDetail.tsx`.
   `coaRows()` (only used by that generator) is removed; `coaCertification()` stays exported because r1's
   `tests/api/results-ui.test.ts` imports it.

## How to verify

```
# isolation: own database and port
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r2_result_ui npx vitest run tests/api/result-ui-batch.test.ts tests/api/result-ui-grid.test.ts
#   shared tree WITHOUT the gate patch: result-ui-grid 16 pass; result-ui-batch cannot start the app while another W3 track's
#   routes are registered without rules (r2-docs-training in flight), or answers 404 (route not mounted)
git apply docs/changes/r2-result-ui.gate.patch
SQL_... npx vitest run                         # whole suite
npm run lint
```

## Evidence

* **Third resumption: whole-wave gate simulation** (scratchpad `rui-sim3`: a copy of the shared tree with every W3 track's in-flight
  files, then the four W3 gate patches applied in the order r2-coa-reports, r2-docs-training, r2-oos-workflow, r2-result-ui. This
  track's patch applied without conflict (offsets/fuzz only). The other three conflict with each other in `src/db/protections.ts`,
  `src/db/schema/index.ts`, `src/server/jobs/handlers/index.ts` and `src/lib/permissions.ts` (one-line list additions, merged by
  hand in the simulation only) and in `tests/upgrade/upgrade-v0.1.0.test.ts` (r2-oos-workflow's hunk left unmerged).
  `tests/route-table.json` (`dump-route-table.ts --stdout`), the permission matrix and `desktop/schema.sql` were regenerated):
  * `result-ui-batch` 11, `result-ui-grid` 16, r1's `results-ui` 4: **31 passed, 0 failed**.
  * Mutation re-check: the stale pre-check disabled turns "a stale row refuses the WHOLE save" red (1 failed, 10 passed); restored.
  * `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): **131 files passed, 1 failed, 2 skipped; 1570 tests passed, 2 failed,
    3 skipped**. The 2 failures are both in `tests/upgrade/upgrade-v0.1.0.test.ts`, the file whose r2-oos-workflow hunk (the 0210 row
    counts) was left unmerged. That is the gate's merge, not this track's.
  * `npm run lint`: web clean; server "18 known error(s) in the baseline, none new".
  * `npm run build`; fresh database `lims_r2_result_ui_srv` by `dist-server/init-db.cjs` (22 migrations to 0210_oos_workflow), then
    `delete from users` and the demo seed; server on 127.0.0.1:3108 (stopped afterwards): `tests/security-controls.sh` **34 PASS,
    0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**. Neither script was edited.
  * Browser (Chromium, `scratchpad/rui-browser.cjs`, same server): **12 PASS, 0 FAIL** (G1 to G12 as below). r2-docs-training's
    qualification guard did not block the seeded analyst.
  * Shared tree without the patch: `result-ui-grid` 16 pass; `npm run lint:web` shows the 2 known `evaluate.ts` errors that the
    patch's evaluate.ts hunk removes.

* **Test first.** Both test files were run on the old code (the first, interrupted attempt had written them and the request
  schema): `result-ui-batch` **11 of 11 failed** (404: no such route); `result-ui-grid` failed to load (no `ResultGrid` module, 14
  tests). Then the route and the grid were written until both passed. Second resumption: the two panel tests were added first and run
  on the tree as it was: "mounts the CoA panel ... composes no certificate in the browser" **failed** (no `CoaPanel` import, jsPDF
  present); after the change 16 of 16 pass.
* **Gate simulation, second resumption** (scratchpad `rui-sim`: the index of the shared tree, plus this track's files and
  r2-coa-reports' files, both gate patches applied, `tests/route-table.json` and the permission matrix regenerated; the CoA panel
  needs r2-coa-reports' routes):
  * `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): **123 files passed, 1 failed, 2 skipped; 1512 tests passed, 2 failed,
    3 skipped**. The 2 failures are `tests/upgrade/desktop-schema.test.ts`: `desktop/schema.sql` was not regenerated for
    r2-coa-reports' `0190_coa_reports.sql` (theirs to regenerate, not this track's); after `migrate-cli export-schema` in the
    simulation, that file, `qms-migration` (one "terminating connection" error during its drift test in the full run), both
    result-ui files and `coa-reports.test.ts` pass: **5 files, 57 tests, 0 failed**.
  * `npm run lint`: web clean; server "18 known error(s) in the baseline, none new".
* **Mutation checks** (first attempt's simulation; each turned a test red): stale pre-check off (1), overwrite-reason check off (1),
  no-change check off (1), row `details` on refusals off (2), overdue instrument not disabled (2), clean rows sent in the save (1).
* **Shared checks** on the simulation's production bundle (`npm run build`; fresh database `lims_r2_result_ui_srv` by
  `dist-server/init-db.cjs` to 0190_coa_reports, demo seed; server on 127.0.0.1:3108, stopped afterwards):
  `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**. Neither script was edited.
* **Browser** (Chromium via Playwright, built bundle, same server; hand-run script `rui-browser.cjs` in the scratchpad, not in the
  repository because `tests/ui/**` belongs to r2-validation): **12 PASS, 0 FAIL**: one input per parameter; the instrument 3 days
  overdue is disabled with its due date; Enter moves to the next row; the live chip says OOS and advisory; nothing is written before
  the save (1.5 s wait); Ctrl+S saves every row with one audit row per value; overwriting shows the reason field of that row only; an
  overwrite without reason is held back with the reason; a colleague's save meanwhile makes Ctrl+S answer 409 with that row
  highlighted and its message; the refused save wrote no audit entry; a Testing sample shows no CoA panel; an Approved sample shows
  the CoA panel and no "Download CoA". (The script's own row order was first taken from the database id order; it now reads the
  grid's order.)
* Desktop (`tests/desktop-*.cjs`) not run: this track touches no file under `desktop/`, the build, migrations or start-up.

## For the gate

```
git apply docs/changes/r2-result-ui.gate.patch
#   src/server/routes/index.ts       import + register resultsBatchRoutes
#   src/server/authz/routeTable.ts   'PUT /samples/:id/results-batch': perm('result.enter', { body: resultsBatchSchema })
#   src/server/lib/evaluate.ts       `!bound.ok` / `!parsed.ok` -> `=== false` (same behaviour; lets the non-strict web tsconfig narrow)
#   tests/route-table.json           +1 route
#   docs/permission-matrix.csv       result.enter lists the new route
```

**Do not apply `docs/changes/r2-coa-reports.sampledetail.patch`**: its change is already in this track's `SampleDetail.tsx`, together
with the removal of the then unused `coaRows` and `formatResultLimit` import, so the patch no longer applies either way. r2-coa-reports' `gate.patch` (routes, route table, permissions, schema index,
protections, job handlers) is still needed for the panel to work, and `desktop/schema.sql` must be regenerated for its migration.
The W3 gate patches touch neighbouring lines of `src/server/routes/index.ts` and `src/server/authz/routeTable.ts`; applied after the
other three W3 patches, `patch -p1` applies this one with offsets and fuzz only (checked in the third resumption).

If another W3 patch also regenerates `tests/route-table.json` or the matrix, regenerate instead of merging by hand:
`NODE_ENV=test JWT_SECRET=<16+ chars> npx tsx tests/helpers/dump-route-table.ts` and `npx tsx scripts/authz/export-matrix.ts`.

**Until the patch is applied**, `npm run lint:web` in the shared tree reports 2 errors in `src/server/lib/evaluate.ts` (lines 68 and
75): the web project is not strictNullChecks, and `ResultGrid.tsx` now imports the evaluator so the advisory chip uses the server's
own rule instead of a copy. The patch's evaluate.ts hunk removes them without changing behaviour.

## Decisions that need confirmation

* A first entry without a typed reason is audited as `Initial entry` (ALCOA+: the who, when, old and new value are captured; the
  reason for a first entry is not a correction). Overwrites always need a free-text reason (5+ characters) and a coded reason.
* Stale handling: a stale row refuses the whole save (no partial save), as the roadmap says; the screen keeps the typed values after
  a reload so the analyst must deliberately overwrite the colleague's value with a reason.
* At most 200 rows per save.
* The advisory chip uses the server's evaluator and rounding rule (half-up to the declared decimals, USP General Notices 7.20 as
  implemented by r1-results-oos); it is labelled advisory and the server's verdict is the record.
* The batch route keeps the entry roles of `saveResult` (Analyst, Admin, Instrument service account) while the permission matrix still
  grants `result.enter` to Reviewer and QA (open item from r1-results-oos).
* The CoA panel is shown for an Approved or a Rejected sample (as r2-coa-reports cut it); for a Rejected sample it shows why no
  certificate can be issued. It is not shown while the sample is Logged, in Testing or Pending Review.
* Reserved migration numbers 0180-0189 overlap `0180_qms.sql` (r2-qms) and an in-flight `0190_coa_reports.sql` exists; this track
  needs no migration, so no number was used.

## Needs from other tracks

| Owner | Change |
|---|---|
| Gate (routes/index.ts, authz/routeTable.ts, evaluate.ts, route-table.json, permission matrix) | Apply `r2-result-ui.gate.patch` |
| r2-reagents (M30) | A result-to-lot link (usage ledger). Once a lot endpoint and a `lotId` on the result save exist, the grid can offer lots (expired/quarantined disabled) and the batch schema can take `lotId` |
| r2-coa-reports (M25) | Nothing more: the panel is mounted and the server CoA prints the unit. Their `sampledetail.patch` is applied here (see "For the gate") |
| r2-custody-labels (M29) | A custody panel component (`Custody.tsx`) for the sample screen to mount |
| r2-validation (M37) | Turn the scratchpad browser check into a Playwright test under `tests/ui/`; `tests/client-shell.cjs` C11/C12 still drive the old pencil editor (`tbody tr td:last-child button`) and need the grid's selectors (`#value-<resultId>`, Ctrl+S); URS/OQ/RTM entries for M19 |
| r1-authz / QA | Align `result.enter` in the default matrix with the entry roles (unchanged open item) |

## Not done

* Lot selection (see above). No retention or purge concern: nothing new is stored beyond what `saveResult` already stores.
* The custody panel is not mounted (`Custody.tsx` not delivered yet).
* The pre-existing `handleGenerateReport` in `SampleDetail.tsx` (POST /reports/generate, now a preview per r2-coa-reports) is not
  wired to any button; it was left as it was.
* `tests/client-shell.cjs` (hand-run, r1-client-shell) is not updated; it is not in this track's files.
