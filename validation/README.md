# B-Pharma LIMS – Computer System Validation (CSV) package

Status: **DRAFT, conditional**. Not approved; not released for GxP use (see VSR §3).

| Folder | Content |
|---|---|
| `docs/*.docx` | VP, URS, GRA, FRS, RTM, IQ, OQ, PQ, DIA, VSR (`node validation/build/build.cjs` regenerates them) |
| `docs/RTM.csv`, `docs/deviations.csv` | Machine-readable traceability (with the executed test ids) and deviation register |
| `evidence/` | Raw execution output the documents are generated from: `oq-run-*.txt` and `backup-run-*.txt` (shell OQ against the built bundle), `junit-*.xml` (the whole Vitest suite against PostgreSQL 16), `e2e-run-*.txt` (browser flows), `desktop-run-*.txt` (Electron shell, upgrade, built-in database and the node:test checks of the installer), `iq-sandbox-*.txt`, `windows-smoke-*.txt` (a copy of the CI job log of the Windows runner, not produced by this package) |
| `build/content.cjs`, `build/content-r2.cjs`, `build/content-r3.cjs` | Single source for requirements, mechanisms, risk scores, deviations and OQ steps (release R1, R2 and R3) |
| `build/results.cjs` | Reads the newest evidence files; a test reference that is not found is `NOT RUN`, never `Pass` |
| `build/check.cjs` | The gate: fails when a Critical/High requirement has no passed test and no open deviation, when a referenced test failed or vanished, or when a mechanism names a file that does not exist |

## How a result gets into the RTM

Nothing is typed in. A requirement lists references in `VERIF` (`tests/api/<file>.test.ts` plus a fragment of the test title, a check id of the shell
OQ, or a browser check of `tests/e2e`); `results.cjs` looks each one up in the executed evidence; `build.cjs` writes the RTM from that. Rename a test and
the RTM turns red until the reference follows. A requirement that no executed test can cover names an OPEN deviation instead (`deviation:` in `VERIF`).

## Re-run

```bash
npm run build
# a freshly seeded server for the shell OQ at BASE (it changes data), then everything else:
BASE=http://127.0.0.1:3000/api SQL_DB_NAME=lims validation/build/collect-evidence.sh
node validation/build/build.cjs      # regenerates validation/docs/*
```

`node tests/e2e/run.cjs --out validation/evidence/e2e-run-<date>.txt` runs the browser flows alone (throwaway database, free loopback port, Chromium; see its header).
`.github/workflows/e2e.yml` does the same in CI with the JUnit file of that run and then `node validation/build/check.cjs`.

Execution was technical, by an AI assistant; a human reviewer must countersign. Requirement IDs were created by this package and need System Owner approval.
Nothing in this folder is an approval or a signature.
