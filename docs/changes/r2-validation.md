# r2-validation: validation automation, the RTM generated from executed tests, and the validated-scope register (roadmap M37)

Release R2, wave W6. Branch `claude/project-implementation-tirr4j`. Changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-validation.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied** (the three M37 acceptance criteria pass in a gate simulation: HEAD `3793d2f` + this track + the gate patch), with the gaps listed under
"Not done": the shell OQ is not retired, the module screens have no read-only badge of their own, and the accessibility gate is a ratchet over 13 screens that fail today, not a clean pass.
In the shared tree without the patch the register's routes have no route-table rule (deny by default), so `tests/api/qualified-modules.test.ts` cannot pass there;
`tests/unit/validation-traceability.test.ts`, `tests/api/qualified-ui.test.ts` and the validation scripts do not need the patch.

## What changed

| Area | Files |
|---|---|
| Validated-scope register (migration 0300) | `drizzle/0300_qualified_modules.sql` (table `qualified_modules`, signature meaning `MODULE_QUALIFICATION` for QA only, permissions `validation.view` and `validation.scope`), `src/db/schema/qualified.ts`, `src/server/qualified.ts` (catalog of 15 modules, `moduleQualificationGuard`, `GET /validation/modules`, `POST /validation/modules/:module/status`) |
| Screen | `src/components/ModuleQualification.tsx`, `src/components/shell/ext/module-qualification.tsx` (a shell extension: one new file, no shared file edited; the label avoids the words "Validated" and "Compliant", which `tests/unit/client/screens.test.ts` and `client-shell.cjs` A4 forbid as static claims; the first version of this screen was called "Validated Scope" and both failed, which is how that was found) |
| Traceability | `validation/build/results.cjs` (reads the executed evidence), `validation/build/check.cjs` (the gate), `validation/build/content-r2.cjs` (URS-060 to URS-119, FRS-100 to FRS-157, OQ-10 to OQ-30, deviations), `content.cjs` and `build.cjs` (RTM, OQ, VSR now generated from the evidence), `collect-evidence.sh`, `README.md`, the regenerated `validation/docs/*` and the new `validation/evidence/*` |
| Browser flows | `tests/e2e/run.cjs` (provisions a throwaway database, installs it with the shipped installer, seeds, starts `dist-server/server.cjs` on a free loopback port, runs the scripts, collects `PASS/FAIL/KNOWN` lines), `lib.cjs`, `login-totp.cjs`, `result-workbench.cjs`, `oos-flow.cjs`, `qms-flow.cjs`, `coa-flow.cjs`, `calibrate-flow.cjs`, `audit-filter.cjs`, `scan-flow.cjs`, `scope-flow.cjs`, `known-failures.json` |
| Accessibility gate | `tests/a11y/axe-gate.cjs`, `tests/a11y/baseline.json` |
| CI | `.github/workflows/e2e.yml` (Vitest with JUnit, build, Playwright and axe installed for the job only, the flows, then `node validation/build/check.cjs`) |
| Tests | `tests/api/qualified-modules.test.ts` (13), `tests/api/qualified-ui.test.ts` (6), `tests/unit/validation-traceability.test.ts` (9) |

## The three acceptance criteria

1. **"Reverting the Login TOTP fix turns the flow test red."** `tests/e2e/login-totp.cjs` L1 to L8. In a copy of the tree the fix in `src/lib/api.ts` (`body?.requiresTotp === true`) was put back to the
   old property name (`requireTotp`), the bundle rebuilt: L1 "a user with an authenticator is asked for the code" turned **FAIL**, and the script exits 1 (`scratchpad/r2val-out/mut-totp-login.txt`).
   Restored: 8 of 8 pass. The older `tests/client-shell.cjs` scenario F also goes red in that state.
2. **"Marking a module NotQualified makes its writes return 403 MODULE_NOT_QUALIFIED. Changing the flag needs a QA e-signature."** `tests/api/qualified-modules.test.ts`: the Analyst has no permission, the Administrator
   is refused by the signature meaning (QA only), a wrong password is 401 and writes nothing; the declaration writes the row, the audit entry (`ScopeDeclaration`, old `Undeclared`, new `NotQualified`) and a signature
   bound to version 1 that `/signatures/verify` accepts; a stale or missing `expectedVersion` is 409; two simultaneous declarations give one 200 and one 409 and one signature; then a `POST /products` is
   403 `MODULE_NOT_QUALIFIED` and an `AUTHZ_DENIED` security event names the module, `PUT /batches/...` is refused, `GET /products` still answers 200, other modules and the core (samples) are untouched, and
   declaring it Qualified (version 2) writes again with a second audit entry and signature. `tests/e2e/scope-flow.cjs` V1 to V10 does the same through the screen.
3. **"The RTM links every Critical/High URS to an executed test id."** `validation/docs/RTM.csv` has, per requirement, the executed test ids it was derived from; `node validation/build/check.cjs` exits 1
   when a Critical or High requirement has no passed test and no OPEN deviation, when a referenced test failed or cannot be found in the evidence, and when a mechanism names a file that does not exist.
   The gate itself is tested with synthetic content (`validation-traceability.test.ts`).

## How the RTM is generated

`content.cjs` / `content-r2.cjs` list, per requirement, references: `T('master-data', 'fragment of the test title')` is a Vitest test of `tests/api/master-data.test.ts`, `U(...)` one of `tests/unit`, `E('scan', 'S1')`
a browser check, `checks: [...]` an id of the shell OQ. `results.cjs` reads the newest `junit-*.xml`, `oq-run-*.txt`, `backup-run-*.txt` and `e2e-run-*.txt` in `validation/evidence/` and looks each reference up; a reference
that is not found is `NOT RUN`. `build.cjs` writes the RTM, the OQ protocols (each step is a test id and its result) and the numbers of the VSR from that. Nothing is typed in. A requirement that no executed
test can cover names an OPEN deviation (`URS-041`: DPAPI on Windows, `DEV-2026-10-25-03`; `URS-119`: accessibility, `DEV-2026-10-25-06`) and shows `NOT MET` or `Not executed (DEV-...)`, never `Pass`.

URS-030 (audit entry in the same transaction) was `P*` (three of about thirty write paths read). It now cites six executed rollback tests (audit chain, signature service, result entry, raw-data versions,
quality-record auto-opening, event outbox); the other write paths are still unverified and stay in DEV-2026-10-13-07.

## Evidence (simulation `scratchpad/r2val-sim`: `git archive HEAD` + this track + the gate patch; databases `lims_r2_validation*`, port 3120)

* **Red first.** The register did not exist, so the red runs are mutations of the new code, each of which must turn a test red (`tests/api/qualified-modules.test.ts`, 13 tests): guard not mounted (2 red: the refusal and the
  "takes effect on the next request" tests), `PUT` left out of the guarded methods (1 red), both version checks removed (1 red), the refusal not recorded (1 red), `master-data` stripped of two of its path prefixes (2 red, including the
  route-table coverage test that forces a decision for every route). Reverting the TOTP fix in `src/lib/api.ts`: `login-totp.cjs` L1 FAIL, then 8 of 8 after the restore.
* **Whole suite** (`npx vitest run --reporter=junit`, JWT_SECRET and LIMS_MASTER_KEY unset, PostgreSQL 16): 155 files passed, 3 skipped (opt-in scale tests); **1862 tests passed, 4 skipped, 0 failed** (`validation/evidence/junit-2026-10-25.xml`).
  The first full run found two real failures of the new screen, both from its label "Validated Scope" (`tests/unit/client/screens.test.ts` and `client-shell.cjs` A4 forbid the words "Validated" and "Compliant" as static claims); it was renamed.
* **Shell OQ against the built bundle** (production mode, fresh database from `dist-server/init-db.cjs`, demo seed): `tests/security-controls.sh` **34 PASS, 0 FAIL**; `tests/backup-restore.sh` **18 PASS, 0 FAIL**. Neither script was edited.
  The package's OQ-01 to OQ-09 rows of the first release now rest on this run (the old run's names were stale: `URS-012-reviewer-enters-result` became `...-cannot-enter-result`, the untrained signer answers 403).
* **Browser flows** (`node tests/e2e/run.cjs`, Chromium, the bundle, throwaway database): **217 PASS, 0 FAIL, 6 KNOWN** in 12 scripts: login-totp 8, result-workbench 11, oos 8, qms 11, coa 11, calibrate 6, audit 8, scope 10, scan 11, a11y 28, plus the older
  client-shell 56 (2 KNOWN) and ui-foundation 49 (4 KNOWN). Development runs found two defects in my own scripts (the close step of the QMS flow raced a toast of an earlier step that was still on screen; the OOS flow compared a boolean with `t`), both fixed; the numbers above are the last complete run, with nothing edited after it except documents.
* **Desktop installer, after `npm run build`:** `xvfb-run -a node tests/desktop-shell.cjs` 17 passed, 0 failed; `tests/desktop-upgrade.cjs` 8 passed, 0 failed (the upgrade runs migration 0300). `tests/desktop-smoke.cjs` cannot get past the
  first-run screen on this tree (it does not supply the first administrator): not used (DEV-2026-10-25-08).
* **RTM** (`validation/docs/RTM.csv`): 86 requirements (74 Critical or High): 83 Pass, 1 Partial (URS-041, DPAPI, DEV-2026-10-25-03), 1 NOT MET (URS-119, accessibility, DEV-2026-10-25-06), 1 not executed (URS-043, offline operation, code reading).
  `node validation/build/check.cjs` exits 0.
* `npm run lint`: web clean; server "18 known error(s) in the baseline, none new"; eslint 0 errors, 67 warnings, none in this track's files.
* **Not run:** `reagents-scale.test.ts` and the other two opt-in scale tests (skipped by design); Windows; the Electron smoke script.
* **Combined W6:** the simulation does not contain r2-release's in-flight edits (`package.json`, `desktop/main.cjs`, ...). The patch applies to the shared tree (`git apply --check`); the three derived files are regenerated at the gate.

## For the gate

`git apply docs/changes/r2-validation.gate.patch` (9 files: `app.ts` mounts `moduleQualificationGuard` after `authorize()`, `routes/index.ts` registers `qualifiedRoutes`, `schema/index.ts` exports `./qualified`, `permissions.ts`
(`validation.view` for everyone, `validation.scope` in the supervisory list), `authz/routeTable.ts` (two rules), the regenerated `tests/route-table.json`, `docs/permission-matrix.csv`, `desktop/schema.sql`, and the
signature-meaning count of `tests/upgrade/upgrade-v0.1.0.test.ts`, 47 to 48). If another W6 patch changes the same context lines, add the list entries by hand and regenerate the three derived files
(`npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` with `JWT_SECRET` of 32+ characters set, `npx tsx scripts/authz/export-matrix.ts`, `npx tsx src/server/boot/migrate-cli.ts export-schema`).
Then run, after `npm run build`, `validation/build/collect-evidence.sh` on a fresh server and `node validation/build/build.cjs`. Delete the patch afterwards.

## Deviations opened by this track (validation/build/content-r2.cjs, deviations.csv)

* **DEV-2026-10-25-01** the browser flows run on Linux/Chromium only; the ELN, the AI assistant and voice input have no flow and no OQ.
* **DEV-2026-10-25-02** the shell OQ was not retired.
* **DEV-2026-10-25-03** URS-041 (secrets in the operating-system store) has no executed test on Windows.
* **DEV-2026-10-25-04** no module is declared Qualified or NotQualified at installation; that is QA's decision with a signature.
* **DEV-2026-10-25-05** background writers (scheduler, job handlers, the instrument folder agent, `/api/v1` tokens) are not stopped by the NotQualified guard.
* **DEV-2026-10-25-06** axe finds serious or critical violations on 13 of 28 screens scanned (the combined R2 tree), 18 rules; `tests/a11y/baseline.json` lists them.
* **DEV-2026-10-25-07** two checks of `tests/client-shell.cjs` (r1-client-shell) are stale on the R2 tree.
  `DEV-2026-10-13-04` (modules without OQ) was reworded: OQ-10 to OQ-30 now exist; it stays open.

## Decisions for the user

1. **Nothing is blocked at installation.** A module with no row is undeclared and behaves as before; only an explicit `NotQualified` refuses writes. The conservative alternative (every module without OQ evidence starts
   NotQualified) would stop most of the application on upgrade. Say which you want; it is a data change (QA declares) or one migration.
2. **Only QA can sign the declaration** (meaning `MODULE_QUALIFICATION` allows the QA role; the Administrator holds the permission but the signature service refuses the role). Reading the register is open to every role.
3. **The catalog** (15 modules and their path prefixes, `src/server/qualified.ts`) and the **core that cannot be switched off** (sign-in, samples, results, workflow, signatures, audit, backup, administration, API clients, events) are my proposal.
   A new route module must be put in the catalog or in the core list of `qualified-modules.test.ts`, which fails until someone decides.
4. **Requirement identifiers, priorities and risk scores** (URS-060 to URS-119, GRA rows) are the author's proposal and need System Owner approval, like URS-001 to URS-050.
5. **Ratchets instead of a red build.** `tests/a11y/baseline.json` and `tests/e2e/known-failures.json` let the browser run finish green while 13 screens have axe findings and two older checks are stale; both can only
   shrink and the evidence prints `KNOWN`, never `PASS`. Delete both files to make the findings fail the build.
6. **The 50 000-sample timing checks of `tests/ui-foundation.cjs`** (P1, P2: under 1 s) run in CI on a slower machine than the simulation; they are the most likely flake. Set `SCALE=0` in the workflow to drop them.

## Not done

* **The shell OQ is not retired** (`tests/security-controls.sh` stays; it is the only OQ evidence that drives the shipped bundle). The OQ ids are not ported to Vitest (DEV-2026-10-25-02).
* **Browser flows:** all eleven named in the design are covered (TOTP sign-in, lock over unsaved input with the typed value kept, register a sample, an OOS result, a signature, closing a quality record, calibrating an instrument, the CoA,
  the audit filter, a scanner burst, keyboard only). Not covered: closing an **OOS investigation** through the screen (the investigation is opened and found in the register; the closure rules are covered by `oos-workflow.test.ts`), the ELN,
  the AI assistant and voice input (DEV-2026-10-25-01). The register and lock flows are the older `client-shell.cjs` (C1 to C10), run by the same harness.
* **No Playwright test runner config** (`playwright.config.ts` is not created): the flows are plain Node scripts on the Playwright library, like `tests/client-shell.cjs`, so there is nothing to configure.
* **A read-only badge on each module's own screen** is not done (it needs an edit in every screen). The register screen shows the status in words; the server refuses the write and the user sees the 403 message.
* **The Windows CI job that closes DEV-2026-10-13-06** belongs to r2-release's pipeline (`build.yml`).
* **Not exercised:** `reagents-scale.test.ts` (opt-in, skipped), so the lot traceback "under 1 s on 100k results" is not claimed in the RTM. Desktop installer on Windows.
* **Nothing was approved or signed.** The package stays a DRAFT; a person must review the evidence and countersign.

## Needs from other tracks

* r2-release (`package.json`): optional `devDependencies` `playwright@1.56.1` and `axe-core@4.10.3` (CI installs them with `--no-save`), scripts `test:e2e` (`node tests/e2e/run.cjs`) and `validation:check` (`node validation/build/check.cjs`).
* Owners of screens with axe findings (list in `tests/a11y/baseline.json`; each removal is forced by the gate): dashboard tiles (`aria-allowed-attr`), OOS investigations and sample detail (`button-name`), environmental monitoring,
  reports and system administration (`select-name`), colour contrast on lab notebook, traceability, audit trail, master data, quality management, administration and sample detail, `definition-list` on methods, `scrollable-region-focusable` on the CoA panel.
* r1-client-shell: update `tests/client-shell.cjs` A5 (wait for the header title after the click) and C11 to C14 (drive the result workbench), then remove the two entries of `tests/e2e/known-failures.json`.
