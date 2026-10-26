# Release procedure (roadmap M36)

How a version of B-Pharma LIMS is built, proven and installed under change control. Annex 11 s.10 (change and configuration management),
21 CFR 11.10(a) (validation, ability to discern invalid or altered records). Everything below is implemented in the repository except the
points marked **open**; those need a person or another track (see `docs/changes/r2-release.md`).

## 1. What is released

| Artifact | Made by | Purpose |
|---|---|---|
| `B-Pharma-LIMS-Setup-<version>.exe` | `electron-builder` (`.github/workflows/release.yml`) | NSIS installer; Authenticode-signed when `CSC_LINK` is set |
| `release-manifest.json` | `scripts/make-release-manifest.cjs` | version, git sha, schema version, SHA-256 of every file under `dist/`, `dist-server/`, `desktop/`, `drizzle/`, `scripts/release/` and `package.json`, plus the installer's size and hash; Ed25519 signature when `RELEASE_SIGNING_KEY` is set |
| `sbom.cdx.json` | `scripts/release/make-sbom.cjs` | CycloneDX 1.5 bill of materials from `package-lock.json` (exact versions, sha512) |
| `SHA256SUMS.txt` | the workflow | hashes of the three files above |

The version is the tag: pushing `v0.2.0` makes `scripts/release/set-version.cjs` write `0.2.0` into `package.json` before the build, so the
installer name, the server bundle, the About box and the manifest agree. A packaged copy of the manifest (without the installer entry)
is inside the installed application as `resources/app/release-manifest.json`.

## 2. One-time set-up (owner: QA / validation, with IT)

1. **Signing key.** `node scripts/release/keygen.cjs <folder>` creates `release-signing-key.pem` (private) and `release-public-key.pem`.
   Store the private key as the repository secret `RELEASE_SIGNING_KEY`; commit the public key as `desktop/release-public-key.pem`.
   From the first release built with that file, every start and every update **requires** a valid signature; an unsigned manifest is refused.
   Until then the manifest protects against accidental or casual change (hashes) but not against someone who also rewrites the manifest.
2. **Authenticode.** Set `CSC_LINK` (base64 .pfx or URL) and `CSC_KEY_PASSWORD`. Without a certificate the installer is unsigned and Windows
   SmartScreen warns; the manifest signature is then the only proof of origin.
3. **Waivers.** `node scripts/release/audit-gate.cjs` fails the release on any unwaived high or critical advisory. `scripts/release/audit-waivers.json`
   holds the engineering assessment for the current ones; QA must enter `approvedBy` (a named person) for each, or fix the dependency. The gate does
   not accept a waiver without an approver or past its expiry.

## 3. Making a release

1. Change control approves the content (the R2 change records are in `docs/changes/`). QA confirms the validation evidence is current.
2. Tag: `git tag v0.2.0 && git push origin v0.2.0`. `release.yml` then, on a clean `windows-latest`:
   installer tests, audit gate, `npm run lint` (type check and accessibility lint), build, signed manifest, installer, published manifest + SBOM + checksums,
   **silent install, boot, `/api/ready` within 60 s, uninstall** (`tests/installer/silent-install.ps1`), and only then attaches the files to the GitHub release.
   The job fails if `/api/ready` does not answer 200 in 60 s.
3. Download the three files; compare `SHA256SUMS.txt`.
4. Branch builds (`build.yml`) stay pre-releases "Not a validated release".

## 4. What the installed application does

* **At every start** the shell recomputes the hashes of all covered files and compares them with `release-manifest.json`. Missing, changed or unexpected files, a
  missing manifest, or an invalid signature: the application does not start, shows the files, and appends `SYSTEM_INTEGRITY_FAIL` (with the files) to
  `<userData>\logs\release-events.jsonl`. A good start appends `SERVER_START` (version, git sha, schema version, integrity result). A development tree without a
  manifest may run; a packaged build may not.
* **Help > About** shows version, git revision, schema version and `integrity OK (signed release manifest)`, or says hashes only / not checked.
* **Manual check** for IQ evidence or IT: `node scripts/release/verify.cjs "<install folder>\resources\app"` (exit 0 = OK).
* The shell and the Electron runtime are outside the manifest (the manifest cannot vouch for the code that reads it); their protection is the Authenticode signature of the installer.

## 5. Updating an installed PC (no internet, no automatic download)

Copy the installer and its `release-manifest.json` into one folder (a share, a UNC path, a stick). On the PC: **Application > Install update from file...**, choose the installer.

1. The package is verified: manifest signature, installer size and SHA-256, product, and that the version is newer.
2. The update window shows from/to version, git revision, schema version and hash. An Administrator enters a **change reference**, signs in, and signs (password and, if the account has one, a fresh authenticator code).
3. A **backup is taken through the server and must verify** (`POST /api/admin/backup` answering `verified: true`); otherwise nothing continues.
4. The server records the e-signature and the `SOFTWARE_UPDATED` audit row (**open**: route `POST /api/system/software-update`, contract in `desktop/updater.cjs`; until a server track provides it the update stops at this step with a clear message).
5. The installer is copied to a temporary folder, re-verified there, and started; the application closes. The next start applies migrations with the usual pre-migration backup, then verifies the new manifest.

Every refusal and start is also appended to `release-events.jsonl` (`SOFTWARE_UPDATE_REFUSED`, `SOFTWARE_UPDATE_STARTED`).

## 6. Runtime changes in 0.2.0

Electron 33 -> 43 (Chromium and Node of the shell change; the server bundle still targets Node 20 syntax). **Repeat the IQ** on the installed product: installer, first-run set-up, upgrade from 0.1.0
(`tests/desktop-upgrade.cjs`), shell controls (`tests/desktop-shell.cjs`), the OQ scripts. `npm audit fix` was applied inside the existing version ranges (express, zod, jspdf/dompurify and others).
`xlsx` 0.18.5 has two advisories with no fix on the npm registry (waiver recorded, section 2.3).

## 7. Release notes, 0.2.0

Release R2, "competitive feature depth", on top of R1 (foundation and integrity). Per area, with the full evidence in `docs/changes/<track>.md`:
master data (products, customers, batches, test plans), methods and calculations, QMS (deviations, CAPA, change control), raw data with sealed attachments, API v1 with
service accounts, events and webhooks, tamper-evident audit review, result entry UI, CoA and reports, documents and training, OOS workflow, sample custody and labels,
reagents, stability, environmental monitoring, instrument integration, worklists and TAT / KPI. This release also adds the controlled release pipeline (this document),
the accessibility lint in `npm run lint`, and the Electron upgrade above.
Upgrade from 0.1.0: the installer migrates the database after taking a backup (the backup passphrase is asked for); see `docs/migrations.md`.
