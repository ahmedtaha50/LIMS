# r2-tat-kpi: turnaround time and honest, role-based key figures (roadmap M34)

Release R2, wave W5. Branch `claude/project-implementation-tirr4j`. Changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-tat-kpi.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied**, with the gaps listed under "Not done" (no screen yet to edit the calendar, the SLA rules
or a sample's priority; the API for all three is done and tested). In the shared tree without the patch the new routes have no route-table
rule (deny by default) and the event type is not in the catalog, so `tests/api/tat-kpi.test.ts` and `tat-kpi-migration.test.ts` cannot pass there;
`tests/unit/business-calendar.test.ts` and `tests/api/tat-kpi-ui.test.ts` pass as they are.

## What changed

| Area | Files |
|---|---|
| Migration (0280) | `drizzle/0280_tat.sql`: `business_calendar` (one row), `business_holidays`, `tat_sla_rules`, `sample_tat` (1:1 sidecar of `samples`). No rows are written; defaults live in code and are marked as defaults |
| Schema | `src/db/schema/tat.ts` |
| Calendar | `src/server/lib/businessCalendar.ts`: pure `addBusinessDays` / `isBusinessDay`, weekend days, IANA time zone (DST-safe, same local clock time), holidays |
| Sweep | `src/server/schedules/tat.ts`: `tat.sweep` every 10 min starts the clock of received, unfinished samples and announces due-in-24h and overdue once each (event `sample.tat_alert`); also `setPriority`, `calculateDue`, loaders |
| API | `src/server/routes/metrics.ts` (mounted by `dashboardRoutes`): `GET /metrics/tat`, `GET /metrics/kpi`, `GET /metrics/kpi/:key`, `GET /tat/settings`, `PUT /tat/calendar`, `POST /tat/holidays`, `POST /tat/holidays/:id/remove`, `PUT /tat/sla/:priority`, `GET|PUT /tat/samples/:id` |
| Dashboard | `src/server/routes/dashboard.ts`: composite score removed, `pendingApprovals` and `generatedAt` added, deterministic ordering (`COLLATE "C"`) |
| Screens | `src/components/Dashboard.tsx` (role tiles that open their list, turnaround panel, dated facts), `ComplianceOverviewWidget.tsx` (no score, no static claims), `ActivityHeatmap.tsx` (a failed load is shown, not swallowed) |
| Tests | `tests/unit/business-calendar.test.ts` (15), `tests/api/tat-kpi.test.ts` (25), `tests/api/tat-kpi-ui.test.ts` (11), `tests/api/tat-kpi-migration.test.ts` (2) |

## Behaviour

* **Due date.** Receipt (`sample_custody.received_at`) plus the SLA of the priority in business days, same local clock time, counting from the next day. A
  Thursday 16:00 receipt, 2 business days, Fri-Sat weekend: Monday 16:00 (table test, and through the API with the Urgent rule set to 2). Calculated once, by the sweep or when a
  person sets the priority, and stored: changing the calendar or an SLA later does not move due dates already given.
* **Priority** (Routine, Urgent, Critical) is set with `PUT /tat/samples/:id` (reason required, version required once a row exists, audited in the same transaction, refused for a
  finished sample). It may be set before the receipt; the sweep adds the due date when the sample is received.
* **Cycle time** is derived, not stored: receipt (registration if no receipt record exists) to the **first** Approved or Rejected `Transition` in `audit_trail`. Median and P90 are
  `percentile_cont` (linear interpolation). **On-time %** counts finished samples that have a due date. Samples without one are left out and the response says how many.
* **OOS rate by parameter** = results with a recorded value in the window that are out of specification. **Right first time** = approved with no OOS investigation and no rejection in their history.
  The definitions are returned with the numbers.
* **Aging** of open samples in 5 buckets from the clock start; open and overdue totals.
* **Tiles.** The server picks the tiles of the caller's role (Analyst, Reviewer, QA, Admin). The count and the list of a tile are two selects of the same text (`sqlTile`) or the same
  function (`listTile`), so they cannot disagree; `GET /metrics/kpi/:key` returns `total` and up to 200 rows, and a tile outside the caller's role is 403. Facts (last audit-chain
  verification, last backup) are dates and outcomes, QA and Admin only, never a score.
* **Dashboard honesty.** The invented composite/"audit ready" score and its pillars are gone (`scoreBasis` now says no score is computed); the static Part 11 / USP 1058 / "AIQ"
  statements are removed; "Pending Approvals" is one number (`pendingApprovals`) shared by the chart, the workload bar and the widget; Active OOS counts every non-terminal investigation and
  drops by one when QA closes one (tested through the real close route).
* Alerts and clocks started by the scheduler are attributed to the service principal `svc-scheduler` with the reason "Scheduled: tat.sweep".

## Evidence (simulation `scratchpad/tksim`: HEAD plus the in-flight files of this track plus the gate patch)

* Red first: `scratchpad/tk-red.txt` (the new API test file against HEAD fails in `beforeAll`, the module and routes do not exist); the UI test against HEAD fails 11 of 11; the unit test failed on the missing module before `businessCalendar.ts` was written.
* `npx vitest run` (whole suite): 145 files passed, 3 skipped; 1734 tests passed, 4 skipped, 0 failed (8 min 25 s). After a last ordering edit in `dashboard.ts`, the six affected files (tat-kpi x3, business-calendar, equipment-dashboard, route-contract) were re-run: 75 passed.
* `tests/upgrade/schema-drift`, `desktop-schema`, `runner`, `protections`: passed with 0280 (no drift between `src/db/schema/tat.ts` and the migration).
* `npm run lint` in the simulation: web clean; server "18 known error(s) in the baseline, none new". In the shared tree the checks show errors only from the other W5 tracks' files and from the event type that the gate patch adds.
* Production bundle (simulation, `npm run build`, fresh database through `dist-server/init-db.cjs`: 27 migrations ending at 0280_tat, demo seed, server on 127.0.0.1:3118, stopped afterwards):
  `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**. Neither script was edited. `GET /metrics/kpi`, `/metrics/tat` and `/dashboard` answered on the bundle.
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
* CI traps: every text `ORDER BY` uses `COLLATE "C"` or is sorted in JS; no test depends on file modes, the running user, or how `localhost` resolves; the sample fixture calls `receiveSample` before testing.
  Dates in the tests are fixed or relative to the clock, never to the machine's time zone (the calendar tests pin `UTC`, `Africa/Cairo` and `Europe/Berlin`).

## For the gate

`git apply docs/changes/r2-tat-kpi.gate.patch` (8 files: schema index export, route-table rules for the 11 routes, `TAT_SCHEDULES`, `TAT_HANDLERS`, the `sample.tat_alert` event, and the regenerated
`tests/route-table.json`, `docs/permission-matrix.csv`, `desktop/schema.sql`). If other W5 patches change the same context lines, add the one-line list entries by hand and regenerate
the three derived files (`npx tsx tests/helpers/dump-route-table.ts --stdout`, `npx tsx scripts/authz/export-matrix.ts`, `npx tsx src/server/boot/migrate-cli.ts export-schema`). Delete the patch afterwards.
No permission and no signature meaning was added, so `src/lib/permissions.ts` and the upgrade test are untouched.

## Decisions needing confirmation (conservative defaults implemented)

* **Weekend and time zone**: until QA saves a calendar the default is Saturday and Sunday in UTC, no holidays. A site with a Friday-Saturday weekend must save its calendar (`PUT /tat/calendar`); the screen of the settings does not exist yet (see below).
* **SLA**: Routine 10, Urgent 3, Critical 1 business days until a rule is saved. These numbers are placeholders, not a regulatory or customer commitment.
* **Permissions**: calendar, holidays and SLA rules use `master.manage` (QA, Admin); a sample's priority uses `sample.transition` (every role). No e-signature is asked, because priority and due date schedule work and do not release or approve a record; they are audited with a reason and versioned.
* **Clock**: starts at the receipt record, never at registration; samples already Approved or Rejected when the migration is installed get no due date (no history is rewritten) and are left out of on-time %.
* **Backfill alerts**: the first sweep gives every received, unfinished sample a Routine due date and announces those already past it (one event each, audience: everyone who can view samples).
* **Cycle time** ends at the first Approved or Rejected transition, so a later revocation does not lengthen it. Reporting window defaults to 90 days.
* **Tile set per role** (which figure each role sees) is a judgement; it is one array in `metrics.ts`.
* **Drill-through** opens the list inside the dashboard (same predicate as the count) plus a button to the owning screen; the owning screens do not take filters yet.

## Not done

* No screen to edit the business calendar, holidays, SLA rules or a sample's priority, and no priority / due-date column in the sample list or registration (files owned by other tracks: `Samples.tsx`, `SampleDetail.tsx`, the admin screens). The API and its tests are complete.
* The tiles open a list inside the dashboard; they do not deep-link into a filtered native screen (`GET /samples` filters only by state and batch).
* The clock starts within 10 minutes of the receipt (sweep), not in the receipt's own transaction. A one-line call to `setPriority` / `calculateDue` from the custody receipt would make it immediate.
* `GET /reports/metrics` and `/reports/trends` (owned by r2-coa-reports) were not reviewed for the "metrics ignore Logged" remark of the gap text; the dashboard and the new endpoints count Logged samples explicitly.
* No browser session; the screens are covered by type-check, build, bundle start and render tests. No URS/OQ/RTM entries.
