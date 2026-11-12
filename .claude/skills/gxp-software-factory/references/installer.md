# Phase 4: A desktop installer the user can actually run (Electron + NSIS, built on a Windows runner)

Kits: `assets/kits/release/` (manifest, afterPack hook, verifier, SBOM, audit gate, Windows smoke test), `assets/kits/embedded-pg/`
(built-in PostgreSQL), `assets/kits/ci/build-windows-installer.yml`. Read `assets/kits/README.md` for what to rename.

## Integrity: the installed files must match what was built

- The shell checks every covered file against `release-manifest.json` at each start and refuses to start on a difference.
- **Write the manifest from the packaged folder**, in an `afterPack` hook. The packager rewrites `package.json`, so a manifest
  computed from the source tree never matches and the installed application refuses to start, although every unit test passed.
- Keep `"asar": false` (or hash inside the archive): the check must see the files.
- Unsigned manifest = hashes only (protects against accidental change). Signed (Ed25519, private key only in CI secrets) = also
  against someone who edits the manifest. Never generate or commit a private key on the user's behalf.

## The release gate is the real application on the target OS

`gui-smoke.ps1` installs the built installer silently on the Windows runner, starts the real executable with a throwaway data
folder, and reads the start-up event log: start event = pass, integrity failure = fail. It runs **before** publishing and blocks it.
What it does not prove (say so): the set-up screen, database creation, sign-in.

## Built-in database (PostgreSQL)

- Pin the vendor archive by SHA-256 in `pg-bundle.json`; the fetch script refuses to run unpinned and the build **fails** without the
  bundle. A warning that nobody reads shipped an installer with no database.
- If the vendor publishes no checksum, the pin is trust-on-first-download: write that in the pin file. It guarantees every build uses
  the same bytes, not that the first download was genuine.
- Keep only `bin`, `lib`, `share`; record a hash per executable (`PG_BINARIES.json`); verify them at start and in the smoke test.
- **Windows: `postgres.exe` refuses to run under an account with administrator rights.** Start it through `pg_ctl` (restricted
  token) and watch the PID it writes. Found only because the supervisor tests ran on the Windows runner against the bundled binaries.
- A private cluster: loopback only, password auth on every rule, checksums, UTC, an owner role for migrations and an unprivileged
  role for requests, restart with back-off, a free-disk guard.
- **An error must carry its cause**: "the database stopped" now includes the last lines of the database log.

## Publishing and telling the user

- Branch builds publish a pre-release per run (`v<version>-build.<run>`), labelled "not a validated release". Order by
  `published_at`, not by tag name.
- Give the link only after the run is green and you have read the Windows job. Until then: "do not install the old one".
- An unsigned installer triggers SmartScreen: "More info, then Run anyway". A code-signing certificate is bought by the company
  from a certificate authority after identity checks: a decision for management/IT, not something you can create.
- On a test PC, before reinstalling: uninstall, and delete the application's data folder (only because it holds no real data).

## When the user sends a screenshot of an error from the installed application

1. Do not guess. State the likely cause as a hypothesis and ask for the log files (no passwords).
2. Find the same failure where you can observe it: the informative steps of the Windows job often already show it.
3. Fix it; exercise the new code path locally as far as the OS allows (force the Windows branch on Linux; explain any artefact).
4. Verify on the Windows runner. Read the job.
5. Only then send the link, with the short first-run steps and what is still untested.
