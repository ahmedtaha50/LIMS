# r2-qms: one QMS engine for deviations, CAPA, change control and audit findings (roadmap M27)

Release R2. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-qms.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied.** All three M27 acceptance criteria pass in a gate simulation. In the shared tree without
the patch, the routes are not mounted: `tests/api/qms.test.ts` then answers 404 everywhere (deny by default), as r2-master-data's and
r2-ui-foundation's API tests did before their patches. `qms-migration` and `qms-ui` pass in the shared tree as it is.

This track was resumed after a usage limit. The earlier attempt had written the migration, schema, engine, routes, screen and tests. I reviewed
that work and kept it. I added the fixes listed under "Changed on the resume", rebuilt the gate simulation from the current shared tree, and
re-ran all the evidence.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0180_qms.sql`. Tables `qms_records`, `qms_actions`, `qms_links`, `qms_comments`, `qms_effectiveness_checks`, `qms_settings`. Append-only triggers on links, comments and checks. Under the runner only: 7 signature meanings, 5 permissions (positions 180-184) with their grants, the settings row with change control **off** |
| Schema | `src/db/schema/qms.ts` |
| Engine | `src/server/qms/`: `states.ts` (one lifecycle table per type), `rules.ts` (what a move needs, re-checked inside the transaction), `engine.ts` (every write), `schemas.ts` (strict request schemas and one strict payload schema per type), `entities.ts` (signable record types), `changeControl.ts` (the CHANGE_REQUIRED gate), `autoOpen.ts` (automatic opening in the originating transaction), `index.ts` (what other tracks import) |
| Routes | `src/server/routes/qms.ts` (16 routes, below) |
| Release blocker | `src/server/release-blockers/qms.ts`: `qmsReleaseBlocker` and `findBatchDeviations` |
| Screen | `src/components/Qms.tsx` (records, open actions, settings; signed steps through `ElectronicSignatureModal`) |
| Tests | `tests/api/qms.test.ts` (24), `tests/api/qms-migration.test.ts` (5), `tests/api/qms-ui.test.ts` (5) |

### Lifecycles (`src/server/qms/states.ts`)

| Type (number) | States (final in bold) | Signed steps (meaning) |
|---|---|---|
| Deviation (`DEV-YYYY-NNNN`) | Draft, QA Triage, Investigation, CAPA Proposed, QA Approved, Implementation, Effectiveness Check, **Closed**, **Cancelled** | QA Approved (QMS_APPROVAL), Closed (QMS_CLOSURE), Cancelled (QMS_REJECTION) |
| CAPA (`CAPA-`) | Draft, Approved, Implementation, Effectiveness Check, **Closed**, **Cancelled** | Approved, Closed, Cancelled; the effectiveness check is its own signature (QMS_EFFECTIVENESS) |
| Change control (`CC-`) | Draft, Under Review, Approved, Implemented, **Closed**, **Rejected** | Approved (QMS_APPROVAL, or QMS_EMERGENCY_CHANGE straight from Draft when `payload.emergency`), Closed, Rejected |
| Audit finding (`AF-`) | Draft, Open, Response Submitted, **Closed**, **Cancelled** | Closed, Cancelled |

The rules that apply:

* **Deviation.**
  * Triage (to Investigation) and every step back are steps for the quality unit (`qms.approve`). Investigation needs a classification.
  * A Minor deviation may be approved and closed without a CAPA.
  * A Major or Critical deviation must go through CAPA Proposed, which needs a linked CAPA. It closes only from Effectiveness Check, when
    every linked CAPA that is not cancelled is Closed.
* **CAPA.**
  * Approval needs a plan, effectiveness criteria and at least one action.
  * The CAPA closes only on an effectiveness check that found it Effective and was made on its current version. A check of "Not effective"
    sends it back to Implementation and stays on record.
* **All types.**
  * Content (title, description, classification, payload, and the scope of a change control) is frozen after approval: an edit answers 423.
  * A final record answers 423 to everything.
  * The person who raised or owns a record may not approve it, close it, verify its effectiveness or authorise its emergency change
    (403 SOD_VIOLATION). A rejection is exempt from this rule.

### API (permissions in the gate patch's route table)

| Route | Permission | Notes |
|---|---|---|
| `GET /qms/records[?type&state&open&overdue]`, `GET /qms/records/:id` | `qms.view` | Each record has `overdue`, `editable`, `final` and `nextMoves`. All filters run in SQL |
| `POST /qms/records` | `qms.create` | Strict. The number, state, origin and actor come from the server. The payload is validated by the type's strict schema |
| `PUT /qms/records/:id` | `qms.edit` | Uses the version predicate and writes one audit entry per changed field. Changing the classification needs `qms.approve` |
| `POST /qms/records/:id/transition` | `qms.edit` | An unsigned step. Steps for the quality unit check `qms.approve` |
| `POST /qms/records/:id/sign` | `qms.approve` | Goes through `signRecord`. The meaning comes from the step, never from the client. The signature is bound to the version the step produces |
| `POST /qms/records/:id/effectiveness` | `qms.approve` | Signed (QMS_EFFECTIVENESS) |
| `POST /qms/records/:id/links`, `/comments`, `/actions` | `qms.edit` | Links and comments are append-only. `implemented` and `source` links are written by the server only |
| `GET /qms/actions[?overdue&mine&status]`, `PUT /qms/actions/:id`, `POST /qms/actions/:id/complete`, `/cancel` | `qms.view` / `qms.edit` / `qms.edit` / `qms.approve` | Completing an action is signed (QMS_ACTION_COMPLETION) by its owner or by QA, and names the evidence |
| `GET /qms/settings`, `PUT /qms/settings` | `qms.view` / `qms.settings` | The setting is changed only by a signature (QMS_SETTING_CHANGE, reason required) |

### Change control (`src/server/qms/changeControl.ts`)

When `qms_settings.change_control_required` is on, three changes need a change control in state Approved that `affects` the record:
approving a specification (`Specification` / revision id), approving a role change (`User` / user id), and, for r2-docs-training, making a
document effective (`Document` / id). Without one, the change is refused with **409 CHANGE_REQUIRED**. The owning route calls the gate twice:

1. `assertChangeAuthorised`, before the password is checked, so a refusal costs the signer no attempt.
2. `consumeChange`, inside the change's transaction. It locks the change control and writes an `implemented` link and a
   `ChangeImplemented` audit entry. One approval is therefore used once per affected record, and the change and its authorisation commit
   together.

The emergency path is a change control approved from Draft by one QA signature (QMS_EMERGENCY_CHANGE, reason required). Its signed closure
is the retrospective review (QMS_CLOSURE, reason required).

### Automatic opening (`autoOpenQmsRecord(tx, { source, sourceId, actorId, title })`)

The record is opened inside the transaction of the event that causes it. It starts in QA Triage, unclassified, with `origin = 'auto:<source>'`
and a `source` link. There is one record per (type, source, source id): an advisory lock serialises callers and a partial unique index is the
last line. The sources are `oos-confirmed`, `em-excursion`, `instrument-overdue-use`, `backup-failed` and `audit-chain-broken`. This track
wires `backup-failed` (in the gate patch); the other callers belong to the tracks that own those events (see "Not done").

## Why

M27: there was no deviation, CAPA or change record anywhere. `Traceability.tsx` asserted "Zero Open OOS Investigations or Deviations" (and
"Zero Deviations & Zero OOS") although no deviation could exist. Nothing controlled changes to specifications or roles. ICH Q10, 211.192 and
211.22 apply. None of `synth.topDefects` falls inside this track's files. The invented `compositeScore` named in the gap evidence is in
`routes/dashboard.ts`, which r2-tat-kpi owns. The claim on the traceability screen is fixed through the gate patch.

## Changed on the resume (test first; each new test was run red against the earlier attempt's code)

| Change | Red evidence before the fix |
|---|---|
| Once a record exists, only the quality unit changes its classification (403 `PERMISSION_DENIED`, recorded as `AUTHZ_DENIED`). Before this fix, an Analyst could downgrade a Major deviation to Minor during the investigation and so avoid the CAPA path. The screen disables the field for other roles | `expected 200 to be 403` |
| `GET /qms/records?open=…&overdue=…` filters in SQL. It used to filter in memory after reading the 500 newest rows, so an open record behind 500 newer final ones was not listed | `expected [] to include 'AF-2026-0009'` |
| The batch dossier `GET /traceability/batch/:batch` returns `deviations` (`findBatchDeviations`: linked to the batch, a sample of it or an OOS of one, open and closed, with `blocksRelease`). The traceability screen lists them, counts a release-holding deviation against stage 4, and no longer says "Zero Deviations" while deviations exist | `expected undefined to deeply equal [...]`; source assertion |
| A failed backup run (`runBackup`, not verified) opens a deviation in the same transaction as the failed run | `expected undefined to match object { type: 'Deviation', ... }` |
| Payload editor (`PayloadFields`): CAPA kind and change type are now dropdowns, and the emergency flag is a checkbox. Before this, the emergency path could not be reached from the screen | component did not exist |
| The screen reloads the record before it reports success. This stops a quick second click from signing a stale version (found in the browser run) | browser run: 409 Conflict on the next signature |
| `qms-migration` drift check compares only the `qms_*` tables, so another track's in-flight migration (0110) does not fail it; it still fails when `qms.ts` drops an index (checked) | 150 statements of other tables |

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/api/qms-migration.test.ts tests/api/qms-ui.test.ts        # shared tree, no wiring needed (10)
# after the gate steps below:
npx vitest run tests/api/qms.test.ts                                            # 24
npx vitest run && npm run lint
```

## Evidence (2026-10-19)

The simulations are in the session scratchpad: `r2-qms-sim2`, which has the shared tree with all of r2-methods-calc's in-flight work, and
`r2-qms-sim3`, which has the same tree without r2-methods-calc's files. Each was built from `git archive HEAD` plus every modified and
untracked file of the shared tree. Then `r2-master-data.gate.patch` was applied, then `git apply -C1 --include='src/*' r2-ui-foundation.gate.patch`,
then this track's patch, then the three regenerations. The patch applies to both simulations. The specifications hunk is offset only.

* **Test first.**
  * The earlier attempt recorded its red run as 18 of 18 failing (404, routes not mounted). See `scratchpad/r2qms-red.txt`.
  * On the resume, the 6 new tests were red for the reasons in the table above (`scratchpad/r2qms-red2.txt`).
* **Acceptance (M27)**, all in `tests/api/qms.test.ts`:
  1. A Major deviation cannot close without a linked CAPA and a QA signature. Direct approval gives 409 CAPA_REQUIRED. CAPA Proposed without
     a CAPA gives 409. An Analyst signing gives 403, a wrong password gives 401, and the transition route gives 400. Closing before the CAPA
     is closed gives 409 CAPA_NOT_CLOSED. Closing a CAPA without an effective check gives 409 EFFECTIVENESS_REQUIRED. The closure is signed
     QMS_CLOSURE and the signature verifies.
  2. 8 simultaneous creations get 8 distinct, consecutive numbers. A CAPA action past its due date is `overdue` in the record and in
     `GET /qms/actions?overdue=true` and `?mine=true`. It stops being overdue once Done.
  3. With the setting on, approving a specification without an Approved change control gives 409 CHANGE_REQUIRED, even with a wrong password,
     and costs no signature attempt. A change control still Under Review does not authorise it. One that is Approved does, and records
     `implemented` and `ChangeImplemented`. Role changes behave the same way. Editing, moving, adding an action to, linking or commenting
     on a Closed record gives 423, and the row stays unchanged.
* **Full suite, `r2-qms-sim3`** (no r2-methods-calc): `npx vitest run` gave 93 files passed, 1 failed, 2 skipped, and 1212 tests passed,
  1 failed, 3 skipped. The one failure is `repo-hygiene` (`STRAY SCRIPT eslint.config.js`): the root eslint config added by r2-ui-foundation,
  not this track. There was 1 unhandled vitest RPC timeout under load (`onTaskUpdate`), a harness issue already seen at earlier gates.
* **Full suite, `r2-qms-sim2`** (with r2-methods-calc's in-flight work): 32 failures. All of them are r2-methods-calc's own tests, or
  catalogue, trigger and drift counts caused by its migration 0110 running without its wiring, plus the same `repo-hygiene` failure. None is
  in a QMS test or file.
* **Lint:** `npm run lint` passes in both simulations and in the shared tree. Web is clean. Server has 18 known baseline errors and none new.
* **Mutation checks.** Each mutation must turn a test red, and each one did:
  * classification change allowed to anyone
  * open filter applied after the page
  * backup hook removed
  * deviation never blocking release
  * dossier without deviations
  * `minorOnly` removed
  * `capasClosed` ignored
  * change-control gate off
  * overdue never set
  * signer independence off
  * closed record editable
  * record number from `count(*)+1`
  * effectiveness not required

  One mutation survived: passing `row.version` instead of `expectedVersion` to `updateVersioned`. This is an equivalent mutant, because the
  row is locked and compared with `expectedVersion` just before.
* **Shared checks**, on the production bundle of `r2-qms-sim3` (`npm run build`). The database was made by `dist-server/init-db.cjs`
  (14 migrations, ending at 0180), then `delete from users` and the demo seed, with the server on 127.0.0.1:3103:
  * `tests/security-controls.sh`: 34 PASS, 0 FAIL.
  * `tests/backup-restore.sh`: 18 PASS, 0 FAIL.
* **Desktop** (`r2-qms-sim3`, after `npm run build`): `xvfb-run -a node tests/desktop-shell.cjs` 17 passed, 0 failed;
  `tests/desktop-upgrade.cjs` 8 passed, 0 failed.
* **Browser** (Playwright with Chromium, same server, `scratchpad/r2qms-browser2.cjs`): 10 PASS.
  * Navigation entry.
  * An Analyst raises a deviation (success toast) and moves it to QA Triage. The triage step is hidden from the Analyst.
  * A link to a sample that does not exist shows the server's message.
  * QA classifies it and moves it to Investigation.
  * The signature dialog shows the catalog meaning. A rule refusal ("has no root cause recorded") is shown in the dialog.
  * After the root cause is recorded, the approval is signed.
  * A change control offers the change type and the emergency checkbox.

  The only console errors were the 400 of the deliberately refused link.

## For the gate

1. Apply `docs/changes/r2-master-data.gate.patch`, then `git apply -C1 --include='src/*' docs/changes/r2-ui-foundation.gate.patch`
   (as those tracks describe), then `git apply docs/changes/r2-qms.gate.patch`. Delete the patches afterwards. The patch has the other two as
   context: the master-data permission codes, protections, route rules and upgrade-test lines. It changes:
   * `src/server/routes/index.ts`: register `qmsRoutes`.
   * `src/server/authz/routeTable.ts`: 16 rules, each with its strict body schema.
   * `src/lib/permissions.ts`: `qms.view`, `qms.create` and `qms.edit` go to everyone; `qms.approve` and `qms.settings` go to QA (and Admin).
   * `src/db/schema/index.ts`: `export * from './qms'`.
   * `src/db/protections.ts` plus a new `src/db/protections/qms.ts`: append-only triggers on links, comments and checks through the
     registry, the same triggers the migration installs.
   * `src/server/release-blockers/index.ts`: add `qmsReleaseBlocker`.
   * `src/server/routes/specifications.ts` (r2-methods-calc): `assertChangeAuthorised` before the signature and `consumeChange` inside it.
   * `src/server/authz/roleChange.ts` (r1-authz): the same two calls for role approval.
   * `src/server/routes/traceability.ts` and `src/components/Traceability.tsx` (r2-master-data): `deviations` in the dossier and on the
     screen.
   * `src/server/jobs/backupService.ts` (r1-backup-jobs): the `backup-failed` auto-open.
   * `src/components/shell/ext/qms.tsx` (new, r2-ui-foundation's registry): the screen at `#/qms/<id>`.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: 21 meanings, one `qms_settings` row, and the row's `updated_at` stripped in the rollback
     comparison. No assertion about kept data was removed.
2. Regenerate the derived files once, after all the patches:
   * `NODE_ENV=test JWT_SECRET=<any> npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json`
   * `npx tsx scripts/authz/export-matrix.ts` (66 permissions with master-data's)
   * `npx tsx src/server/boot/migrate-cli.ts export-schema`
3. If r2-methods-calc's own patch changes the context of `specifications.ts`, its two `qms` lines go in by hand:
   * `await assertChangeAuthorised(db, { type: 'Specification', id })` right after `decide(db, spec)`.
   * `await consumeChange(tx, user.id, { type: 'Specification', id }, ...)` right after the `updateVersioned` to Active.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short:

* the migration number;
* change control off at installation;
* who may raise, work, approve and configure;
* signer independence;
* classification reserved to QA after creation;
* what blocks a release;
* Minor deviations closing without a CAPA;
* the emergency path;
* one use of an approval per affected record;
* one deviation per failed backup run;
* numbering and dates;
* the meaning texts.

## Not done

* **Automatic opening for confirmed OOS, EM excursion, instrument overdue use and a broken audit chain.** The engine and its test are ready
  (`autoOpenQmsRecord`). The calls belong in files owned by r2-oos-workflow (`routes/oos.ts`), r2-em (`routes/env.ts`), the owner of the
  calibration result guard, and r2-audit-tamper. They are listed under needs from other tracks.
* **Document-effective gate.** r2-docs-training calls `assertChangeAuthorised` and `consumeChange` with `{ type: 'Document', id }`.
* **No notifications or escalation for overdue actions.** Overdue is derived when the record is read. The inbox (`routes/inbox.ts`) does not
  list QMS actions yet, and r2-events has no QMS events.
* **Lists.** The record list is the newest 500 matches, not the DataGrid list contract (cursor paging, export).
* **No validation-package entries** (URS, OQ, RTM) were written. Nothing was approved or signed.
* **Migration number.** The task text names 0130-0139, but the roadmap reserves 0130 for r2-instrument-integration (`drizzle/013*`) and 0180
  for this track (`drizzle/018*` is this track's `ownsFiles`). The earlier attempt used `0180_qms.sql`, and I kept it to avoid a collision.
