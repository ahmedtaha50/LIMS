# r2-release: controlled release and update pipeline (roadmap M36)

Status: **partial**. Everything that can be built and tested without another track's server code, a signing key or a Windows runner is done; the rest is listed under "Not done".
Procedure for people: `docs/release-procedure.md`.

## What changed

| Area | Files |
|---|---|
| Signed release manifest (hash of every file in `dist/`, `dist-server/`, `desktop/`, `drizzle/`, `scripts/release/`, `package.json`; version, git sha, schema version; installer size and hash; Ed25519 signature) | `scripts/make-release-manifest.cjs`, `scripts/release/manifest-lib.cjs` |
| Start-up integrity check; `SERVER_START` / `SYSTEM_INTEGRITY_FAIL` events; Help > About (version, git sha, schema, "integrity OK") | `desktop/main.cjs` |
| QA-gated offline update: package check, copy-and-recheck, Admin sign-in, change reference, verified backup, server e-signature call, then installer | `desktop/updater.cjs`, `desktop/main.cjs`, `desktop/preload.cjs` |
| SBOM (CycloneDX 1.5, no dependency), audit gate with waivers, version from tag, key generation, manual verify | `scripts/release/make-sbom.cjs`, `audit-gate.cjs`, `audit-waivers.json`, `set-version.cjs`, `keygen.cjs`, `verify.cjs` |
| Release workflow (tag-derived version, signed manifest, SBOM, SHA-pinned actions, silent install on `windows-latest`, 60 s `/api/ready` gate) | `.github/workflows/release.yml`, `tests/installer/silent-install.ps1`, `tests/installer/boot-check.cjs` |
| Electron 33 -> 43.8.3; version 0.2.0; eslint 9 + typescript-eslint + jsx-a11y as devDependencies; `lint:a11y` inside `npm run lint`; `test:installer`, `release:*` scripts; `scripts/release/**` and the manifest in the installer's `files` | `package.json`, `package-lock.json` (consequence of the dependency edits, regenerated with `npm install --package-lock-only` plus `npm audit fix --package-lock-only`) |
| Tests | `tests/installer/integrity.test.cjs`, `updater.test.cjs`, `desktop-integrity.cjs` |

Decisions of design: the update channel is a folder (UNC, LAN, stick), not `electron-updater`: no new runtime dependency, nothing downloads by itself, and an air-gapped PC and a LAN PC use the same path.
The manifest cannot vouch for the shell that reads it; the Authenticode signature of the installer covers that (procedure, section 4).

## How to verify

```
npm run test:installer                     # 15 tests, no database
xvfb-run -a node tests/installer/desktop-integrity.cjs   # real Electron: untouched starts, one changed byte refuses the start
npm run build && npm run release:manifest  # then: node scripts/release/verify.cjs <folder with the manifest>
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<empty db> node tests/installer/boot-check.cjs <staged app folder>
xvfb-run -a node tests/desktop-upgrade.cjs && xvfb-run -a node tests/desktop-shell.cjs   # unchanged tests, now on Electron 43
npm run lint                               # tsc web + server + eslint jsx-a11y
```

Red first: `tests/installer` was run before `manifest-lib.cjs` existed (1 failed file). Mutations: removing the "unexpected file" check fails the tamper test; removing the `verified !== true` backup condition fails the new updater test.

## Acceptance

* "About box shows version, git sha and integrity OK; one changed byte in dist-server/server.cjs blocks start and logs the file": done and executed (`desktop-integrity.cjs`: 5 checks on the real shell; the event log names `dist-server/server.cjs`). The server bundle is the changed file in the test; `dist/**` is covered the same way.
* "Update v0.1.0 -> v0.2.0 via UNC share leaves a verified backup and a SOFTWARE_UPDATED row": **partly**. Package verification, the backup gate and the order of steps are tested against a stub of the server. The `SOFTWARE_UPDATED` row needs the route `POST /api/system/software-update`, which is server code (not in this track's files); until it exists the update stops after the backup with a clear message. A UNC share was not exercised (only local folders).
* "Windows CI job fails if /api/ready does not answer within 60 s": written (`release.yml` + `silent-install.ps1`), **not run**; the same boot check (`boot-check.cjs`, 60 s) was run on Linux against a staged copy of the build (PASS, and FAIL on a tampered file).
* "`npm audit --omit=dev` passes or has a recorded waiver": every dependency is a devDependency, so `--omit=dev` audits nothing. `npm audit fix` removed 7 advisory groups (express/body-parser, proxy-addr, zod, dompurify, brace-expansion, source-map-js, vite). The rest (xlsx, tinypool/vitest 3, electron-builder 25's tar/app-builder-lib) have waivers with the engineering reason and expiry **without an approver**: the gate fails until QA enters `approvedBy`, by design.

## Decisions needing confirmation

1. Signing key and certificate: who creates them and holds `RELEASE_SIGNING_KEY` / `CSC_LINK`. Until `desktop/release-public-key.pem` is committed, the manifest is hash-only; update packages are still required to be signed in a packaged build (so updates are unavailable until the key exists).
2. Waivers (xlsx has no registry fix; electron-builder 26 and vitest 5 are major upgrades) and their expiry (2027-03-31, a proposal).
3. Electron 43 (supported window at the time of writing, Node 24 / newer Chromium): the validated runtime changes, repeat the IQ. The server bundle still targets Node 20 syntax.
4. An update is installed with the interactive installer (not `/S`), so the operator sees it; the Windows CI test uses `/S`.
5. Update window asks for two authenticator codes (sign-in, then signature) because the server refuses a reused code.

## Test evidence (simulation, DB `lims_r2_release`, port 3119)

* `npm run test:installer` 15 passed, 0 failed; `desktop-integrity.cjs` 5 passed; `tests/desktop-upgrade.cjs` 8 passed and `tests/desktop-shell.cjs` 17 passed on Electron 43.8.3 (after `npm run build`).
* `npm run lint`: tsc web and server clean, eslint 0 errors, 67 warnings.
* `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL (production bundle, fresh database, neither script edited).
* Full `npx vitest run` after the dependency changes: 1825 passed, 22 failed in 9 files. All 22 come from the other W6 track's in-flight migration 0300 (`qualified-modules`, `authz-*`, schema drift, `desktop/schema.sql` out of date, permissions 102 vs 100); the one failure this track caused (`tests/unit/shell/repo-hygiene.test.ts`, "exactly one preload") was fixed by creating both bridge windows through one `bridgeWindow()` helper. That test's title and intent ("setup window only") should be updated by its owner to "setup and update window".

## Not done / needs other owners

* `POST /api/system/software-update` and the `SOFTWARE_UPDATED` audit row (e-signature meaning, record version, change reference, from/to version, hash), and importing `release-events.jsonl` (`SERVER_START`, `SYSTEM_INTEGRITY_FAIL`) or the env `LIMS_RELEASE_GIT_SHA` / `LIMS_RELEASE_INTEGRITY` into audit/events on the server side. Neither exists in `src/server`.
* `.gitignore` line `release/` also ignores `scripts/release/`: new files there are untracked-and-ignored (`git add -f`, or the patch below). CI would otherwise build without them.
* Pinning actions in `build.yml`, `tests.yml`, `migrations.yml`; `npm run test:installer` in `tests.yml`; drop build.yml's tag attach step (release.yml publishes tags). All in `gate-patch-r2-release.diff`.
* Windows run of `release.yml` (and whether electron-builder leaves the covered files byte-identical: the silent-install job is exactly that check).
* Not checked: Authenticode, SmartScreen, a real UNC path, macOS.
* The server does not itself refuse to start on a manifest mismatch when run outside the desktop shell (IT runs `scripts/release/verify.cjs`).

## Carried forward from earlier gates (status)

* eslint/jsx-a11y devDependencies and `lint:a11y` in `npm run lint` and CI (build.yml runs `npm run lint`): done; 0 errors, 67 warnings (the foundation files are clean).
* `masterBatchReleaseBlocker` registration: not in this track's files (`src/server/release-blockers/index.ts`).
* Version bump to 0.2.0 and release notes: done (`docs/release-procedure.md`, section 7).
