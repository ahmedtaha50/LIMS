# r1-results-oos: result evaluation, OOS auto-open, completeness and release gates, registration hardening (roadmap M10)

Release R1. Branch `claude/project-implementation-tirr4j`. The changes are left uncommitted for the wave gate.
Companion file: `docs/changes/r1-results-oos.gate.patch`. It holds the edits to other tracks' files that this change forces. See "For the gate".

Status: **partial in one respect**. Every acceptance criterion of M10 is met and tested on the real application and PostgreSQL 16. Moving an OOS investigation between phases (`PUT /oos/:id` with `phase`) needs the route-table line in the gate patch, and 12 tests of other tracks need the test edits in the same patch. In the shared tree without the patch, 13 tests fail. With the patch applied, the whole suite passes (see "Evidence").

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, additive) | `drizzle/0050_results_oos.sql`. It adds `results.unit, limit_kind, lower_text, upper_text, decimals, acceptance_text`, `samples.spec_id` (FK, indexed) and `spec_revision`, and `oos_investigations.phase` and `decision`. It also adds the unique index `oos_investigations_one_open_per_result_uidx`: one investigation per result that is not Closed (or v0.1.0's Approved). All new columns are nullable. No row is rewritten. `audit_trail` and `signatures` are not touched. |
| Schema | `src/db/schema/samples.ts`, `src/db/schema/oos.ts` |
| Numbers | `src/lib/numeric.ts` (new). The strict decimal parser rejects `1,234.5`, exponents, `.5`, `5.` and garbage, and reads Arabic-Indic digits and U+066B. It also has decimal-string comparison, half-up rounding (USP General Notices 7.20) and `limitText`. |
| Evaluator | `src/server/lib/evaluate.ts` (new, pure). It handles RANGE, NMT, NLT, TEXT and PRESENCE limits, the declared tokens and v0.1.0 rows (`limitOfResult`). |
| Vocabulary | `src/lib/constants/oos.ts`: status, phases, legal phase moves, decisions, `isTerminalOosStatus`, `oosStage`. `src/lib/constants/results.ts`: entry roles, entry state, censored tokens, TEXT and PRESENCE verdicts, the coded reasons for replacing an OOS value. |
| Result write | `src/server/services/saveResult.ts` (new). It is the only way a result is written. The result-guard registry is `src/server/services/result-guards/index.ts`: the instrument and calibration check moved here and now uses `calibrationState()`. |
| Lifecycle guards | `src/server/workflow/guards/` (new): `index.ts` (registry by target state), `resultsComplete.ts`, `noOpenOos.ts`, `types.ts` |
| Release blockers | `src/server/release-blockers/index.ts` (new): the registry, `findReleaseBlockers`, and `findOosBlockers`, which approval shares |
| Validation | `src/lib/validations/samples.ts` (`bulkImportSchema`, `sampleListQuerySchema`, `SAMPLE_STATES`, `totpCode` on transitions), `results.ts` (`oosId`, `reasonCode`), `oos.ts` (`oosOpenSchema`, `oosUpdateSchema`, `decision` and `totpCode` on closure), `release.ts` (new, `batchReleaseSchema`). All schemas are strict and carry no server-controlled field. |
| Routes | `src/server/routes/samples.ts`, `results.ts`, `oos.ts`, `release.ts`, rewritten (see below). `transitions.ts` is unchanged. |
| Screens | `SampleDetail.tsx`, `Samples.tsx`, `OOSInvestigations.tsx`, `Reports.tsx`, `src/types.ts` |
| Shared check | `tests/security-controls.sh`, minimal edit (see "Deliberate behaviour changes", item 12) |
| Tests | `tests/api/results-evaluate.test.ts` (11), `results-entry.test.ts` (12), `samples-workflow.test.ts` (15), `oos-lifecycle.test.ts` (11), `release-gates.test.ts` (7), `results-ui.test.ts` (4): 60 tests |

Files outside the ownership list touched in the shared tree: `tests/security-controls.sh`. The house rules allow it, because the behaviour change forces the edit. All other forced edits are in the gate patch.

### The routes

| Route | Behaviour |
|---|---|
| `PUT /samples/:id/results/:resultId` | `saveResult` runs in ONE transaction. It locks the sample row. 404 if the sample or result is missing. 403 unless the user is an Analyst or Admin. 423 if the sample is Approved or Rejected, 409 if it is not in Testing. 409 for a stale version. 400 with the parameter name for a value that is not acceptable. Replacing a value that is OOS needs `oosId` (the open investigation of that result) and a `reasonCode`, otherwise 400; the audit reason then reads `[CODE] OOS <id>: <reason>`. Next the result guards run (instrument exists, is Active and is within calibration). The result is written with the version predicate and audited. If the value is OOS and the result has no open investigation, one is opened: id `OOS-<year>-<n>`, status Open, phase Phase I, a Create audit entry on entity `OOS`. The OOS notification is emitted after COMMIT. The response is the result plus `oosInvestigationId`. |
| `POST /samples` | `resolveActiveSpec` runs inside the transaction. 400 if no revision is in force or it has no parameters. The id comes from the per-year counter. The sample stores `spec_id` and `spec_revision`. Each result row gets its parameter's limit: kind, limits as decimal text written to the declared decimals, decimals, unit and acceptance text. `spec_min` and `spec_max` are kept for old readers. |
| `POST /samples/bulk-import` | Strict schema, 1 to 500 rows. The specification is resolved once per material. Any invalid row refuses the whole import with 400 and `details: ["Row n: ..."]`. Ids are reserved in one counter update. Samples and results are inserted in one statement each, with one audit entry per sample, all in the same transaction. |
| `GET /samples` | Newest first. Query: `limit` (1 to 1000, default 200), `cursor`, `state` (now including Logged), `batch`. The body is still a list. The next page's cursor is in the `X-Next-Cursor` header, which is absent on the last page. |
| `GET /samples/:id` | Signer name and role come from the signature's snapshot when it has one. Adds `oos`, the sample's investigations. |
| `POST /samples/:id/transition` | First, before any signature: 404, the version check (409), `validateTransition` (400), four-eyes against the people who entered results (400), and the guards of the target state (400 `TRANSITION_BLOCKED`, naming what is missing). A refused move therefore costs the signer no attempt. `submit` is a plain audited transaction. `review`, `approve` and `reject` go through `signRecord` with `SUBMIT_FOR_REVIEW`, `APPROVAL` or `REJECTION` on entity `Sample`. The sample is locked and every check runs again inside the signing transaction. |
| `POST /oos` | Strict. The parameter comes from the result. The date raised is the server's calendar day; `parameter` and `dateRaised` from older screens are accepted and ignored. 400 if the result does not belong to the sample. 409 if the result already has an open investigation. |
| `PUT /oos/:id` | `rootCause`, `conclusion`, `assignedTo` (must be an active user) and `phase` (forward only, 409 otherwise). One audit entry per changed field, on entity `OOS`. Never the status. |
| `POST /oos/:id/close` | `signRecord` with `OOS_CLOSURE` on entity `OOS`, with the sample id kept. Writes status `Closed`, root cause, conclusion and the optional `decision` (`Confirmed OOS` or `Invalidated`). A closed investigation, or one that v0.1.0 marked Approved, is 423. A wrong password is now counted and audited in its own transaction (top defect 8). |
| `POST /traceability/batch/:batch/release` | Role check, then the state machine (a released batch is 423), then the release blockers, all before the signature. Then `signRecord` with `BATCH_RELEASE` on entity `BatchRelease`, entity id = the batch, and no sample id. That removes the `signatures.sample_id` FK failure of top defect 3. Inside the transaction the batch's samples are locked and the blockers are checked again. The `batch_releases` row is inserted, never upserted. |

### Release blockers and the approval guard

A batch cannot be released while any blocker reports something. `400 RELEASE_BLOCKED` lists every reason.

* `has-samples`: the batch has no samples.
* `all-approved`: a sample is not Approved, named with its state.
* `no-open-oos`: an investigation of a batch sample is not terminal (named with its stage), or an OOS result has no closed investigation.

Approving a sample uses the same OOS rule (`findOosBlockers`) and also needs every result entered. Fail closed: an investigation whose status is not `Closed`, or v0.1.0's `Approved`, blocks under any other name. The demo seed's `Phase II QA Review` therefore blocks. Before this change, release checked only `status = 'Open'`.

## Why (findings)

* M10 evidence and top defects 2, 6, 7 and 19.
* **isOOS.** The UI read `r.isOOS`, so every OOS rendered as PASS and the CoA said ALL TESTS PASSED.
* **Empty samples were approved.** A sample with no results could be approved (`tests/security-controls.sh` did exactly that, with 200).
* **Weak release gate.** Release blocked only on `status = 'Open'`.
* **Unguarded result PUT.** It had no role or state rule.
* **parseFloat evaluation.** `<0.05` and `ND` gave NaN, `1,234.5` gave 1, and there was no rounding.
* **No OOS investigation was ever opened automatically.**
* **Sample ids.** They came from `COUNT(*)+1` and collided under load.
* **Unchecked OOS edits.** `PUT /oos` accepted any status.
* **Rolled-back failure counts.** Failed closure and release signatures were not counted.
* **Old behaviour, executed.** The new test files ran on the untouched code: **40 failed, 6 passed**. `results-evaluate` could not load because `src/lib/numeric` did not exist. The 6 passes are controls that held before: an Administrator may enter a result, the calibration guard, the first id of an empty year, the persisted sample-signature failure, a valid bulk import, and an investigation with status `Open` blocking release. Examples:
  * `PUT` with `97.94` against NLT 98.0 stored `is_oos = false` (no rounding, no NLT).
  * `garbage` was stored with 200.
  * A Reviewer PUT answered 200.
  * A PUT in Pending Review answered 200.
  * `POST /oos` returned 500.
  * Release of a batch with a Pending Review sample, or with an OOS result and no investigation, answered **200**.
  * An empty batch answered 500.

## Deliberate behaviour changes

1. Only an Analyst or Admin enters results (others get 403), and only in Testing (409; 423 once closed). This changes validated behaviour: OQ URS-012 had a Reviewer entering a result. The default permission matrix still grants `result.enter` to all four roles; the handler is stricter (see "Needs from other tracks").
2. The server evaluates every result against the limit copied at registration. A value that is neither a strict number, a declared token nor a verdict is 400.
3. An OOS result opens its investigation in the same transaction. A forced audit failure rolls back both (tested with a trigger).
4. Review needs every result entered. Approval needs, in addition, no open investigation and a closed one for every OOS result. Both answer 400 `TRANSITION_BLOCKED`.
5. The sample, OOS closure and release signatures are made by `signRecord` (hash version 2, catalog meaning, signer snapshot, failure counted and audited in its own transaction). The training refusal on a sample signature is now 403 `TRAINING_REQUIRED` (it was a 400).
6. Batch release refuses an empty batch, any sample not Approved, and any OOS without a terminal investigation. The release signature has no `sample_id`. The `batch_releases` columns `signature_id`, `content_hash` and `audit_entry_id` stay empty for new releases: the signature names the batch. Writing them would take a second write after the signed transaction.
7. OOS vocabulary. New investigations are `Open` with phase `Phase I`, and closure writes `Closed` (v0.1.0 wrote `Approved`, which still reads as terminal). OOS audit entries use entity `OOS` (v0.1.0 used `OosInvestigation` for create and edit). New ids are `OOS-<year>-<n>`.
8. `POST /oos` takes the parameter from the result and the date from the server. A second open investigation for one result is 409.
9. Sample ids come from the `sample:<year>` counter. The counter never falls behind existing ids: it continues after the highest `SMP-<year>-<n>`. That case was found by the shared check: the demo seed writes ids without the counter, and the first registration then collided with HTTP 500.
10. `GET /samples` is paged (default 200 rows; `X-Next-Cursor`). An invalid `state`, `limit` or `cursor` is 400.
11. Reports and screens:
    * The grid and the CoA read `isOos`. Specification text comes from the stored limit. The CoA says `CONTAINS OOS RESULTS`, or `INCOMPLETE` while a result is missing.
    * System listings (audit, OOS register, training matrix, dashboard) are stamped `Uncontrolled Copy`, not `Approved`, and the custom-report selector no longer offers `Approved`. The batch report is `Approved` only when every sample is Approved and every result passed.
    * The audit PDF prints `entityId` and the recorded actor. The OOS register prints `dateRaised` and the stage.
    * The XLSX export is replaced by CSV, which neutralises formula characters; `Reports.tsx` no longer imports `xlsx`.
    * Signature verification shows `SignatureVerdict` (r1-esign), coloured by status, instead of a green banner for any HTTP 200. The ALCOA+ checklist shows only for a valid signature.
    * SampleDetail always asks for the reason and sends the instrument and attachment. When an OOS value is replaced it sends the open investigation and the coded reason. It shows the error of a refused report request and mounts r1-audit's `RecordHistory` for Admin, QA and Reviewer.
    * The OOS screen no longer sends `status`. It edits the phase forward only, asks for the decision, and passes `meaningCode` and the TOTP code to the signature dialog.
12. `tests/security-controls.sh` (minimal edit, no assertion removed):
    * A `fill` helper enters each result in specification before the review steps, because review now needs complete results.
    * `URS-TRN-untrained-user-cannot-sign` expects 403 instead of 400 (item 5).
    * `URS-012-reviewer-enters-result` (expected 200) became `URS-012-reviewer-cannot-enter-result` (expects 403, item 1).
    * The four-eyes check `URS-012-result-enterer-cannot-approve` now uses the Administrator, who may both enter and approve, as the person whose own entry blocks the approval. It still expects 400.
    * The script still has 34 checks.

## How to verify

```
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/results- tests/api/samples- tests/api/oos- tests/api/release-
#   shared tree without the gate patch: 58 pass, 2 fail (oos-lifecycle phase move: route table; results-ui isOOS: routes/reports.ts)
git apply docs/changes/r1-results-oos.gate.patch && npx tsx src/server/boot/migrate-cli.ts export-schema
SQL_... npx vitest run                         # whole suite
npm run lint                                   # web clean; server 21 known baseline errors, none new (2 fewer than the baseline)
# shared checks: npm run build, dist-server/init-db.cjs, delete from users, demo seed, server bundle on 127.0.0.1:3111
BASE=http://127.0.0.1:3111/api tests/security-controls.sh   # 34 PASS, 0 FAIL
BASE=http://127.0.0.1:3111/api tests/backup-restore.sh      # 18 PASS, 0 FAIL
```

| Acceptance (M10) | Evidence |
|---|---|
| 97.96 against NLT 98.0 gives is_oos=false and 97.94 gives true. `<0.05` is accepted where declared; `garbage` and `1,234.5` return 400. | `results-evaluate` (pure) and `results-entry` "evaluation on the server" (HTTP, stored row) |
| An OOS result creates exactly one Open investigation in the same transaction, and a forced audit failure rolls both back. | `results-entry` "OOS opened with the result": one row, audited, notification after commit; a second OOS value and 6 parallel entries still give one; a `BEFORE INSERT` trigger on `audit_trail` that fails for entity OOS leaves the result, the investigation and the result's audit entry all absent |
| Review with a null result returns 400 naming the parameter. Approve with a non-terminal OOS returns 400. Batch release returns 400 for any OOS without a terminal investigation and for a batch with zero samples. | `samples-workflow` "lifecycle gates", `release-gates` (7 cases, including the `Phase II QA Review` status) |
| A Reviewer PUT on a result returns 403, and a PUT in Pending Review returns 409. 20 parallel POST /samples give 20 unique ids, and the first of a new year is SMP-<year>-00001. | `results-entry` "who and when"; `samples-workflow` "sample ids" (20 parallel: twenty 200s, 20 distinct ids; `nextSampleId` for a later year gives 00001, then 00002; the counter continues after existing ids) |
| The SampleDetail grid shows an OOS badge and the CoA text says CONTAINS OOS RESULTS. | `results-ui` (rendered with react-dom/server); the static check that no file in `src/` reads `.isOOS` passes once `routes/reports.ts` gets its one-line fix from the gate patch |

## Evidence

* **Test first.** See "Why": 40 failed and 6 passed on the old code. Each route was then rewritten until its file passed.
* **Gate simulation.** I made a copy of the working tree, applied `r1-results-oos.gate.patch`, regenerated `desktop/schema.sql`, and ran the whole suite: **82 files passed, 2 skipped; 1071 tests passed, 3 skipped, 0 failed**. One run reported an unhandled `57P01` ("terminating connection due to administrator command") from `tests/api/authz-migration.test.ts`. That is the harness teardown race r1-esign also recorded; the first simulation run had none.
* **Shared tree without the patch:** 13 failed, 1058 passed. All 13 are the forced edits listed under "For the gate".
* **Mutation checks** (in the simulation copy; each must turn a test red, and each did):
  * rounding off (3 tests)
  * OOS auto-open off (6)
  * review completeness guard off (1)
  * approval OOS guard off (1)
  * empty-batch blocker off (1)
  * open-investigation blocker off (2)
  * entry role check off (1)
  * entry state check off (1)
  * OOS-overwrite rule off (1)
  * parser accepting thousands separators (2)
* **Shared checks**, on the gate simulation's production bundle (`npm run build`). The database was made fresh by `dist-server/init-db.cjs` (12 migrations including 0050), then the demo seed, then the server on 127.0.0.1:3111. `tests/security-controls.sh`: **34 PASS, 0 FAIL**. `tests/backup-restore.sh`: **18 PASS, 0 FAIL**. The first run of the shared check found the counter collision of item 9: `POST /samples` answered 500, so the check failed. The defect was fixed and a test added, and the rerun passed.
* **Lint.** `npm run lint`: web clean; server "21 known errors, none new". Two baseline entries, in `routes/oos.ts` and `routes/samples.ts`, no longer occur.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short:

* **Evaluation:** rounding, tokens, verdicts and stored values.
* **Result entry:** who and when, and replacing an OOS value.
* **The OOS model:** phases, decision and closure.
* **Approval and release rules.**
* **The sample counter.**
* **Report watermarks and CSV.**
* **Migration 0050's number.**

## Needs from other tracks

| File (owner) | Change |
|---|---|
| `src/server/authz/routeTable.ts` (r1-authz) | **Gate patch**: `bulkImportSchema`, `oosOpenSchema`, `oosUpdateSchema` and `batchReleaseSchema` as `body` (adds `phase` to PUT /oos/:id and `totpCode` to release); `POST /oos/:id/close` guard `to: 'Closed'` |
| `src/server/routes/reports.ts` (no R1 owner) | **Gate patch**: `r.isOOS` to `r.isOos` in `/reports/metrics` (top defect 2) |
| `src/server/routes/traceability.ts` (no R1 owner) | **Gate patch**: find the release signature by entity (`BatchRelease`, batch) when `signature_id` is empty |
| `tests/unit/core/occ.test.ts` (r1-core), `tests/api/esign-verify.test.ts`, `esign-sign.test.ts` (r1-esign), `auth-lifecycle.test.ts` (r1-identity), `eln-integrity.test.ts` (r1-quality-fixes), `tests/upgrade/upgrade-v0.1.0.test.ts` (r1-migrations) | **Gate patch**. Results are entered in Testing before review. The two "legacy" signature tests insert the v1 row as v0.1.0 wrote it, because the routes now write v2. The new 0050 columns are listed with their values for old rows (all null). No assertion is removed or weakened. |
| `desktop/schema.sql` | Regenerate after the last migration of the wave (`npx tsx src/server/boot/migrate-cli.ts export-schema`) |
| `scripts/dev/typecheck/baseline.json` | Shrink: `node scripts/typecheck-server.cjs --update` |
| `src/lib/permissions.ts` + a migration (r1-authz) | Remove `result.enter` from Reviewer and QA in the default matrix, so that the matrix says what the handler enforces (needs QA's decision; validated behaviour URS-012) |
| `src/server/workflow/entityStates.ts` (r1-authz) | Optional: the `oos` machine could list the v0.1.0 phase words the demo seed uses (`Phase II QA Review`), which today are neither editable nor closable through the layer (409). The alternative is a controlled data correction of those rows. |
| Demo seed (r1-build-shell) | OOS-2026-001 should be `status 'Open', phase 'Phase II'`; specifications in the new parameter shape with `decimals`; seeded sample ids are now tolerated by the counter |
| `package.json` (r1-build-shell) | `npm uninstall xlsx`: `Reports.tsx` no longer imports it |
| `src/server/pdfWorker.ts` (r1-backup-jobs) | The server-side CoA should print `results.limit_kind` / `lower_text` / `upper_text` (it prints `null - null` for text limits) and stamp "Official" only for an Approved sample (top defect 15) |
| Validation package | OQ and RTM entries for URS-010 and URS-012 change (result entry roles, completeness and OOS gates, release blockers, auto-opened OOS); raise the deviation that extends DEV-2026-10-13-04 as the roadmap says. Nothing was approved or signed. |

## Not done

* Without the gate patch, a phase cannot be moved (400 `Unrecognized key: "phase"`), and release cannot take a TOTP code. Before the patch, a user with an authenticator therefore cannot release a batch.
* `decision` is optional on closure, so that the closure tests of other tracks keep passing. It should become required once QA confirms the vocabulary.
* No "send back" phase move (Pending QA to Phase II). No screen to open an OOS from a result row (it opens itself when the value is OOS).
* The demo seed's specifications have no declared decimals, so their results are compared without rounding (decision 1) until the specifications are revised.
* The roadmap's "set-based bulk import" covers the inserts. The audit entries are still written one per sample, in order, because they form a hash chain.
* Migration `0050` sorts before `0060` to `0080`, which are already applied on any database built from the W1 to W4 tree. The runner refuses such a database (`OUT_OF_ORDER`), so development and gate databases must be rebuilt from the installer. Fresh installs and v0.1.0 upgrades apply 0050 in order (tested by the suite and by `init-db` above).
* No browser session was run. The screens are type-checked (`lint:web`) and their evaluation pieces are tested with react-dom/server.
