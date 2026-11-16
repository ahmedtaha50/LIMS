# r3-deploy: on-premises delivery (E19)

- `Dockerfile` (two stages; runs as an unprivileged user; health check) and `deploy/compose/docker-compose.yml` with
  `.env.example`: the application and PostgreSQL 16 on one server; migrations at start.
- First administrator of a new installation from `EBR_BOOTSTRAP_ADMIN_USER` / `_PASSWORD`, only while the database has no
  account (advisory lock: two instances starting together create one); it must change the password at the first sign-in.
  Checked here: two instances started at once on an empty database created exactly one administrator. A password that
  breaks the policy stops the start with the reason (seen: "must not contain the user name").
- `deploy/backup/backup.sh` (custom-format dump with its SHA-256) and `restore.sh` (refuses a file that does not match its
  SHA-256; restores into an empty database; verifies the audit chain of the restored data with the built application).
- `deploy/windows/install-service.ps1`: the same build as a Windows service through WinSW.

Gate needs: `server/main.ts` (r1-core) and `server/identity/index.ts` (`bootstrapAdmin`, r1-identity); a CI job that runs
`docker compose up --build` and signs the bootstrap administrator in.

Evidence here: `tests/deploy/backup.test.ts` 4 passed (dump, restore, chain ok with 25 entries, protections back after the
restore, a changed file refused).

NOT verified: `docker compose up` (no Docker daemon on this machine: the CI job is the first run); the Windows service
(no Windows server here; not run at all). E19#2 is "partly".
