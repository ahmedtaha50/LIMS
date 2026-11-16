# r3-validation: the validation package (E20)

Built on the kit of the gxp-software-factory skill (`assets/kits/validation`), fitted to the EBR:

- `validation/build/content.cjs`: the one content source. The URS rows are NOT retyped: each is an acceptance criterion of
  `docs/roadmap/roadmap.json` (63 rows, URS-E01-1 to URS-E21-4), priority from the gap's GxP risk (46 High). References are
  found, not typed: a test whose title carries the criterion id (`E05#1`) is a reference; `EXTRA` adds four for tests whose
  title does not carry it. FRS mechanisms (21), risk scores (10 areas) and 6 deviations are the author's proposal for QA.
- `validation/build/results.cjs`: reads the newest Vitest JUnit, Playwright JUnit (tablet and desktop) and capacity result in
  `validation/evidence/`; a reference not found is NOT RUN, never Pass.
- `validation/build/check.cjs`: the gate (E20#2). It fails when a High requirement has no passed test and no open deviation,
  any reference failed or vanished, P* or GAP lacks an open deviation, a requirement has no mechanism or risk score, or a
  mechanism names a path that does not exist.
- `validation/build/build.cjs`: VP, URS, GRA, FRS, RTM, IQ, OQ, VSR (Word) plus RTM.csv and deviations.csv, generated.
- `validation/build/collect-evidence.sh`: build, the whole suite, the browser tests, the capacity test, a sandbox IQ record.
- `tests/unit/validation-traceability.test.ts`: 11 tests (E20#1, E20#2), the gate on synthetic content, RTM results that follow
  the evidence given, URS one-for-one with the roadmap, no result written in the content source.

Planted faults, each caught by the gate: a referenced test marked failed in the evidence (`URS-E04-3 ... is Fail`), the same
test renamed (`... is NOT RUN (not found in the evidence)`), the capacity result removed (`URS-E16-1/2 ... NOT RUN`).

Result: 63 requirements, 57 P, 5 P*, 1 GAP (the Windows service, not run). Not done here: the Functional Specification
generator of the kit (`fs.cjs`), PQ and the data integrity assessment documents; IQ and PQ on the plant (deviation).
