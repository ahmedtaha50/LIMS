# r2-instrument-integration: instrument data capture (roadmap M21)

Release R2, wave W5. Nothing is committed. Companion: `docs/changes/r2-instrument-integration.gate.patch` (wiring in files this track does not own; `git apply --check` passes on HEAD dac7721).
Status: **complete once the gate patch is applied.** Without it the routes are not mounted (deny by default) and the API tests cannot run; the unit, migration-structure and UI tests run anywhere.

## What changed
| Area | Files (new unless stated) |
|---|---|
| Migration 0260 (reserved range; the roadmap's `drizzle/013*` pattern was not used) | `drizzle/0260_instrument_data.sql`: `instrument_profiles`, `instrument_profile_revisions`, `instrument_files`, `instrument_import_rows`, `result_sources`, `instrument_usage_log`; meaning `INSTRUMENT_PROFILE_APPROVAL` (QA, Admin); permissions `instrument.profile.manage`, `instrument.profile.approve` (positions 260, 261) |
| Schema, DB controls | `src/db/schema/instrument-data.ts`, `src/server/connectors/protections.ts` (revisions, result_sources, usage log append-only; `instrument_files` may change only disposition, note, version) |
| Parsers | `src/server/parsers/`: generic CSV, balance text, pH CSV, HPLC summary CSV; RFC 4180 reader; strict per-parser mapping; readable `ParseError` with line numbers |
| Capture | `src/server/connectors/ingest.ts` (hash into blob store, duplicate refusal, calibration check, dry-run parse, one transaction), `folderAgent.ts` (fs.watch + poll + start-up scan), `paths.ts`, `guards.ts` (`unaccepted-imports`) |
| Routes | `routes/instrument-profiles.ts`, `routes/instrument-files.ts` (16 routes) |
| Screens | `components/ImportsReview.tsx` (values waiting, files, profiles; accept/reject, dry run, e-signed approval, upload), `components/Instruments.tsx` (usage log) |
| Tests | `tests/unit/instrument-parsers.test.ts` (17), `tests/api/instrument-integration.test.ts` (22), `instrument-agent.test.ts` (11), `instrument-migration.test.ts` (5), `instrument-ui.test.ts` (8), fixtures in `tests/fixtures/instrument-data/`, helper `tests/api/instrument-fixtures.ts` |

## Behaviour
* Profile: Draft until a different person signs `INSTRUMENT_PROFILE_APPROVAL` (author or any editor gets 403 `SOD_VIOLATION`, no attempt spent). The signature covers the revision at the signed version (revision rows are append-only, so it verifies after later edits). Editing an Approved profile withdraws approval (back to Draft, audited). Only Approved profiles are watched or accept uploads.
* Agent: reads only the realpath of the configured folder, regular files directly in it (no symlinks, sub-folders, `.part`/temp names, non-matching names, files modified within `settleMs`). Success: file registered, then moved to `processed/` after commit. Unreadable/failed: kept in the blob store, registered `Failed` with a readable message, moved to `error/` with `<name>.reason.txt`, event `instrument.import_failed` notifies analysts. Duplicate sha256: refused, audited (`DuplicateRefused`), moved to `error/`. A capture whose move never happened is finished at the next scan. Acts as the service principal `svc-scheduler`. `INSTRUMENT_AGENT=off`, `INSTRUMENT_POLL_MS` (default 5000).
* Acceptance: `POST /instrument-imports/:id/accept` (Analyst/Admin) writes through `saveResult` (all result rules, calibrated instrument, OCC on both the staged row and the result), records `result_sources`, usage log, and attaches the captured file as the result's raw data (so the review checklist is satisfied). Unit mismatch and cross-sample moves are refused; the file is re-hashed first. `reject` needs a reason.
* A sample with a Pending import naming it cannot move to Pending Review (`unaccepted-imports`, 400 before any signature).
* An overdue / not Active instrument: the file is stored and registered `Failed`, nothing staged; at accept time `saveResult`'s calibration guard refuses.

## Acceptance
| Criterion | Evidence |
|---|---|
| Balance export creates one file row with right sha256 within 15 s; duplicate refused and audited | `instrument-agent` "registers a balance export..." (fs.watch + 1 s poll), "refuses a duplicate"; `instrument-integration` ingestion |
| Fixture CSVs give expected rows; malformed file Failed with readable message | `instrument-parsers` (17); `instrument-integration` malformed; UI test |
| Overdue instrument refused, stale version 409, unaccepted imports block review | `instrument-integration` "overdue", "stale ... 409", guard test |

## Evidence (simulation tree = HEAD + this track + patch, db `lims_r2_instrument_integration`)
* Full `npx vitest run`: 145 files passed, 1743 tests passed, 1 failed = `upgrade-v0.1.0` signature-meaning count 46 to 47, fixed in the patch; re-run of that file and `tests/unit`: 338 passed.
* Mutation checks (each turned tests red): `unaccepted-imports` removed (1 failed); SoD check removed (2 failed).
* `npm run lint`: web clean, server "18 known errors, none new".
* Not run: `tests/security-controls.sh`, `tests/backup-restore.sh`, desktop tests, `npm run build` (no change to desktop/build/startup beyond `server.ts`; the gate should run them). Tests avoid chmod/root assumptions, `localhost`, and text-ORDER BY collation dependence.

## For the gate
Apply the patch (routes, protections, schema index, route-table rules, permissions + matrix, guard, event type `instrument.import_failed`, backup blob register `instrument_files`, `server.ts` agent start, config/.env entries, upgrade test count, new shell extension `src/components/shell/ext/imports.tsx`). The generated files (`tests/route-table.json` +16 routes, `docs/permission-matrix.csv`, `desktop/schema.sql`) were generated against HEAD only: **regenerate them at the gate** after r2-worklists / r2-tat-kpi migrations 0270/0280 merge.

## Decisions needing confirmation
* QA and Admin approve and manage profiles; Analyst/Admin accept, reject and hand in files; everyone reads (`instrument.view`).
* Agent attribution is the service principal; the accountable human is the profile's approver.
* Edit of an Approved profile = new approval (conservative). Instrument files capped at 5 MiB; 5000 rows per file.
* Watch folders may not overlap BLOB_DIR / BACKUP_DIR.
* Out-of-service or overdue instrument: file kept as `Failed`, not staged.
* CDS remains the system of record for raw chromatography; state this in the validation plan (r2-validation).

## Not done
* Values with no sample name, or no matching result, can be accepted only through the API with an explicit `resultId` (screen offers Reject only).
* No serial/RS-232 connector, no XML/Excel parsers, no per-instrument time zone handling.
* Captured files not accepted are carried in backups via the `instrument_files` blob register (patch), but no restore test for them was written.
* No SampleDetail panel for `result-sources` (API exists).
* If the attachment type cannot be detected (extension outside the allow-list) no raw-data attachment is created and the review checklist item `RAW_DATA_ATTACHED` will fail until a file is attached by hand.
