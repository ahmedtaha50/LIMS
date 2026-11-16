# r4-windows: Windows service installation proven on Windows Server (E24)

- `deploy/windows/install-service.ps1`: checks the SHA-256 of `winsw.exe` (WinSW-x64 2.12.0, recorded value) before using it,
  and waits up to two minutes for the health answer of the first start (it migrates).
- `deploy/windows/uninstall-service.ps1`: stops and removes the service; the database is not touched.
- `deploy/windows/ci-check.ps1`: E24 end to end, `PASS <id>` per check: installed and running (Automatic) with migrations
  applied; the first administrator created with the installation command and signing in (must change the password); stop
  and start keep the migrations, the account and the audit entries; uninstall removes the service and the database keeps
  its records.

Gate needs: a `windows` job in `.github/workflows/ebr.yml` on `windows-latest` (a Windows Server image): PostgreSQL 16 from
Chocolatey on port 5433, `npm ci`, build, WinSW downloaded, `ci-check.ps1`.

NOT run here: there is no PowerShell or Windows on this machine. The first run of these scripts is the CI job; until it is
read, E24 is not verified. The database URL, with its password, is written into the service's WinSW XML next to the script
(as before): that folder needs the same access control as the server's other secrets.
