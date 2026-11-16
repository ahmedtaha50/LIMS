# B-Pharma EBR & Logbook

Electronic batch record and logbooks for a GMP plant: one web application for shop-floor tablets and office computers, on
the factory's own server, always online, in Arabic or English per user. Rules the code keeps: [AGENTS.md](AGENTS.md).
Validation package (draft): [validation/docs/](validation/docs/).

## تشغيل سريع للتجربة (بالعربي)

1. ثبّت **Docker Desktop**، ثم من هذا المجلد (`ebr/`):
   ```bash
   cp deploy/compose/.env.example deploy/compose/.env
   ```
   عدّل في `deploy/compose/.env`: `EBR_DB_PASSWORD`، و`EBR_BOOTSTRAP_ADMIN_PASSWORD` (12 حرفًا على الأقل)، و`EBR_COOKIE_SECURE=0` للتجربة على http.
2. شغّل:
   ```bash
   docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d --build
   ```
3. بيانات تجريبية (مرة واحدة، على تركيب فارغ فقط):
   ```bash
   docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env exec -e EBR_DEMO_PASSWORD='كلمة مرور 12 حرف على الأقل' app node dist/server/demo/cli.js
   ```
4. افتح **http://localhost:4100** (أو من التابلت: `http://عنوان-الكمبيوتر:4100`)، وجرّب السيناريو في آخر هذا الملف. اللغة تُغيَّر من الزر أعلى الشاشة.

## Run it with Docker (any computer)

1. Install Docker Desktop (Windows, macOS) or Docker Engine (Linux).
2. In this folder (`ebr/`): `cp deploy/compose/.env.example deploy/compose/.env`, then set in `deploy/compose/.env`:
   - `EBR_DB_PASSWORD`: the database password;
   - `EBR_BOOTSTRAP_ADMIN_USER` and `EBR_BOOTSTRAP_ADMIN_PASSWORD` (12 characters at least, not containing the user name):
     the first administrator, created once, on the first start;
   - `EBR_COOKIE_SECURE=0` for a test over plain http; keep `1` behind TLS (`deploy/proxy/nginx.conf`).
3. Start: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d --build`
   The database is migrated at start. Health: `http://localhost:4100/api/health`.
4. Open `http://localhost:4100`. A tablet on the same network opens `http://<this computer's address>:4100`.

## Run it as a Windows service (no Docker)

PostgreSQL 16 and Node 22 installed, the application built (`npm ci`, `npm run build`), WinSW 2.12 (`winsw.exe`) next to
the script, then as administrator: `deploy\windows\install-service.ps1 -DatabaseUrl "postgres://ebr:...@127.0.0.1:5432/ebr"`.
The first administrator: `npm run create-admin:built -- <user> "<name>"` with `EBR_ADMIN_PASSWORD` set. Remove the
service with `deploy\windows\uninstall-service.ps1` (the database is left). Details at the top of each script.

## First sign-in

- The administrator chooses a new password, then sets up an authenticator app (Google or Microsoft Authenticator): QA and
  administrator accounts sign quality decisions, so they sign in with a code.
- The administrator creates the accounts in **Users** (operator, supervisor, QA, administrator) and sets the plant's values
  in **Settings** (sessions, sign-in lockout, yield limits, the company directory).
- The built-in equipment and room logbook types wait for QA's review (**Logbook types**, "Reviewed (QA)") before use.

## Demo data

On an EMPTY installation only (it refuses a database with records), one command creates demo accounts, equipment and
rooms (cleaned, calibrated, their logbook types reviewed by QA), two released material lots and the effective recipe
PCM-500, through the same services and signatures people use:

- Docker: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env exec -e EBR_DEMO_PASSWORD='...' app node dist/server/demo/cli.js`
- Without Docker: `EBR_DEMO_PASSWORD='...' npm run demo-data` (or `npm run demo-data:built` after `npm run build`)

Accounts (all with the password given): `demo-operator`, `demo-operator2`, `demo-supervisor`, `demo-qa`
(QA sets up its authenticator at the first sign-in).

## A whole batch to test (with the demo data)

1. **demo-supervisor**: Batches, New batch, recipe PCM-500, batch number `DEMO-0001`.
2. **demo-operator** (on a tablet): open the batch; line clearance; dispense lot `PCM-2601` (50 kg ± 1 %) and `STA-2601`
   (48 kg ± 2 %); mixer `MIX-01` (its logbook gets the use written); water between 18 and 22 L (try 25: an exception);
   the server calculates the ratio; sign the end point.
3. **demo-operator2**: verify the critical step (it must be another person).
4. **demo-supervisor**: handle any exception (deviation number or justification), reconcile the yield, close the batch.
5. **demo-qa**: Review & release: review each exception, complete the review, release; download the certified copy (PDF)
   and check it in **Audit trail**, "Check a certified copy".
6. **demo-qa** or an administrator: Audit trail, "Verify the chain"; Logbooks, MIX-01: its use and cleaning entries.

## Development

`npm ci`, a PostgreSQL 16 for tests (`TEST_ADMIN_URL`, default `postgres://ebr:ebr@127.0.0.1:5432/postgres`), then
`npm run lint`, `npm test`, `npm run build` and `npx playwright test`, `npm run test:perf` (capacity),
`DATABASE_URL=... npm run dev`. Validation evidence and documents: `bash validation/build/collect-evidence.sh`, then
`node validation/build/build.cjs`.
