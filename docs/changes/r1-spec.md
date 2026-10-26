# r1-spec: specification lifecycle (roadmap M11)

Release R1, run beside r1-quality-fixes. Branch `claude/project-implementation-tirr4j`. The changes are left uncommitted for the wave gate.
Companion file: `docs/changes/r1-spec.gate.patch`. It holds the edits to other tracks' files that this change forces. See "For the gate".

This track was resumed after an interrupted attempt. That attempt left the migration, the schema, the validation module and five test files. I reviewed them and kept them. I changed one test assertion and added two tests (see "Evidence"). I wrote the route, `src/server/lib/specs.ts`, the screen and the UI test.

Status: **partial** in two respects. Everything else is done and tested.

1. The approve and edit routes need the route-table edit in the gate patch. Without it, the authorisation layer refuses `expectedVersion`, `reason`, `totpCode` and `effectiveDate` as unknown keys. `tests/api/spec-route-table.test.ts` fails until the patch is applied, so the gate cannot forget it.
2. Acceptance criterion 3 asks that "a sample registered under rev 2 keeps spec_revision=2". This track provides `resolveActiveSpec()`, and it makes the revision it returns immutable. Storing `spec_id` and `spec_revision` on the sample happens in registration, which is `routes/samples.ts` and `schema/samples.ts`. Both belong to r1-results-oos (its roadmap summary: "spec binding").

## What changed

| Area | Files |
|---|---|
| Migration (forward-only, additive) | `drizzle/0060_spec.sql`: `specifications.revision_label` (integer, not null, default 1), `created_by` and `approved_by` (FK to users, indexed), and a unique index on (material, revision_label). Existing rows get a revision number per material, ordered by effective date, then by the order of the Create audit entry, then by id. The author comes from the first Create entry and the approver from the latest Approve entry, for Active and Obsolete rows only. The migration only reads audit_trail and signatures. It changes no row in them. |
| Schema | `src/db/schema/specifications.ts` |
| Parameter and request schemas (shared by server and screen) | `src/lib/validations/specifications.ts`. A parameter is `{name, unit, limit_kind (RANGE, NMT, NLT, TEXT, PRESENCE), lower, upper, decimals, text}`. The validation refuses: lower above upper, duplicate names (ignoring case and spacing), an empty name, a numeric limit with no decimals, a limit written with more decimals than declared, and a text limit with no text. It allows at most 100 parameters. The request schemas are strict and carry no server-controlled field: create takes `{material, effectiveDate, reviseFrom?}`, edit takes `{parameters?, effectiveDate?, expectedVersion}`, approve takes `{password, totpCode?, reason?, expectedVersion, exceptionReason?}` and no meaning field. The module also has `normalizeParameters()`, which reads the v0.1.0 `{min, max}` shape, and `toStoredParameters()`, which stores `min`/`max` beside the new fields for registration's current reader. |
| Library | `src/server/lib/specs.ts`: `resolveActiveSpec(ex, material, on?)` returns `{id, material, revision, effectiveDate, parameters}` or null. It also has `todayIso`, `materialKey`, `inForce` and `effectivenessOf`. |
| Routes | `src/server/routes/specifications.ts`, rewritten (below) |
| Screen | `src/components/Specifications.tsx`. It shows "Rev N" and never the counter. It shows the author and approver names and whether the revision is in force. It has a "New revision" action and an editor for the limit kind, limits, decimals, unit, acceptance text and effective date. It signs through `ElectronicSignatureModal` with `meaningCode="SPECIFICATION_APPROVAL"` and sends the TOTP code and reason. It shows an exception field when samples are in progress. Actions follow `GET /permissions/me`, and the author is not offered the approval. It uses `apiFetch`, and every failure shows a toast. |
| Tests | `tests/api/spec-schema.test.ts` (9), `spec-params.test.ts` (18), `spec-lifecycle.test.ts` (50), `spec-resolve.test.ts` (11), `spec-ui.test.ts` (8), `spec-route-table.test.ts` (4, the gate check): 100 tests against the real application and PostgreSQL 16 |

Files outside this track's ownership list touched in the shared tree: **none**. The forced edits are in the gate patch.

### The routes

| Route | Behaviour |
|---|---|
| `GET /specifications` | Every revision, with `revisionLabel`, `version`, author and approver ids and names, and limits in the new shape. `effectiveness` is one of Draft, Scheduled, Effective, Superseded or Unusable (Unusable means an Active row whose effective date is not a date). A Draft also gets `approval: {supersedes, samplesInProgress}`. |
| `POST /specifications` | A Draft with `version` 1, `createdBy` set to req.user, and a Create audit entry in the same transaction. The revision number is the highest for the material plus one. With `reviseFrom`, the source must be an **Active** revision of the same material, and its limits are cloned. A per-material advisory lock serialises creation. 409 codes: `SPEC_REVISE_REQUIRED` (the material already has an Active revision, so revise it), `SPEC_DRAFT_EXISTS` (one open Draft per material), `SPEC_MATERIAL_SPELLING` (the same material with different case or spacing), `SPEC_REVISE_MATERIAL`, `SPEC_REVISE_NOT_ACTIVE`. 404 for an unknown `reviseFrom`. |
| `PUT /specifications/:id` | Changes parameters and/or the effective date of a Draft. A non-Draft is 423. The update is `updateVersioned` (a stale version is 409), with one Update audit entry per changed field in the same transaction. The revision number never moves. |
| `POST /specifications/:id/approve` | Checks run first and cost the signer no attempt: 404; 409 or 423 for an illegal state; 403 `SOD_VIOLATION` when the approver is the recorded `created_by` or appears in the audit trail as creator or editor (audited as `AUTHZ_DENIED`); 409 for a stale version; 400 `SPEC_INCOMPLETE` (no parameters, or stored limits that fail the schema, such as a clone of a v0.1.0 spec without decimals); 400 `SPEC_EFFECTIVE_DATE_PAST`; 409 `SPEC_LATER_REVISION_SCHEDULED`; 409 `SPEC_SAMPLES_IN_PROGRESS`, 403 `SPEC_EXCEPTION_ROLE` and 400 `SPEC_EXCEPTION_NOT_NEEDED`. Then `signRecord` with `SPECIFICATION_APPROVAL` checks QA or Admin from the catalog, training, password, TOTP and the signing lock. In **one transaction** it re-decides under the material lock, makes the superseded revisions Obsolete (each with its StatusChange audit entry), sets `status = 'Active'` and `approved_by` with the version predicate, writes the Approve audit entry, and writes the signature row with `entity_type = 'Specification'` and no `sample_id`. That last point fixes the fresh-install foreign-key failure. The response is the specification plus the signature manifestation. |

**Effective date.** An approval dated today replaces every Active revision of the material dated on or before it. An approval dated in the future replaces nothing yet: the current revision stays in force, and `resolveActiveSpec` picks by date. When such a revision takes effect, the older one stays `status = 'Active'` (shown as Superseded) until the next approval of that material makes it Obsolete. A date in the past is refused. A revision dated before one that is already scheduled is refused, because the scheduled one would otherwise take over from it on its own date.

## Why (findings)

* **M11 evidence and top defects.** One `version` column served as both revision and OCC counter: a v1 edited once and approved showed "v3". There was no author, so there was no author/approver separation. `PUT parameters` was unvalidated. `effectiveDate` was free text and never evaluated. Spec approval wrote its id into `signatures.sample_id`, an FK to samples, so a fresh install could not approve a spec and therefore could not register a sample.
* **Old behaviour, executed** on the HEAD tree in a private copy (probe test, not kept):
  * `POST /specifications {version: 1, ...}` returned 200.
  * `PUT` with min 105 and max 98 returned **200** (version 2).
  * Approval by an Admin who was not the author returned **500 `DATABASE_ERROR`** (the FK).
  * An effective date of `"next tuesday"` was accepted (**200**).
  * Approval by the QA author returned 403 only because of r1-authz's audit-trail rule; the route itself had no author check.

## Deliberate behaviour changes

1. `POST /specifications` no longer takes `version`. Sending it is now a 400, because the revision is assigned by the server.
2. Spec parameters must use the new shape. `{name, min, max}` is a 400. Stored v0.1.0 rows are read through `normalizeParameters` and are never rewritten.
3. Approve needs `expectedVersion`. It may also take `reason`, `totpCode` and `exceptionReason`.
4. A second "new" specification for a material that already has one is a 409: it must be a revision.
5. `GET /specifications` returns the limits in the new shape. Each row gets the added fields.
6. Superseding a revision now bumps its `version` and is audited under the approver (it was neither).

## How to verify

```
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/spec-
#   in the shared tree without the gate patch: 98 pass, 2 fail (spec-route-table: the gate check)
git apply docs/changes/r1-spec.gate.patch    # then all 100 pass
npm run lint                                  # web clean; server "23 known, none new"
```

## Evidence

* **Test first.** The six test files were run on the HEAD code in a private copy: **79 failed, 5 passed, 16 skipped** (spec-resolve could not load: `src/server/lib/specs` did not exist). The 5 passes are controls that pass for other reasons on the old code. One example: "refuses an effective date that is not a real date" passes because the old schema required `version`. On the resumed tree, which already had the new schema and migration but the old route, 48 lifecycle and route tests failed.
* **Changed from the interrupted attempt.** One assertion. `not.toMatch(/password|totpSecret/i)` on the approval body matched the signature's `authMethod: "password"`, so it now checks for credential **keys**. Two tests were added: the scheduled-revision rule, and that the `created_by` refusal is an `AUTHZ_DENIED` security event that cost no signing attempt.
* **Mutation checks** were run in a private copy, 14 mutations, each must turn a test red. These did: author column ignored (1 test); no supersession (5); future date supersedes immediately (3); `resolveActiveSpec` ignores the date (4); no samples-in-progress block (1); past date allowed (1); approver not recorded (3); no material lock (1, the race); revision always 1 (14); raw parameters stored (3); exception by any role (1); empty spec approvable (1); the revision tie-break dropped (1). One mutation survived: dropping the status and version re-check inside the signing transaction. It turned out to be redundant with `updateVersioned`'s version predicate, so it was removed and replaced with a comment.
* **Gate simulation.** This was a copy of the working tree with `r1-spec.gate.patch` applied and `desktop/schema.sql` regenerated. The whole suite, in 78 files: 959 passed, 54 failed, 3 skipped. After the gate patch's test edits were extended to `esign-sign` and `occ`, every remaining failure belongs to r1-quality-fixes' in-flight work. These are `equipment-env`, `equipment-batch-materials`, ELN `meaning`, and `env-records` in `occ`. The trigger count 14 vs 12 in `upgrade/boot` and `upgrade/protections` comes from `0070_quality`. One more failure is the known sample-id race in `audit-session-wiring`. That file passes alone, on HEAD and in the simulation, and its fix (a per-year counter) is r1-results-oos's. The affected set (`esign-sign`, `occ`, `authz-*`, `spec-*`, `audit-session-wiring`) then gave 297 passed and 3 failed, all three r1-quality-fixes' or the race.
* **Shared checks.** Production bundle of the gate simulation, a fresh database from `dist-server/init-db.cjs` (11 migrations including 0060), demo seed, 127.0.0.1:3109, each script run once, in order. `tests/security-controls.sh`: **34 PASS, 0 FAIL**. `tests/backup-restore.sh`: **18 PASS, 0 FAIL**. The restore replays 0060 into an empty database: 0060 seeds no rows, so nothing collides.

## Decisions that need confirmation

See `decisionsForUser` in the report. In short:

* Approval is blocked while samples are Logged or Testing. Only QA, not Admin, can sign the exception. Pending Review samples do not block.
* A past effective date is refused. A revision dated before an already scheduled one is refused.
* A revision overtaken by date stays Active (shown as Superseded) until the next approval obsoletes it.
* Materials are matched ignoring case and spacing, and a second spelling is refused.
* One Draft per material.
* Revision numbers for existing rows come from the migration's ordering rule.
* `decimals` is required for every numeric limit, and the v0.1.0 limits need it declared at their next revision.
* The editors of a Draft are excluded from approving it, which is r1-authz's rule.

## Needs from other tracks

| File (owner) | Change |
|---|---|
| `src/server/authz/routeTable.ts` (r1-authz) | **Gate patch**: the strict schemas `specificationUpdateSchema` and `specificationApproveSchema` as `body` of the PUT and approve rules |
| `tests/api/authz-fuzz.test.ts`, `authz-sod.test.ts`, `authz-states.test.ts` (r1-authz), `tests/api/esign-sign.test.ts` (r1-esign), `tests/unit/core/occ.test.ts` (r1-core) | **Gate patch**: `version: 1` removed from create bodies and `{min, max}` parameters written in the new shape. No assertion is removed or weakened. |
| `desktop/schema.sql` | Regenerate after the last migration of the wave: `npx tsx src/server/boot/migrate-cli.ts export-schema`. `tests/route-table.json` is unchanged, because this track adds no routes. |
| `scripts/typecheck-server.cjs` baseline | One baseline entry no longer occurs. Shrink it with `node scripts/typecheck-server.cjs --update` at the gate. |
| `src/server/routes/samples.ts`, `src/db/schema/samples.ts` (r1-results-oos) | Registration and bulk import must call `resolveActiveSpec(tx, material)` inside the sample's transaction and store `spec_id` and `spec_revision` (a sidecar table or new columns; hash-covered sample columns must not change). They must seed results from `spec.parameters` (limit_kind, lower, upper, decimals, unit). Today they use `findFirst(material, 'Active')`. **This is urgent**: once a future-dated revision is approved, a material has two Active rows, and `findFirst` may pick the wrong one. |
| `src/types.ts` (r1-results-oos) | `Specification` still has the `{min, max}` shape. `Specifications.tsx` no longer uses it, and `SpecView` and `SpecParameter` are the current shapes. |
| `src/server/esign/entities.ts` (r1-esign) | The Specification signature covers material, effective date, parameters and status, but not `revisionLabel`. A future hash version should include it, so a signature names the revision it approved. |
| `src/lib/validations/instruments.ts` (r1-quality-fixes) | That file now exports `isCalendarDate` too. The barrel `validations/index.ts` would have had two exports with that name, so this track's function was renamed `isEffectiveDate`. No action is needed unless the two should be merged into one. |
| Validation package | URS, FRS and OQ entries for revision vs OCC, the author/approver rule, effective-date selection and the exception rule. Nothing was approved or signed. |

## Not done

* The sample binding: registration storing spec id and revision (r1-results-oos, above).
* No route to obsolete a specification on its own (withdrawal without a replacement), and no route to discard a Draft. Neither is in M11.
* No scheduled job to obsolete a revision once its successor takes effect by date. It stays Active and shows as Superseded until the next approval (see Decisions). A job would have no person to attribute the change to.
* Existing installations whose specifications already hold two spellings of one material cannot create a new revision for either spelling until the data is corrected (`SPEC_MATERIAL_SPELLING`). That correction needs a controlled data change. No tool is provided.
