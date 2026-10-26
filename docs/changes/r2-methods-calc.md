# r2-methods-calc: methods, normalised specification parameters, test plans, calculation engine, system suitability (roadmap M18)

Release R2, wave with r2-master-data, r2-ui-foundation and r2-qms. Branch `claude/project-implementation-tirr4j`. My changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r2-methods-calc.gate.patch` holds the wiring in files this track does not own (see "For the gate").

This track was resumed after an interrupted attempt. That attempt left the migration, the schemas, the engine, the routes, the guards,
the screens, the seeds and five test files, plus an unfinished gate simulation. I reviewed all of it, kept it, and fixed two defects
that I found in the review (test first, below). I rebuilt the gate simulation from scratch, wrote the gate patch, and ran the suite,
the shared checks, the desktop tests, a browser session and the mutation checks.

Status: **complete once the gate patch is applied.** All four M18 acceptance criteria pass in a gate simulation (HEAD + the shared tree
+ r2-ui-foundation's and r2-master-data's patches + this patch). In the shared tree without the patch, the new routes and guards are not
mounted, so `tests/api/methods-calc.test.ts` fails (every route is 404). That is by design, as for the earlier tracks.

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0110_methods_calc.sql`. Tables `methods`, `calc_formulas`, `test_plans` (configuration records: Draft, Effective, Superseded), `spec_parameters` (derived from `specifications.parameters`), `result_inputs` and `sst_runs` (append-only run records). The `spec_parameters` backfill has a row-count guard. Meanings `METHOD_APPROVAL`, `FORMULA_APPROVAL`, `TEST_PLAN_APPROVAL`. Permissions `method.view`, `method.manage`, `method.approve` (positions 62 to 64) and their grants. Catalog rows are written only under the runner |
| Schema | `src/db/schema/methods.ts`, `src/db/schema/calc.ts` |
| Engine | `src/server/lib/calc.ts`: a hand-written precedence-climbing (Pratt-style) parser and evaluator. There is no `eval` and no `Function`, and it has no property access and no strings. Functions come from an allow-list. Errors are `FormulaError`, never NaN. It computes 15 significant digits and rounds once, half-up (`roundHalfUp`, M10) |
| Validation (strict) | `src/lib/validations/methods.ts`: the language allow-list, reserved names, the request schemas, and the specification parameter binding (`method_code`, `formula_code`, `replicates`, `stage`) |
| Routes | `src/server/routes/methods.ts` (and the lifecycle shared by the three record types), `calc.ts`, `test-plans.ts`, `specifications.ts` (taken over from r1-spec: parameters carry their binding) |
| Guards | `src/server/services/result-guards/method.ts` (`method-effective`, `calculated-input`), `result-guards/sst.ts` (`sst-not-failed`, `invalidResults`, `latestRuns`), `src/server/workflow/guards/sst.ts` (`system-suitability`, at review and at approval) |
| Screens | `src/components/Methods.tsx` (methods, calculations and test plans; signed approval), `FormulaEditor.tsx` (inputs, test cases, the allowed functions, "try" through `POST /calc/evaluate`), `Specifications.tsx` (binding fields and their display) |
| Seeds | `scripts/dev/seed/seeds/methods.ts`: 6 formulas and 4 methods, all **Draft** with no author (a seed never signs) |
| Tests | `tests/unit/calc/calc.test.ts` (40), `tests/unit/calc/seeds.test.ts` (8), `tests/api/methods-calc.test.ts` (19), `tests/api/methods-migration.test.ts` (8), `tests/api/methods-ui.test.ts` (5): 80 tests against the real application and PostgreSQL 16 |

### API

| Route | Permission | What it does |
|---|---|---|
| `GET /methods`, `GET /calc/formulas`, `GET /test-plans[?material=]` | `method.view` | Every revision, with the author's and the approver's names |
| `POST /methods`, `/calc/formulas`, `/test-plans` | `method.manage` | Creates revision 1 as a Draft. The code must be unique ignoring case (409). For a formula, the expression is compiled first: a forbidden name or call, `;`, or an input that is used but not declared (or declared but not used) is 400. For a method, every formula its SST criteria name must exist |
| `PUT .../:id` | `method.manage` | Edits a Draft only (423 otherwise). Uses the version predicate (409), and writes one audit entry per changed field |
| `POST .../:id/revise` | `method.manage` | Drafts the next revision as a clone of the Effective one. A code has one Draft at a time (409) |
| `POST .../:id/approve` | `method.approve` | Signs through `signRecord` with the record type's meaning, bound to the new record version. Checked first, and costing the signer no attempt: not a Draft (409); the author or an editor in the audit trail (403 `SOD_VIOLATION`, audited `AUTHZ_DENIED`); stale version (409); for a formula, no test case (400 `FORMULA_UNTESTED`) or a test case that does not reproduce its hand-calculated value on the server (400 `FORMULA_TEST_FAILED`); for a test plan, a parameter missing from the specification in force (400). In one transaction, the Effective revision of the code becomes Superseded (audited) and the Draft becomes Effective |
| `POST /calc/evaluate` | `method.view` | Tries an expression. Nothing is written |
| `GET /calc/samples/:id` | `sample.view` | Each result with its binding, its calculation for the current version, and its validity (Valid, or Invalid with the failed run), plus the SST runs |
| `POST /calc/samples/:id/results/:resultId` | `result.enter` (handler: Analyst or Admin) | Takes `{inputs, reason, expectedVersion, instrumentId?, oosId?, reasonCode?}` and never the value. In ONE transaction: the **Effective** revision of the parameter's formula calculates the value, rounded once to the limit's decimals. The declared replicate count is enforced. A `result_inputs` row keeps the inputs, the formula id, revision and expression, the raw and reported values, and the result version it produced. The value is then saved through `saveResult`, so roles, state, version, guards, OOS evaluation and OOS auto-open behave exactly as for a typed value |
| `POST /calc/samples/:id/sst` | `result.enter` (handler: Analyst or Admin) | One system suitability run of an Effective method, in Testing. Every criterion must be recorded, with its declared injections. The instrument must exist, be Active and calibrated, and be of the method's type. Each criterion is calculated by its Effective formula and judged against its limit. A failed run records the method's entered results (id and version) as invalidated, writes an `Invalidate` audit entry per result, and opens **no** OOS investigation |
| `PUT /specifications/:id` | `spec.edit` | Parameters may carry `method_code`, `formula_code` (numeric limits only), `replicates` (only with a formula) and `stage`. The method and formula must exist. They are stored beside the limit in the signed JSONB, and the trigger mirrors them into `spec_parameters` in the same statement |

### The rules on a sample's results (registered through the gate patch)

* `method-effective` (result guard): a result of a parameter bound to a method is entered only while the method has an Effective
  revision. If the method names an instrument type, the result needs an instrument of that type. "Entry on a Draft method returns 400."
* `calculated-input` (result guard): a parameter bound to a formula is never typed in. `PUT /samples/:id/results/:id` is 400 for it,
  so the value comes only from the calculation route.
* `sst-not-failed` (result guard): no result of a method is entered while the latest SST run of that method for the sample failed.
* `system-suitability` (transition guard, Pending Review and Approved): each bound method whose Effective revision has SST criteria
  needs a recorded run, the latest run must have passed, and no result may still be one that a failed run invalidated. Such a result
  must be entered again after a passing run, which gives it a new version.

The binding of a result is the `spec_parameters` row of the revision that the sample was registered under (`samples.spec_id`, M10),
matched by parameter name. Samples registered before 0050, and unbound parameters, pass every rule as before.

### Migration 0110 on existing data

* For every existing specification, `spec_parameters` is filled the way the application reads the JSONB (`normalizeParameters`):
  * the R1 shape;
  * v0.1.0's `{min, max}`, read as RANGE, NLT, NMT or TEXT with decimals unknown;
  * anything else, read as an empty TEXT.

  Numbers are copied exactly as the JSONB holds them, with no rounding. If the row count differs from the JSONB element count, the
  migration aborts and changes nothing.
* `specifications`, `samples`, `results`, `audit_trail` and `signatures` are not changed. The JSONB stays: specification signatures
  cover it, and it is the rollback copy.
* `spec_parameters` cannot be written directly. A direct write is refused by trigger. The rebuild (from the trigger on
  `specifications`) and the cascade are allowed. An identical row inserted again is skipped, which is what a restore does after it has
  loaded `specifications`.

## Why

M18. Specifications held a JSONB list, there was no method concept, no server code calculated anything (no mean, SD or RSD), and a
result was one typed number. The seeded "Uniformity of Dosage Units (AV)" was a typed value with no calculation behind it. GAMP 5
category 5 configuration needs version control, an approval signature, effective-date control (the Effective revision) and a test case
per formula. All of these are enforced by the server.

`synth.topDefects` in this track's scope (the specification defects 2 and 16) were already fixed by r1-spec. I checked them and left
them unchanged.

### Defects found in the review of the interrupted attempt (fixed test first)

1. **A calculated OOS value could never be corrected.** `saveResult` requires `oosId` and `reasonCode` to replace an OOS value, but the
   strict `calcEntrySchema` refused both keys. A calculated result that went OOS was therefore stuck. On the old code, the new test got
   400 `Unrecognized keys: "oosId", "reasonCode"`. Now the calculated route takes them, like `PUT /samples/:id/results/:id`. The audit
   reason then reads `[CODE] OOS <id>: ...`. The reason now needs at least 5 characters, the same rule as for a typed result.
2. **An SST run did not check its instrument.** An unknown instrument id reached the foreign key, and an out-of-calibration, Out of
   Service or wrong-type instrument was accepted. On the old code, the new test got 200 for a run with no instrument on a method that
   names one. Now the run's instrument must exist, be Active, be within calibration (`calibrationState`, the shared rule) and be of the
   method's instrument type. A method with an instrument type needs one.

## Deliberate behaviour changes (with the gate patch)

1. 19 new routes. 3 new permission codes (64 in all). 3 new signature meanings (17). 4 new `gxp_` triggers (`result_inputs`,
   `sst_runs`), plus the `spec_parameters` guard.
2. `PUT /specifications/:id` accepts the binding keys on each parameter, and refuses a binding to a method or formula that does not exist.
3. A result of a bound parameter is refused while its method is not Effective. A calculated parameter is refused on the typed-entry
   route. Review and approval are blocked by a missing or failed SST, or by an invalidated result.
4. `GET /specifications` returns each parameter's binding when it has one.
5. The demo seed adds Draft methods and formulas (`seedMethods`, registered in `scripts/dev/seed/index.ts` by the patch).

## How to verify

```
# shared tree, no wiring needed (engine, seeds, migration, screens): 61 tests
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/unit/calc tests/api/methods-migration.test.ts tests/api/methods-ui.test.ts

# after the three gate patches (r2-ui-foundation, r2-master-data, this one) and the regeneration below
SQL_... npx vitest run tests/api/methods-calc.test.ts     # 19
SQL_... npx vitest run                                     # whole suite
npm run lint
```

### The hand calculations (oracle)

The expected values of the worked examples (`tests/unit/calc/calc.test.ts`) and of the seeded test cases were computed outside the
engine with this script (Python `decimal`, 50 digits, half-up). It reproduces every value used:

```python
from decimal import Decimal as D, getcontext, ROUND_HALF_UP
getcontext().prec = 50
def mean(x): return sum(x, D(0))/len(x)
def sd(x):
    m = mean(x); return (sum(((v-m)**2 for v in x), D(0))/(len(x)-1)).sqrt()
def rsd(x): return 100*sd(x)/abs(mean(x))
def L(*a): return [D(str(v)) for v in a]
def av(x):
    m = mean(x); M = max(D('98.5'), min(D('101.5'), m)); k = D('2.4') if len(x)==10 else D('2.0')
    return abs(M-m) + k*sd(x)
def r(v, d): return v.quantize(D(1).scaleb(-d), rounding=ROUND_HALF_UP)
ex = {}
ex['sd'] = (sd(L(2,4,4,4,5,5,7,9)),3)
ex['rsd6'] = (rsd(L(1000,1010,990,1005,995,1000)),2)
ex['rsdfail'] = (rsd(L(103,97,103,97,100,100)),1)
ex['rsdpass'] = (rsd(L(100.2,100.4,99.9,100.1,100.3,100.0)),1)
A_spl=L(1523456,1525012); A_std=L(1519870,1521034,1520455,1518999,1522001)
ex['assay'] = ((mean(A_spl)/mean(A_std))*(D('50.12')*D('99.8')/100/50)*(D(500)/D('625.4'))*D('625.0')/500*100,1)
ex['kf'] = (D('1.25')*D('5.02')/D('250.3')*100,2)
ex['diss'] = ((D(487650)/mean(L(493210,492876,494010)))*(D('27.8')*D('99.6')/100/50)*900/500*100,1)
ex['av1'] = (av(L(99.2,100.4,98.7,101.1,99.8,100.9,98.9,100.2,99.5,101.3)),1)
ex['av2'] = (av(L(96.2,97.8,95.9,98.1,97.0,96.6,97.4,98.4,96.1,97.5)),1)
ex['av3'] = (av(L(102.1,103.0,101.8,102.6,103.4,101.9,102.2,102.8,103.1,102.5)),1)
ex['av30'] = (av([D('99.0')+D('0.1')*i for i in range(30)]),1)
ex['dup'] = (abs(D('101.7')-D('99.85'))/D('99.85')*100,2)
ex['spike'] = ((D('15.62')-D('5.48'))/D('10.0')*100,1)
for k,(v,d) in ex.items(): print(k, format(v,'.15g'), r(v,d))
```

I ran it again on 2026-10-19. Output: sd 2.138, rsd6 0.71, rsdfail 2.7, rsdpass 0.2, assay 100.2, kf 2.51, diss 98.5, av1 2.2, av2 3.5,
av3 2.3, av30 1.8, dup 1.85, spike 101.4. Each matches the test and the seed. The remaining examples (precedence, power, logs,
`min`, half-up of 1.005 and -0.125) are exact by inspection.

## Evidence

* **Test first.**
  * The interrupted attempt recorded its run on the untouched code: `methods-calc` failed 16 of 16 (404 `No such API route`, no
    `spec_parameters`), and `calc.test`, `methods-migration` and `methods-ui` could not load (modules missing).
  * The two defects I fixed each have a new test that failed on the code as I found it (see "Why").
* **Acceptance (M18)**, in the gate simulation:
  1. 26 worked examples match the hand-calculated values (raw to 12 significant digits, reported exactly), and the calculation is
     deterministic. `__proto__`, `constructor`, `prototype` and names starting with `__` are refused. So are `;`, property access,
     strings, brackets, assignment and exponents, and calls outside the allow-list (`eval`, `Function`, `require`, `process`,
     `constructor`, `toString`, ...). Evidence: `calc.test.ts`, and over HTTP in `methods-calc.test.ts`.
  2. A formula changed afterwards leaves an existing result unchanged: rev 2 is approved after a result was calculated with rev 1. The
     result is still `99.6` at version 2, and its `result_inputs` row still names rev 1 and `mean(x)`. The next calculation uses rev 2.
     A newer Draft rev 3 is never used.
  3. RSD 2.7 against NMT 2.0: the run fails, the Assay result is Invalid (audited `Invalidate`), review returns 400
     `TRANSITION_BLOCKED` "System suitability ...", no OOS investigation exists and `is_oos` stays false. Entry during the failure is
     refused. A passing run plus re-entry lets review pass. Entry on a Draft method is 400 (typed and calculated), and nothing is written.
  4. `spec_parameters` matches the JSONB on every stored shape (13 rows over 5 odd and real shapes) and on the real v0.1.0 fixture:
     same row count, same values through `normalizeParameters`, and the exact digits (`numeric::text` equals the JSON number). The JSONB
     is byte-identical, and every signature's verification result is the same before and after.
* **Mutation checks** (in the simulation; each must turn a test red, and all 12 did):
  * the SST review guard removed;
  * the method-effective guard removed;
  * the calculated-input guard removed;
  * no rounding;
  * SD with n instead of n-1;
  * `__proto__` allowed;
  * test cases not checked at approval;
  * the newest Draft formula used instead of the Effective one;
  * a failed SST invalidating nothing;
  * the author allowed to approve;
  * the backfill dropping v0.1.0's `min`;
  * the SST instrument not checked.
* **Gate simulation** (`scratchpad/r2mc/sim`): `git archive HEAD`, every modified and untracked file of the shared tree except
  r2-qms's in-flight files, then `r2-ui-foundation.gate.patch`, `r2-master-data.gate.patch` and this patch (all with plain `git apply`,
  in that order), then the three regenerations.
  * `npx vitest run`: 95 files passed, 2 skipped, 1 failed; 1258 tests passed, 3 skipped, 1 failed.
    * The failure is `tests/unit/shell/repo-hygiene.test.ts`, "check-root-clean passes": `STRAY SCRIPT eslint.config.js`. That file
      is r2-ui-foundation's. Once committed, the root-clean script refuses it (see "Needs from other tracks").
    * There were 4 unhandled `57P01` errors during `master-migration` teardown (the harness race recorded by r1-esign, r1-results-oos and
      r2-master-data).
  * `npm run lint`: web clean; server "18 known errors, none new".
* **Shared checks**, on the simulation's production bundle (`npm run build`). The database was made by `dist-server/init-db.cjs`
  (14 migrations, ending at 0110), then `delete from users` and the demo seed, with the server on 127.0.0.1:3102:
  * `tests/security-controls.sh`: 34 PASS, 0 FAIL.
  * `tests/backup-restore.sh`: 18 PASS, 0 FAIL. The restore replays 0110 into an empty database and loads `spec_parameters` after the
    specifications have rebuilt it.
* **API smoke on the bundle:**
  * The seeded formulas and methods are listed as Drafts.
  * The Administrator approved `SST-RSD`, and its two test cases reproduced their values.
  * `POST /calc/evaluate` of the failing injections gave `2.7`.
  * `constructor(1)` was refused.
* **Browser** (Playwright, Chromium, same server):
  * QA opened `#/methods`. The shell shows "Methods & Calculations", and records are shown as "Rev 1".
  * The API-approved formula shows Effective.
  * QA signed `DISS-UNIT` Effective through the signature dialog (success toast).
  * A new formula `mean(x) + y` was refused, with the server message in a toast.
  * The Analyst is not offered "New method".
  * The only console error was the expected 400 of that refused save.
* **Desktop**, after `npm run build` in the simulation: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed;
  `tests/desktop-shell.cjs` 17 passed, 0 failed.
* **Shared tree without the patch:**
  * `tests/unit/calc`, `methods-migration` and `methods-ui` pass.
  * `npm run lint`: web clean. The server check reports one new error, in `src/components/Qms.tsx` (r2-qms, in flight), and none in
    this track's files.

## For the gate

1. Apply `r2-ui-foundation.gate.patch`, then `r2-master-data.gate.patch`, then `git apply docs/changes/r2-methods-calc.gate.patch`, and
   delete the patch files. This patch has those two as context (`batchesRoutes`, the `master.*` permissions, `MASTER_DATA_ROWS`), so
   it must come after them. It changes:
   * `src/server/routes/index.ts`: register `calcRoutes`, `methodsRoutes`, `testPlansRoutes`.
   * `src/server/authz/routeTable.ts`: 19 rules, each with the route's strict schema as `body`.
   * `src/lib/permissions.ts`: `method.view` (everyone), `method.manage` (QA, Reviewer, Admin), `method.approve` (QA, Admin), at
     positions 62 to 64. These match the migration's grants.
   * `src/db/schema/index.ts`: export `./methods` and `./calc`.
   * `src/db/protections.ts` and a new `src/db/protections/methods.ts`: `result_inputs` and `sst_runs` are append-only through the
     registry. The migration installs the same triggers.
   * `src/server/services/result-guards/index.ts`: `methodEffective`, `calculatedInput`, `sstNotFailed`.
   * `src/server/workflow/guards/index.ts`: `sstPassed` for Pending Review and Approved.
   * New `src/components/shell/ext/methods.tsx`: the screen in the shell, under Quality Assurance.
   * `scripts/dev/seed/index.ts`: `seedMethods` after the specifications.
   * `tests/upgrade/upgrade-v0.1.0.test.ts`: 17 meanings, and the `spec_parameters` rows that 0110 derives (one per parameter). No
     assertion is removed.
2. Regenerate the derived files after all patches:
   * `npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (needs `JWT_SECRET`)
   * `npx tsx scripts/authz/export-matrix.ts`
   * `npx tsx src/server/boot/migrate-cli.ts export-schema`
3. Without step 1, these fail in the shared tree, by design:
   * `methods-calc`
   * `upgrade-v0.1.0`, `protections` and `boot` (catalog and trigger counts)
   * `schema-drift`, `desktop-schema`, `authz-matrix` and `authz-migration`
4. Migration number: see the first decision.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short:
* the migration number;
* who drafts and who approves methods and formulas;
* SST semantics;
* rounding;
* the binding by code;
* existence of the method and formula at specification approval, not Effective status;
* the training module recorded but not enforced;
* Draft seeds with no author;
* `method.view` for everyone.

## Not done

* **No bench screen for calculated entry or SST runs.** The API is complete and tested. The result workbench is r2-result-ui's (M19,
  `SampleDetail.tsx` / `ResultGrid.tsx`, which depends on this track). Until it exists, a parameter bound to a formula cannot be entered
  from the screen (the typed entry is refused with a clear message), so laboratories should bind formulas only once that screen ships.
  Invalid results are shown by `GET /calc/samples/:id`, not yet in `SampleDetail`, the CoA or the reports.
* **`required_training_module` is recorded, not enforced.** Checking it at entry needs the training records of r2-docs-training (M28).
* **No effective date on a method or formula.** The Effective revision is the one in force from its approval. A scheduled effective
  date (like specifications have) was not in M18's design.
* **Test plans are not yet used at registration.** They are approved against the specification in force. Selecting the results to
  create from a plan at sample registration belongs to the registration routes (`routes/samples.ts`, `routes/batches.ts`, other owners).
* **The seeded "Uniformity of Dosage Units (AV)" specification parameter** of the R1 demo seed is not bound to `USP905-AV`. The seed of
  specifications is not this track's, and binding it would also require the Draft formula to be approved.
* **Validation package** (`validation/`): no URS, OQ or RTM entries for M18 yet. The formula test cases, this document and the five
  test files are the material. Nothing was approved or signed.
