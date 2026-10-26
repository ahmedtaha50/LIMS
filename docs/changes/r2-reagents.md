# r2-reagents: reagent, reference-standard and solution lifecycle with the usage-to-result link (roadmap M30)

Release R2, wave W4. Branch `claude/project-implementation-tirr4j`. Changes are left uncommitted for the wave gate.
Companion file: `docs/changes/r2-reagents.gate.patch` (wiring in files this track does not own; see "For the gate").
An earlier attempt was cut off by a usage limit before writing files; everything here was written in this run.

Status: **complete once the gate patch is applied**. In the shared tree without the patch the new routes and guard are not mounted, so
`tests/api/reagents.test.ts` cannot pass (the application does not start while other W4 routes lack rules, or the routes answer 404).
All three M30 acceptance criteria pass in a gate simulation (HEAD + shared tree + this patch).

## What changed

| Area | Files |
|---|---|
| Migration | `drizzle/0230_reagents.sql`: `reagent_items`, `reagent_lots`, `prepared_solutions`, `prepared_solution_components`, `reagent_transactions`, `result_materials`; 3 signature meanings; permissions `reagent.manage`, `reagent.use`, `reagent.approve` (positions 230-232) |
| Schema | `src/db/schema/reagents.ts` |
| Database controls | `src/db/protections/reagents.ts` (same statements as the migration): ledger append-only + balance trigger, solution-expiry trigger, lot / solution / link row guards |
| Routes | `src/server/routes/reagents.ts`: the legacy `reagentsRoutes` (unchanged behaviour) and the new `reagentInventoryRoutes` (28 routes) |
| Service and result guard | `src/server/services/result-guards/reagent.ts`: usability rules, ledger append, `linkResultMaterials`, guard `reagent-lots` |
| Schedule | `src/server/schedules/reagents.ts`: job `reagents.expiry` (hourly) |
| Screen | `src/components/Reagents.tsx` (lots, solutions, items, legacy register; material picker; `SampleMaterialsPanel` mounted by the gate patch in `SampleDetail`) |
| Tests | `tests/api/reagents.test.ts` (27), `reagents-ui.test.ts` (5), `reagents-scale.test.ts` (opt-in, 1) |

### Model
* **Lot**: received into `Quarantine` with the receiver's e-signature (`RECEIPT`, entity `ReagentLot`, bound to record version 1); first ledger row = quantity received.
  Released by a *second person* (`REAGENT_LOT_RELEASE`; the receiver gets 403 `SOD_VIOLATION`, audited `AUTHZ_DENIED`, costing no signature attempt) -> `Approved`;
  **opened** -> `InUse` with `in_use_expiry = min(expiry_date, opening day + item in-use shelf life)`; then `Consumed` (balance 0), `Disposed`, `Expired` (job) or `Rejected` (`REAGENT_LOT_REJECTION`, reason required).
  `REAGENT_LOT_RETEST` records a new retest date. Potency is stored with its basis (CHECK: both or neither; required at receipt for items that say so).
* **Prepared solution**: made from lots and/or other solutions, whose quantities are consumed in the same transaction. Its expiry may not be after any parent's use limit (lot: min(expiry, in-use expiry, retest date); solution: expiry): 400 naming the parent and its date, and trigger-enforced for any other writer.
* **Ledger** `reagent_transactions`: append-only (UPDATE/DELETE/TRUNCATE refused), `balance_after >= 0` (CHECK) and equal to the previous balance + delta (trigger). Ids/seq from counters (`RTX-000000001`, `reagent_tx`).
* **Usage link** `result_materials`: lot or solution per result, with the result version, the quantity (optional; writes a `Used` ledger row carrying the result id). Never deleted; a wrong link is withdrawn once with a reason.
* **Result block**: guard `reagent-lots` refuses to save a result while any linked, non-withdrawn material is expired, past in-use expiry or retest date, in quarantine, rejected, used up, or (solution) made from a rejected lot: 400 naming the lot and the date. `lotIds` on `PUT /samples/:id/results/:resultId` and on each row of `results-batch` links lots in the same transaction (the answer to `docs/changes/r2-result-ui.md`'s request); a lot that may not be used fails the save with nothing written.
* **Traceback** `GET /reagent-lots/:id/traceback` (and for solutions): every result measured with the lot directly or through any solution made from it (recursive, depth <= 20), capped at 5000 rows with `truncated`.
* **Job** `reagents.expiry`: flips lots/solutions past their use limit to `Expired` (audit entry each, one transaction each) and announces 30 and 7 days before (and "expired" = threshold 0) once per record, threshold and limit through the outbox event `reagent.expiry_alert`.
* The legacy v0.1.0 `reagents` table is untouched and shown read only; `POST /reagents` still works (compatibility). The screen now receives *lots*. The dashboard counts lots together with the legacy rows (`reagentLotCounts`).

## How to verify

```
git apply docs/changes/r2-reagents.gate.patch     # see "For the gate"
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r2_reagents npx vitest run tests/api/reagents.test.ts tests/api/reagents-ui.test.ts
REAGENT_SCALE_ROWS=100000 ... npx vitest run tests/api/reagents-scale.test.ts
```

| Acceptance | Evidence |
|---|---|
| Saving a result that lists an expired or quarantined lot returns 400 naming the lot and date | `reagents.test.ts` "usage-to-result link": expired, quarantined, retest-overdue, in-use-expired at link time; `PUT result` with `lotIds`; batch save; a lot rejected / expired *after* linking blocks later saves |
| Opening a lot sets in_use_expiry; a solution cannot expire after its parent | "opening a lot", "prepared solutions cannot outlive their parent" (API, dilution of a solution, and direct SQL against the trigger) |
| reagent_transactions rejects UPDATE/DELETE; traceback < 1 s on 100k results | "ledger and records cannot be rewritten"; scale test: **138 ms** for 100,000 linked results (10,000 for the lot, 5000 returned) |

## Evidence (gate simulation, database `lims_r2_reagents`, server on 127.0.0.1:3113)
* Test first: before the code, the routes did not exist (the new tests need them); in the shared tree without the patch the file does not run. Mutation checks, each turned tests red: guard `reagent-lots` removed (3 failed); in-use shelf life ignored (3 failed).
* `npx vitest run`: 134 files passed, 2 skipped; 1606 tests passed, 3 skipped, 0 failed (one `onTaskUpdate` worker timeout reported by vitest under load; no test affected).
* `npm run lint`: web clean; server "18 known errors, none new".
* After `npm run build`: installer applies 23 migrations to 0230; `tests/security-controls.sh` 34 PASS / 0 FAIL (fresh database); `tests/backup-restore.sh` 18 PASS / 0 FAIL (restored database has all 64 `gxp_` triggers). Neither script was edited.
* `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed; `tests/desktop-shell.cjs` 17 passed.
* The upgrade test needed `signature_meanings` 42 (in the patch). Protection and drift tests pass unchanged.

## For the gate
1. `patch -p1 < docs/changes/r2-reagents.gate.patch` (route registration, route-table rules, 3 permissions + matrix, protections registry, result-guard registry, `lotIds` in `saveResult` and both result schemas, `reagents.expiry` schedule + handler, `reagent.expiry_alert` event, dashboard lot counts, `SampleMaterialsPanel` in `SampleDetail`, upgrade-test meaning count 42).
   * `src/db/schema/index.ts` gets `export * from './reagents'`. If another W4 patch edits the same line list, merge by hand (one-line additions).
2. Regenerate: `dump-route-table.ts --stdout > tests/route-table.json` (+28 routes), `scripts/authz/export-matrix.ts` (+3 permissions), `migrate-cli.ts export-schema`.
3. The migration number is 0230 (reserved 0230-0239); the W4 migrations sort 0220, 0230, 0240, 0250.

## Decisions that need confirmation
* Lot release and rejection by a person other than the receiver (SoD), and who may do it: `reagent.approve` = QA and Admin. Receipt stays `reagent.receive` (Analyst, QA, Admin).
* In-use expiry: opening day + shelf life, capped by expiry; an item without shelf life uses the expiry date. A retest date past blocks use but does not change the lot's status.
* Release of an expired lot and opening past the retest date are refused; use of material "valid through the end of the date" (UTC).
* Unit conversion is not done: a component is consumed in the unit of its lot / solution.
* Items without potency required are allowed; reference standards require potency + basis by default.
* The legacy `reagents` rows are not migrated into lots (no lot release evidence exists for them); they remain read only.
* `reagent.use` is granted to every role (including Reviewer); `reagent.manage` to QA, Reviewer, Admin.

## Not done
* No per-result purity/potency-corrected calculation (potency is recorded, not applied by the calculation engine).
* The result grid (`ResultGrid.tsx`, r2-result-ui) does not yet show a lot picker per row; lots are recorded in the new panel under the grid (or via `lotIds`). A per-row picker belongs to r2-result-ui.
* Consumption units are not converted; no stock-count/reconciliation workflow; no low-stock alert.
* No URS/OQ/RTM entries (r2-validation); the OQ trigger count increases by 12 (64 guard triggers in total).
* Retest-date expiry does not flip the status automatically (only expiry and in-use expiry do).
