# Kits

Working files taken from the projects this skill was distilled from (a GxP LIMS: React, Express, PostgreSQL, Electron/NSIS; an
EBR web application: React, Express, PostgreSQL, Docker or a Windows service, Arabic and English).
They are the versions that ran green there, not abstract templates. Each kit mirrors the paths of the target project: copy the
kit's content over the project root, then change the project-specific names listed below, then run the kit's tests in the new
project before trusting it.

```bash
cp -r <skill>/assets/kits/release/. <project>/        # the same for embedded-pg and validation
```
The CI kit is the one exception: its `workflows/` folder goes to `.github/workflows/` (it is stored without the leading dot so
that tools which skip hidden folders do not lose it); its `scripts/` folder goes to `scripts/`.

| Kit | What lands where | Proven by | Change in a new project |
|---|---|---|---|
| `release/` | `scripts/make-release-manifest.cjs`, `scripts/release/*.cjs` (manifest library, `afterPack` hook, verifier, key generator, SBOM, audit gate, version setter), `tests/installer/` (two node:test suites, `gui-smoke.ps1`) | copied into an empty project, its 17 tests passed there (9 + 8); `gui-smoke.ps1` ran green on `windows-latest` in the source project | the `COVERED` folders in `manifest-lib.cjs`; product and log names in `gui-smoke.ps1`; register `"afterPack": "scripts/release/after-pack.cjs"` and keep `"asar": false` in the electron-builder configuration |
| `embedded-pg/` | `desktop/pg-supervisor.cjs`, `desktop/pg-fetch.cjs`, `desktop/pg-bundle.json`, `tests/installer/pg-supervisor.test.cjs` | 12 tests on Linux and on `windows-latest` against the bundled binaries, in the source project | role names (`lims_owner`), the `LIMS_PG_BIN` variable, the secret-variable pattern in `cleanEnv`; pin your own `sha256` in `pg-bundle.json` after downloading and checking the archive |
| `validation/` | `validation/build/` (content sources, `results.cjs`, `check.cjs`, `build.cjs`, `fs.cjs`, `docx_styles.cjs`, `collect-evidence.sh`, `fs-data.sh`), `tests/unit/validation-traceability.test.ts`; needs `npm i -D docx` | generated the source project's package: 112 requirements, gate green, eleven Word documents and the Functional Specification. **Not proven outside that project**: the content is the LIMS content | `content*.cjs` holds the LIMS rows: keep the SHAPE (URS, FRS, VERIF, GRA, DEVIATIONS, OQ), replace every row; brand text in `docx_styles.cjs` (company, system, GAMP category); document texts inside `build.cjs`; file lists in `collect-evidence.sh`. In a new project the gate starts red (every reference is NOT RUN) and turns green only as real evidence arrives: that is the design |
| `validation-roadmap/` | `validation/build/` (`content.cjs` with requirements derived from the roadmap and tests found by their title tag `G05#1`, `results.cjs` reading JUnit, Playwright JUnit, capacity JSON and every `ci-*.txt`, `check.cjs`, `rtm.cjs`, `collect-evidence.sh`), `tests/unit/validation-traceability.test.ts` (Vitest), `ci/workflows/traceability.yml` (merge its job into the project's workflow) | the EBR package: 94 requirements, the gate green locally and in its CI traceability job over the evidence of four jobs; copied into an empty project by `selftest.cjs` (section "kit validation-roadmap"): red as copied, green once filled, red on a failed or untagged test | `SYSTEM`, the rows of `EXTRA`, `PARTIAL`, `FRS`, `GRA`, `DEVIATIONS` in `content.cjs`; `PATH_ROOTS` in `check.cjs`; the commands of `collect-evidence.sh`. Prefer it to `validation/` for a project with a roadmap; take the Word documents from `validation/`'s `build.cjs` and `docx_styles.cjs` |
| `web-i18n/` | `client/i18n/` (`translate.ts`, `index.tsx` provider with direction, `en.ts`, `ar.ts`), `client/screens/example.tsx`, `tests/unit/i18n.test.ts` (Vitest) | the EBR interface in Arabic and English, every screen; the kit itself in a scratch project: 5 tests green, a missing translation and a visible English text both caught | the languages (`Lang`), the dictionaries, the places keys are written (screen titles); delete the example screen once a real one uses `t()`. Screens coverage is a tool, not a kit: `scripts/screen-coverage.cjs` |
| `ci/` | `workflows/build-windows-installer.yml`, `workflows/tests.yml`, `workflows/e2e-traceability.yml`; `scripts/typecheck-server.cjs`, `scripts/check-root-clean.sh` | the source project's workflows as they run today | names, ports, database credentials, the list of checks |

Every kit file keeps its original header comment: it says what the file guarantees and what was NOT run.

`node scripts/skill-lint.cjs` checks that every relative `require` inside a kit resolves inside that kit, so a kit cannot ship
without a file it needs.
