# Phase 5: Validation as code, a package that cannot claim more than was executed

Kit: `assets/kits/validation/`. If the `gxp-validation-package` skill is available, use it for the document conventions and its
honest-execution rules; this kit is the engine underneath. Nothing here is an approval or a signature.

## The model

- **One content source** (`content*.cjs`): `URS` [id, text, priority, area], `FRS` [id, mechanism, [urs]], `VERIF` {urs: {type, ref,
  tests, checks, file, deviation, note}}, `GRA` [area, S, L, D, rationale, [urs]], `DEVIATIONS` [id, description, action, status],
  OQ protocol list. A new release adds a `content-rN.cjs`; it does not edit old rows.
- **No result is typed.** A verification lists references (a test file plus a fragment of its title, a check id of a shell script,
  a browser check). `results.cjs` looks each one up in the evidence of an executed run. Not found = `NOT RUN`, never `Pass`:
  rename a test and the RTM turns red until the reference follows.
- **Types**: `P` an executed test passed; `P*` part is supported by reading or by evidence from another machine, with an OPEN
  deviation; `GAP` not met, with an OPEN deviation.
- **The gate** (`check.cjs`, also a CI step): fails when a Critical/High requirement has no passed test and no open deviation, when
  any referenced test failed or vanished, when a mechanism names a file that does not exist, when a deviation is missing or closed.
- **Documents are generated** (`build.cjs`: VP, URS, GRA, FRS, RTM, IQ, OQ, PQ, DIA, VSR, RTM.csv, deviations.csv) and so is the
  Functional Specification (`fs.cjs`, from the requirements, the permission matrix, the route table, the signature catalogue, record
  states, scheduled jobs and the table list). Generated documents cannot drift from the code.

## Evidence

`collect-evidence.sh` writes dated files: JUnit of the whole suite on the real database; `PASS|FAIL <id>` lines of the shell checks
against the built bundle; browser flows; desktop and installer checks; a sandbox IQ record with file hashes and the git commit.
- Re-run fresh before generating; never backfill from memory.
- Scripts that change data need a fresh, seeded database each time (a second run on the same data fails on lockouts and rate limits).
- Never edit a script while it is running (the shell reads it as it goes).
- Evidence from another machine (the CI log of the Windows runner) is copied with a header saying where it came from and that the
  package did not produce it; the requirement stays `P*` under a deviation.
- When the source changes after evidence was collected, regenerate both in the same change, or say the documents are stale.

## Honest wording that must be in the package

- Draft banner; requirement ids were created by the package and need System Owner approval.
- "Executed by: <AI assistant>, technical execution"; reviewer fields blank.
- IQ in a sandbox does not qualify the target PC; end-user PQ not performed, if so.
- Deviations `DEV-YYYY-MM-DD-NN`, OPEN or CLOSED with the evidence that closed them. Fix the cause rather than re-listing known debt
  (a contrast failure was fixed in the component, not re-added to the baseline). A VSR conclusion stays CONDITIONAL while any is open.
- Never invent approvals, signatures, regulatory citations or retention numbers.

## Order of work for a new release

1. Add requirements and mechanisms from what was built (the change records and the tests). 2. Point each at real tests.
3. Collect evidence. 4. `node validation/build/check.cjs` until it is green for honest reasons (a missing test becomes a test or an
open deviation, never a removed requirement). 5. Generate. 6. Convert one document to PDF and look at a page. 7. Commit sources,
evidence and documents together.
