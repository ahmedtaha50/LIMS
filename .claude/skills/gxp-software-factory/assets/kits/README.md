# Kits

Working files taken from the project this skill was distilled from (a GxP LIMS: React, Express, PostgreSQL, Electron/NSIS).
They are the versions that ran green there, not abstract templates: copy them to the paths below, then change the
project-specific names listed for each kit. Run the kit's tests in the new project before trusting it.

| Kit | Copy to | Proven by | Change in a new project |
|---|---|---|---|
| `validation/` | `validation/build/` (+ `npm i -D docx`) | generated the LIMS package: 112 requirements, gate green, 10 Word documents and the FS | `content*.cjs` is the LIMS content: keep the SHAPE (URS, FRS, VERIF, GRA, DEVIATIONS, OQ), replace every row; brand text in `docx_styles.cjs` (company, system, GAMP category); document texts inside `build.cjs`; file lists in `collect-evidence.sh` |
| `release/` | `*.cjs` to `scripts/release/` (`make-release-manifest.cjs` to `scripts/`), tests and `gui-smoke.ps1` to `tests/installer/` | 9 + 8 node:test tests; `gui-smoke.ps1` ran green on `windows-latest` | `COVERED` folders in `manifest-lib.cjs`; product and log names in `gui-smoke.ps1`; register `"afterPack"` and keep `"asar": false` in the electron-builder config |
| `embedded-pg/` | `desktop/`, test to `tests/installer/` | 12 tests on Linux and on `windows-latest` with the bundled binaries | role names (`lims_owner`), the `LIMS_PG_BIN` variable, the secret-variable pattern in `cleanEnv`; pin your own `sha256` in `pg-bundle.json` after downloading and checking the archive |
| `ci/` | `.github/workflows/`, scripts to `scripts/` | the LIMS workflows as they run today | names, ports, database credentials, the list of checks |

Every kit file keeps its original header comment: it says what the file guarantees and what was NOT run.
