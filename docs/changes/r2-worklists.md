# r2-worklists: worklists and batch runs (roadmap M33)

Release R2, wave W5. Changes are uncommitted; the wave gate commits them. Companion: `docs/changes/r2-worklists.gate.patch` (wiring in files this track does not own).
Status: **complete once the gate patch is applied** (all three M33 acceptance criteria pass in a simulation of HEAD + this track + the patch).

## What changed
| Area | Files |
|---|---|
| Migration 0270 | `drizzle/0270_worklists.sql`: `worklists`, `worklist_items`, permissions `worklist.view` / `worklist.manage` (positions 270-271) |
| Schema | `src/db/schema/worklists.ts` |
| Rules | `src/server/worklists/{schemas,service,grid,export,benchSheet}.ts` |
| Routes (17) | `src/server/routes/worklists.ts` |
| Result guard | `src/server/services/result-guards/assignment.ts` (`NOT_ASSIGNED`, 403) |
| Screen | `src/components/Worklists.tsx`, `src/components/shell/ext/worklists.tsx` (new shell extension, #/worklists) |
| Tests | `tests/api/worklists.test.ts` (28, real app + PostgreSQL), `tests/api/worklists-ui.test.ts` (9) |

## Behaviour
* Worklist `WL-<year>-<nnnn>` (gap-free counter): one Effective method, optional instrument (Active, in calibration, of the method's instrument type), planned date. Draft -> Released (membership frozen) -> Completed / Cancelled.
* Items: Sample (one result, assignee) or Standard / Blank / SST / Control (label). Items are never deleted (Removed with a reason).
* Add / reassign rejects an assignee who is not an active Analyst/Admin or whose method training is overdue: 400 naming method, training module (curriculum code) and assignment (QA override accepted and audited).
* A result is on one Draft/Released worklist at a time (409, row lock); a result that already has a value, of another method, unbound, or of an Approved/Rejected sample is refused.
* After release every add / change / remove / reorder / header edit needs a reason; without it: 400 and an audit entry `ChangeRefused` (own transaction). Membership changes bump the worklist version, so release (with `expectedVersion`) never freezes unseen membership.
* Assignee enforcement: guard `assignment` -> 403 `NOT_ASSIGNED` for anyone else while the worklist is Released (also through the sample's single and batch save routes). Draft, Completed, Cancelled assign nothing. The `Instrument` service account is exempt.
* Grid `PUT /worklists/:id/grid`: each cell through `saveResult` in its own transaction (OCC, guards, one audit entry per cell). 200 if all saved, 207 with `failed[{index,resultId,status,code,error}]` otherwise (per-cell 409 / 403 / 400).
* `GET /worklists/:id/run-sequence.csv` (audited `Export`, formula-injection safe), bench sheet PDF via job `worklist.bench_sheet` (`POST .../bench-sheet`, download `GET /worklists/bench-sheets/:jobId`, owner only), `GET /worklists/candidates?methodCode=`, `GET /worklists/workload` (per analyst and instrument: planned, on bench, pending, overdue).

## Verify
```
patch -p1 < docs/changes/r2-worklists.gate.patch
# regenerate: tests/helpers/dump-route-table.ts --stdout > tests/route-table.json (+17 routes); scripts/authz/export-matrix.ts (+2 permissions); migrate-cli.ts export-schema (through 0270)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r2_worklists npx vitest run tests/api/worklists.test.ts tests/api/worklists-ui.test.ts
```
Evidence (simulation, DB `lims_r2_worklists`, port 3117): mutation checks turned tests red (guard unregistered: 3a, reassignment, non-assignee grid; reason rule removed: acceptance 2; qualification check removed: acceptance 1). Full `npx vitest run`: 143 files passed, 3 skipped; 1718 passed, 4 skipped, 0 failed. `tsc` web clean; server 18 known errors, none new. After `npm run build` the installer applies through 0270; `backup-restore.sh` 18 PASS / 0 FAIL; `security-controls.sh` 34 PASS on a fresh run (a second run within the same 30 s TOTP step fails the TOTP replay check by design). Desktop tests not run (no desktop/ or startup file touched).

## Decisions needing confirmation
* `worklist.manage` (plan, release, change): Analyst, QA, Admin; `worklist.view`: every role. Release has no e-signature and no independence rule.
* Assignment is enforced only while Released; Instrument service accounts are exempt.
* A result with a value is not worklisted; results of unbound parameters cannot be worklisted.
* Grid saves are per cell (207), not all-or-nothing as the sample's results-batch.
* The assignment is the worklist item itself (no separate `result_assignment` table); one table fewer.
* Removing an item always needs a reason, also on a Draft.

## Not done
* No DB triggers (append-only / row guards) on the new tables; the application never deletes rows.
* No `worklist.*` events to the r2-events outbox; no reagent-lot selection in the worklist grid.
* Browser session not run; desktop tests not run.
