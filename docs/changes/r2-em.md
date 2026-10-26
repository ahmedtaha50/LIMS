# r2-em: the environmental monitoring programme (roadmap M32)

Release R2, wave W4. Branch `claude/project-implementation-tirr4j`. Changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-em.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** The three M32 acceptance criteria pass in a gate simulation. In the shared tree
without the patch the `/em/*` routes have no route-table rule (deny by default), so `tests/api/em.test.ts` cannot pass there;
`tests/api/em-ui.test.ts` passes as it is.

## What changed

| Area | Files |
|---|---|
| Migration (0250) | `drizzle/0250_em.sql`: `em_sampling_points`, `em_limit_profiles`, `em_results`, `em_excursions` (append-only), `em_batch_rooms`, `em_trend_flags`; meaning `EM_LIMIT_APPROVAL`; permissions `env.manage`, `env.correct` (positions 250, 251; QA and Admin); 25 Draft limit profiles (copy of the 14 active `env_limits` rows plus 11 example particle limits per ISO class). Constants only under the runner |
| Schema | `src/db/schema/em.ts` |
| Engine | `src/server/em/`: `constants.ts`, `schemas.ts` (strict), `engine.ts` (judging, excursion + deviation, batch impact), `trends.ts` (rules), `routes.ts` (21 routes under `/em`), `entities.ts` (signable `EmLimitProfile`), `protections.ts`, `index.ts` |
| Routes | `src/server/routes/env.ts` mounts the `/em` routes; the legacy `/env-records` action level now also opens its deviation |
| Schedule | `src/server/schedules/em.ts`: `em.trends` daily 05:40 |
| Screen | `src/components/Environmental.tsx`: results, heat grid and trends, sampling points, limit profiles (signed approval), batch rooms, legacy records |
| Seed | `scripts/dev/seed/seeds/em.ts` (sampling points only; limits stay Drafts) |
| Tests | `tests/api/em.test.ts` (17), `tests/api/em-ui.test.ts` (5) |

## Behaviour

* Sampling points: site map (room, grade), QA-maintained, versioned, audited with a reason; retired, never deleted.
* Limit profiles: per grade, method (4 viable, 2 particle sizes) and occupancy, with ISO class for particles and a cited source.
  Draft, then Approved by an `EM_LIMIT_APPROVAL` signature bound to the version, by someone who did not write or edit it (403 SOD_VIOLATION,
  checked before the password); approval retires the profile it replaces; an Approved profile is frozen. Only Approved judges; no profile is 400.
* Results: strict body (no status, unit, grade, room, limits); viable results need media lot and incubation start/end; status, unit,
  limits and the profile used are copied by the server. Correction needs `env.correct` (QA, Admin), reason and version; an Analyst gets 403.
* Excursion: Action opens the excursion and a deviation (M27 `em-excursion`) in the same transaction and links it (`affects`) to every
  batch whose room window covers the sampling day (so the QMS release blocker holds it). A window recorded later links open excursions.
* Batch dossier: `cleanroom` now lists only results of the batch's rooms inside its windows; a batch with no window has none.
* Trends (scheduler, API, QA "evaluate now"): 3 consecutive Alert-or-above at a point and method; 2 Actions at a point within 30 days;
  same organism twice in a room within 90 days. One flag per finding (dedupe key), acknowledged by QA. Heat grid: worst status per point and week.

## Evidence (simulation `scratchpad/emsim`: HEAD plus all in-flight files plus the gate patch)

* Red first (`scratchpad/em-red.txt`): the new tests against HEAD failed (404 on `/em/*`; dossier returned `ENV-...` instead of the window result).
* `npx vitest run`: 133 files passed, 2 skipped; 1591 tests passed, 3 skipped, 0 failed (includes upgrade tests with 0250).
* `npm run lint`: web clean; server 18 known baseline errors, none new.

## For the gate

`git apply docs/changes/r2-em.gate.patch` (14 files: schema index, protections registry, permissions, route table, schedules index, job
handlers, traceability route and screen, seed index and legacy EM seed, upgrade test, regenerated `route-table.json`,
`permission-matrix.csv`, `desktop/schema.sql`). It was generated against HEAD; if other W4 patches changed the same context lines, add the
one-line list entries by hand and regenerate the three derived files. Delete the patch afterwards.

## Decisions needing confirmation

* The example limits (viable from 0070; particles from Annex 1 Table 5 as I recall it) are Drafts, unapproved: verify against the current text and the site SOP before approving.
* Trend rule parameters (3 in a row, 2 Actions in 30 days, organism twice in 90 days) and the lookback of one year.
* QA/Admin hold `env.manage` and `env.correct`; recording and identifying stay open to all roles.
* Approver may not have created or edited the profile (so a single QA user cannot both draft and approve).
* An action-level result always opens a deviation, unclassified (blocks release of exposed batches until QA classifies it).
* Batch room windows are entered by QA, not derived from batch records.

## Not done

* Shared checks (`security-controls.sh`, `backup-restore.sh`) and the desktop installer tests were not run on a production bundle.
* No browser session; the screen is covered by render tests only.
* Legacy `env_records`, `env_limits`, `env_excursions` are left as they were (not migrated into the new tables, no data rewrite); legacy excursions have no closing flow.
* Tolerance for particle monitoring continuity, organism identification detail (genus/species) and notifications on new trends/excursions are out of scope.
* No URS/OQ/RTM entries.
