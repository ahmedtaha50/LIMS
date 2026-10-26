# Installer start-up failure: "The installed files do not match the release manifest"

Seen on the first installed build (v0.2.0-build.1): the application refused to start and wrote SYSTEM_INTEGRITY_FAIL for `release-manifest.json`.

## Causes (two, found by packaging the application for real with `electron-builder --linux dir` and running `verifyInstall` on the result)

1. `build.yml` (the workflow that publishes the branch installer) never created `release-manifest.json`; only `release.yml` did. A packaged build requires a manifest, so it stopped at start.
2. Even with a manifest staged before packaging, electron-builder writes its own smaller `package.json` into the package, so the staged hash of `package.json` never matched (`package.json: changed`).

The R2 gate tested the manifest logic on hand-made trees and the real Electron shell on the source tree, but never on a really packaged folder.

## Fix

`scripts/release/after-pack.cjs`, registered as `build.afterPack` in `package.json`, writes `release-manifest.json` from the files that were packaged (signed when `RELEASE_SIGNING_KEY` is set, otherwise hashes only). It replaces any manifest staged earlier. Verification and tamper detection are unchanged: a changed, missing or extra file still stops the application.

## Evidence

- `tests/installer/after-pack.test.cjs` (9 tests): reproduces both causes, then the hook; changed/missing/extra files still detected; signing; macOS layout; loud failure when the app folder is missing. It failed before the hook existed.
- Real packaging: `electron-builder --linux dir` then `verifyInstall` on `resources/app`: ok, 0 errors, 158 files.
- `npm run test:installer`: 36 passed.

## Not covered

The Windows installer itself (NSIS, install location, Defender) was not run here; the manifest is computed from the same packaged folder layout (`resources/app`) on Windows. Check on the next installed build that the application starts and `release-events.jsonl` shows `SERVER_START` instead of `SYSTEM_INTEGRITY_FAIL`.
