# r3-spc: SPC, out-of-trend alerts and stability shelf-life trending (roadmap M39)

Release R3, track `r3-spc`. Branch `claude/project-implementation-tirr4j`. Changes are not committed; the wave gate commits them.
Companion file: `docs/changes/r3-spc.gate.patch` holds the wiring in files this track does not own (see "For the gate").

Status: **complete once the gate patch is applied**, except the items under "Not done". The three M39 acceptance criteria pass in a gate
simulation (HEAD + this track + the patch). In the shared tree without the patch the new routes are not mounted and have no route-table
rule (deny by default), so `tests/api/spc-trending.test.ts` cannot pass there; `tests/unit/spc`, `tests/api/spc-migration.test.ts` and
`tests/api/spc-ui.test.ts` pass as they are.

An earlier attempt at this track was cut off before it left any file in the tree; everything here is new.

## What changed

| Area | Files |
|---|---|
| Statistics (pure, shared by server and screen) | `src/lib/spc.ts`: I-MR limits, zones, Nelson and Westgard rules, Cp/Cpk/Pp/Ppk, Student t, OLS, one-sided confidence and prediction bounds, shelf-life |
| Migration (forward-only, reserved 0320 to 0329) | `drizzle/0320_spc.sql`: `spc_baselines`, `spc_alerts`; meaning `SPC_BASELINE_APPROVAL`; permissions `spc.view`, `spc.manage` (positions 320, 321) and grants. Constants only under the runner |
| Schema | `src/db/schema/spc.ts` |
| Engine | `src/server/stats/`: `constants.ts`, `schemas.ts` (strict), `series.ts` (one-join data read), `analysis.ts`, `baselines.ts` (compute, sign, supersede; signable `SpcBaseline`), `alerts.ts`, `stability.ts` (shelf-life per batch and condition) |
| Routes | `src/server/routes/trending.ts` (7 routes under `/trending`), `src/server/routes/stability-trend.ts` (`GET /stability-trend`) |
| Schedule | `src/server/schedules/oot.ts`: `oot.evaluate`, hourly at :20, service principal |
| Screen | `src/components/ControlChart.tsx` (SVG, straight lines, shape + rule id, hollow unapproved marker, deep link per point), `src/components/Trending.tsx` (chart, baseline with exclusions and e-signature, alerts, shelf life) |
| Tests | `tests/unit/spc/spc.test.ts` (32), `tests/api/spc-trending.test.ts` (20), `tests/api/spc-migration.test.ts` (6), `tests/api/spc-ui.test.ts` (6) |

### Behaviour

* **Series** (`GET /trending/series`): one SQL join of results, samples and the product (by its material text); only results of
  **Approved** samples are data; ordered by `entered_at` (not sample creation); the specification limits are those copied onto the result at
  registration (the limits as at entry); stability pulls (`sample_context.origin = 'stability'`) are not process data; a value that is not a
  plain number is counted (`skippedNonNumeric`), not plotted; at most 1000 (max 5000) most recent points. `includeUnapproved=true` adds
  Testing and Pending Review samples as hollow markers, never used for limits, rules, capability or alerts. Rejected is never shown.
* **Limits**: from the Approved baseline when there is one, otherwise computed from the approved points of the request and labelled
  provisional below 20 points. I-MR: CL = mean, MRbar = mean |difference|, UCL/LCL = CL +/- 2.66 MRbar; zone sigma = 2.66 MRbar / 3, so
  "beyond 3 sigma" and "beyond a control limit" are the same test.
* **Rules** (strictly beyond; reported at the point that completes the pattern): Nelson N1 one point beyond 3 sigma; N2 2 of 3 beyond 2
  sigma same side; N3 4 of 5 beyond 1 sigma same side; N4 8 in a row on one side; N5 6 steadily rising or falling. Westgard: 1-3s, 1-2s
  (warning), 2-2s, R-4s, 4-1s, 10x. Zero sigma gives no violations.
* **Capability**: Cpk/Cp (within sigma = MRbar / 1.128) and Ppk/Pp (overall standard deviation) only with n >= 20 and **both** limits; the
  reason is returned when absent. Uses the points judged against the latest specification limits (flagged when the limits changed).
* **Baseline** (`POST /trending/baselines`, `spc.manage`: QA, Admin): the client sends product, parameter, optional window, rule set,
  named and justified exclusions, `expectedRevision`, a reason and the credentials; the **server computes** the limits (a client-sent
  `cl`, `ucl`, `status`, `version`, `revision` is a 400). Needs at least 20 approved results after exclusions. Stored: ids used, exclusions
  with reasons, window, a SHA-256 of `id:value` lines, so the limits are reproducible. e-signature `SPC_BASELINE_APPROVAL` bound to
  the new record version (the signed change names status Approved, so the signature stays verifiable once the revision is superseded). The previous Approved revision becomes Superseded in
  the same transaction, each with its audit entry. Refused before the password is checked: stale `expectedRevision` (409), unknown or
  repeated exclusion (400), fewer than 20 points (409 `TOO_FEW_POINTS`), no variation (409), window above 5000 points. The data is re-read
  in the signing transaction under an advisory lock; if it moved since the signer saw it, 409.
* **OOT alerts**: for each Approved baseline, the approved results entered **after the baseline's data window** are run through its rule
  set; a violation is one `spc_alerts` row (unique per baseline, result and rule) with its audit entry. Run by the scheduler (hourly),
  by QA on demand (`POST /trending/alerts/evaluate`), and `evaluateAlerts(db, { sampleId })` is the call for one sample. Acknowledge:
  `spc.manage`, a note, `expectedVersion`. **Advisory**: no code path writes to results, samples, specifications or releases (asserted by
  comparing the rows before and after).
* **Shelf life** (`GET /stability-trend`): approved results of the samples pulled at the timepoints of each study, x = month point,
  one OLS per study (batch) and condition, **no pooling**. Estimate = first time the one-sided 95 % confidence bound of the mean meets
  the limit (lower bound against LSL, upper against USL; the prediction bound is returned for information). Supported figure =
  min(estimate, cap) rounded **down** to a whole month, cap = min(2 x last observed month, last + 12). Per condition, the shortest
  supported figure over the batches and which batch limits it. Needs at least 4 points at 3 distinct times, else the reason is returned.

### Authorisation (rules in the gate patch)

`GET /trending/*` and `GET /stability-trend`: `spc.view` (every role). `POST /trending/baselines`, `POST /trending/alerts/evaluate`,
`POST /trending/alerts/:id/acknowledge`: `spc.manage` (QA, Admin). Reviewer and Analyst read only.

## Why

M39: the only "SPC" was a smoothed line with USL/LSL from row 0 and no mean, sigma or rules; `/reports/trends` included unapproved and
rejected samples, ordered by sample creation, loaded all results and was O(S x R); there was no baseline, no OOT alert and no shelf-life
estimate. 21 CFR 211.180(e), EU GMP Ch.6: the limits must be reproducible and versioned, and every exclusion explicit and justified.

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/unit/spc tests/api/spc-migration.test.ts tests/api/spc-ui.test.ts   # shared tree, no wiring needed (44)
git apply docs/changes/r3-spc.gate.patch
npx vitest run tests/api/spc-trending.test.ts                                           # needs the patch (20)
```

The statistics fixtures were computed outside the code with exact rational arithmetic (Python `fractions`); the Student t quantiles are
published table values (df 1, 2, 3, 4, 5, 10, 30; p 0.95, 0.975, 0.995), tested to 1e-6. Hand-calculated values: CL 100.01, MRbar
0.503448275862069, UCL 101.3491724137931, LCL 98.6708275862069, Cpk 1.48623; regression of (0,3,6,9,12 months; 100.1, 99.6, 98.7, 98.4,
97.5) slope -0.213333, intercept 100.14, s 0.159164, lower 95 % confidence bound at 18 months 95.7975, shelf life against LSL 95 = 21.177 months
(prediction bound 20.754).

## Decisions needing confirmation (conservative defaults)

* Rule parameters (the classical ones above) and that the baseline's rule set is chosen at signing; Westgard is offered for control or
  reference data series, Nelson is the default for process data.
* Zone sigma = 2.66 MRbar / 3 (so the UCL is the 3-sigma line); Cpk uses MRbar / 1.128; both listed so QA can accept or change them.
* A baseline needs at least 20 approved results; fewer gives no baseline. Cpk needs n >= 20 and both limits.
* The signer of a baseline is the person who requested it (QA or Admin) and there is no second-person approval; add one if the SOP
  requires independent approval of limits.
* Shelf life: 95 % one-sided confidence bound of the mean; at least 4 points at 3 distinct times; no pooling of batches (the shortest
  batch governs); the claim is rounded down; extrapolation cap min(2 x observed, observed + 12) months. These are a statistical aid, not
  the site's shelf-life policy and not a substitute for the ICH Q1E poolability tests, which are not implemented.
* Stability samples are excluded from the process control chart; alerts are advisory and do not open a deviation by themselves.
* Alerts are evaluated hourly and on demand; the "after each approved result" call (`evaluateAlerts(db, { sampleId })`) is ready, but wiring
  it into the review/approval flow is another track's file (see needsFromOtherTracks).

## Not done

* Control materials and Levey-Jennings with their own data model (`qc_materials`): the Westgard rules and fixed-limit support exist in
  `src/lib/spc.ts`, but there is no table or screen for control-sample results (Phase 2 of the roadmap design).
* Poolability (ANCOVA) across batches, non-linear models and the out-of-trend test against a regression prediction interval for
  stability results.
* EM trends (r2-em) are not charted here; they keep their own rule engine and screen.
* The legacy `/reports/trends` endpoint and the `Reports.tsx` chart (owned by other tracks) still exist; the gate patch does not remove them.
* No hook yet from the result-approval flow (other track's files); the scheduler covers it within the hour.
