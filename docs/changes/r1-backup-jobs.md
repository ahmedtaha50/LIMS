# r1-backup-jobs: backup v2 and the durable job queue (roadmap M14, M15)

Release R1, wave 2. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.

Status: **complete for the acceptance criteria of M14 and M15, with the limits listed under "Not done"**. Two limits matter: the 5 GB figure was measured at 2 GB (memory is flat in the size of the data, see the table), and the parts that live in the desktop shell (the passphrase in `safeStorage`, the one-time recovery key file) are specified here but belong to `desktop/main.cjs`.

## What changed

| Area | Files |
|---|---|
| Backup file v2 (`BPLIMSBK2`) | `src/server/backup.ts`: streamed, text-exact, authenticated frames, manifest in the footer; the v1 reader is kept; `verifyBackupFile` (sync) and `verifyBackup` (streaming), `restoreBackup` (checks the restored database against the manifest), `listFrames`, `readManifest` |
| Backup operations | `src/server/jobs/backupService.ts`: `runBackup` (mirror with re-hash, `backup_runs`, audit), `applyRetention` (7/4/12), `runDrill`, `backupStatus` (banners), `lastSuccessfulBackupAt` |
| Command line | `src/server/backup-cli.ts`: `backup`, `verify` (exit 1 damaged file, 2 failed check), `restore` (schema of the backup's version built from the migrations), `drill` |
| Routes and page | `src/server/routes/backup.ts` (`POST /admin/backup`, `/verify`, `/drill`, `GET /admin/backup/status`), `src/server/routes/jobs.ts` (`GET /admin/jobs`, mounted by `backup.ts`), `public/backup.html` (status with banners, drill button) |
| Records | `drizzle/0080_backup_jobs.sql`, `src/db/schema/ops.ts`: `jobs` extended, `scheduled_jobs`, `backup_runs`, `restore_drills`; `src/db/protections/ops.ts`: the last two are append-only |
| Job queue | `src/server/jobs/`: `queue.ts` (enqueue, claim with `FOR UPDATE SKIP LOCKED`, heartbeat, complete, fail, sweep), `runner.ts` (workers, lease heartbeat, sweeper), `types.ts`, `principal.ts` (service principal), `artifacts.ts` (files with owner, checksum and 30-day retention), `handlers/{index,pdf,backup,maintenance}.ts` |
| Scheduler | `src/server/scheduler.ts` (cron, `ensureSchedules`, `runDueSchedules` with injected clock, `startScheduler`, node-cron tick), `src/server/schedules/index.ts` (`backup.daily`, `backup.drill`, `audit.verify`, `artifacts.cleanup`) |
| Entry point | `src/server/rabbitmq.ts`: same file, same two exports (`initRabbitMQ`, `publishTask(type, data)` plus an optional third argument). `QUEUE_DRIVER=pg` (default) or `amqp` |
| CoA hotfix | `src/server/reports.ts` (409 unless Approved, strict body, owner-only status and artifact), `src/server/pdfWorker.ts` (re-checks the state, no "Official", no `null - null`, and it renders at all, see below), `src/lib/pdfUtils.ts` (default watermark DRAFT) |
| Shared checks | `tests/backup-restore.sh`: five assertions added (v2 format, run recorded, status endpoint, corrupt frame named, tables and timestamps identical after restore). None removed or weakened |
| Tests | `tests/api/backup-format.test.ts` (12), `backup-timezone.test.ts` (1), `backup-runs.test.ts` (10), `backup-routes.test.ts` (9), `backup-jobs-queue.test.ts` (15), `backup-jobs-scheduler.test.ts` (26), `backup-jobs-maintenance.test.ts` (3), `backup-jobs-reports.test.ts` (14), `backup-scale.test.ts` (opt-in) |

Outside the `ownsFiles` list, on purpose, because r1-migrations handed it to this track and no other track owns it: `src/db/protections/ops.ts`. Every other file is in the list. The files this track needs changed in other tracks' files are in `docs/changes/r1-backup-jobs.gate.patch` (apply with `git apply`) and in "Needs from other tracks".

### The file format

```
header   "BPLIMSBK2" | kdf (1) | salt (16) | iv prefix (4)
frame    type (1: data, 2: footer) | length (4) | ciphertext | GCM tag (16)
           IV = iv prefix | frame index (8);  AAD = "BPLIMSBK2" | type | frame index (8)
           data    = gzip(NDJSON): {"t":table,"c":[columns]}, then one JSON array of text values per row
           footer  = the manifest
trailer  footer offset (8) | footer frame index (8) | "BPLIMSE2"
```

* Rows are read in keyset batches by primary key (by `sequence` for the two hash-chained tables, so the chain arrives in order), with identity type parsers: every value is exported as the text PostgreSQL stores, in a UTC session. The restore inserts that text. Nothing passes through a JavaScript `Date` or a float.
* The batch size starts at 5 rows and adapts to the weight of the rows (target 4 MiB), so a table of megabyte attachments is read a few rows at a time. Frames hold 1 MiB of rows before compression.
* Every frame is authenticated with its index and type, so a flipped bit, a dropped, swapped, repeated or appended frame fails, and verification names the frame. The manifest holds the schema version, per-table row count and SHA-256, a separate SHA-256 over the timestamp columns of each table, the audit head, the plaintext stream hash, and `blobs: []` (the attachment section of M20, empty until then; a verifier that finds entries it cannot read reports it).
* The file is written as `<name>.bak.part`, read back and verified from disk, and only then renamed. A file that cannot be read back is deleted; one that reads back but fails a check (a broken audit chain in the source database) is kept and flagged `verified: false`, because it is evidence.
* `restoreBackup` into a non-empty database is still refused. It builds the schema of the backup's version from the migrations (`buildSchemaSql(files, manifest.schemaVersion)`), refuses a backup from a newer schema than the application knows, loads the rows in one transaction, re-installs the append-only triggers, and then checks the restored database itself: row counts, the audit chain, every table re-exported and hashed like the backup, and the timestamp columns on their own.

### The job system

* `jobs` keeps `type` as the handler key (the roadmap calls it `kind`; a rename would break nothing but gained nothing) and gains `run_at`, `attempts`, `max_attempts`, `locked_by`, `heartbeat_at`, `created_by`, `dedupe_key`, `last_error`, `finished_at` and the artifact columns. States: `pending`, `running`, `completed`, `failed`.
* A worker claims the oldest due job of a type it has a handler for with `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`, heartbeats while the handler runs, and completes under the lease predicate (`id AND locked_by AND status = 'running'`), which plays the part of the version check of AGENTS.md section 2: a worker that lost its lease matches no row and cannot overwrite the new owner. A sweeper (every worker runs one) requeues running jobs whose heartbeat is older than 60 s, with back-off, or fails them when their 3 attempts are used.
* Ids are `job-` plus 96 random bits. Every job has an owner; only the owner reads its status and its file (403 for anyone else, Admin and QA included).
* A PDF is a file in `ARTIFACT_DIR` with its SHA-256 recorded and a 30-day expiry; the status route verifies the checksum before it sends the bytes. After 30 days `artifacts.cleanup` deletes the file, marks the row, keeps the checksum, and writes one audit entry per deleted file. Issuing a CoA writes an audit entry (`Create`, `CertificateOfAnalysis`) in the transaction that completes the job.
* The scheduler is a cron registry in `scheduled_jobs`. node-cron ticks every minute and the start-up runs the same tick first; what is due is decided by `next_due_at` against the clock, so a schedule that fell due while the PC was off runs once at start, however many slots were missed (the job payload says how many). One advisory lock (7020) per tick and the slot as the job's dedupe key make a slot run once even with several server processes. Scheduled jobs belong to the service principal `svc-scheduler`, provisioned and audited on first use, role `Service`, inactive, no password, no e-mail: the audit reason of what it does is `Scheduled: <schedule>`.
* `audit.verify` (weekly, Sunday 04:00) re-checks the audit chain and the security-event chain and records the result as an `AUDIT_VERIFY` security event; r1-audit asked for this.

## Why

Findings addressed (roadmap M14, M15 and `synth.topDefects`):

* "Backup timestamp corruption": read through the default parser, restored into naive columns, shifted by the PC's UTC offset. After r1-migrations made the columns `timestamptz` the shift was gone but a JavaScript `Date` still cut every value to milliseconds (measured on the old code in a Cairo process: `13:16:51.889123` came back `13:16:51.889`, `00:30:00.000001` came back `00:30:00`). Now text-exact.
* "`createBackup` throws RangeError near 512 MB": streamed; measured below.
* "Backups are manual, on the same disk, with a passphrase typed per request": scheduled, mirrored with a re-hash, pruned by rule, proven restorable monthly.
* "rabbitmq.ts local fallback polls with no SKIP LOCKED, no re-entrancy guard, no reclaim of a crashed 'processing' row; nack requeues (poison loop); job ids are Math.random": replaced. Measured on the old code: a `processing` row left by a crash was still `processing` after 7 s of the old poller; `publishTask` returned `job-kqjc3mt3b`.
* "`/reports/status` returns any user's job (base64 PDF)": owner-only; measured on the old code: another user got 200.
* "node-cron is absent despite AGENTS.md": node-cron drives the tick (the dependency line is in the gate patch).
* "pdfWorker stamps 'Official (System Generated)' on any sample state and prints 'null - null'": 409 for a sample that is not Approved, the worker re-checks, specifications print as `a - b`, `>= a`, `<= b` or "No numeric limit". Measured on the old code: a Testing sample got 200 and a job.
* A defect found on the way: **the CoA PDF could never be rendered on the server**. jspdf-autotable 5 no longer adds `doc.autoTable()` outside a browser, so `generatePdf` threw `doc.autoTable is not a function` on every call and the job ended `failed`. It now calls `autoTable(doc, ...)`; the rendered PDF is in the tests and was read with `pdftotext`.
* `src/lib/pdfUtils.ts` defaulted the watermark to "Approved" and drew any non-draft status green (a Rejected report was green). Default is now DRAFT, only a status starting with "Approved" is green.
* Not a finding but a hazard: the old `adminWithPassword` of the backup routes counted nothing. The routes now use `assertActorPassword` (r1-identity), so wrong passwords count toward the signing lock and are audited.

## Deliberate behaviour changes

1. `POST /api/admin/backup`: strict body `{ password, passphrase? }`. The passphrase is optional when `BACKUP_PASSPHRASE` is configured. The response keeps `file, sha256, verified, auditHead, counts` and adds `mirror`, `runId`, `problems`. Failures are 500 `BACKUP_FAILED` with the reason (they used to be 400 with any message); the attempt is recorded.
2. `POST /api/admin/backup/verify`: also strict; a damaged frame is a normal answer (`ok: false, corruptFrame: n`), an unreadable file or a wrong passphrase is 400.
3. Backup files are written as `BPLIMSBK2`. Old files stay readable.
4. `backup-cli verify` exits 1 for a damaged file (as before for a tampered file), 2 for a failed check; `restore` no longer needs `desktop/schema.sql` (it builds the schema of the backup's version from `drizzle/`; `SCHEMA_FILE` still overrides).
5. `POST /api/reports/generate`: strict body `{ sampleId }`, 404 for an unknown sample, **409 `SAMPLE_NOT_APPROVED`** for any state but Approved, one active job per user and sample. `GET /api/reports/status/:jobId`: 403 for another user, 404 unknown, `error` still the failure text; a finished PDF still answers `result` as a `data:` URI (what `SampleDetail.tsx` consumes). New: `GET /api/reports/artifact/:jobId` (download).
6. `publishTask(type, data)` keeps working; a job without an explicit owner belongs to the service principal.
7. `jobs` rows that v0.1.0 left in `processing` are marked `failed` by the migration; v0.1.0 job rows have no owner, so nobody can read their stored result any more.
8. Starting the server now starts the workers, the scheduler and (when `QUEUE_DRIVER=amqp`) the RabbitMQ doorbell; without a RabbitMQ the old fallback message no longer appears because the database queue is the default.
9. `reportsRouter` is built with `createRouter()`, so the two report routes are now wrapped by `asyncHandler`; `tests/unit/core/route-table.test.ts` has an allowance for exactly this file (its own comment says to delete it): the gate patch does.

## How to verify

```
# this track's tests (needs PostgreSQL and a role that may CREATE DATABASE and DROP DATABASE)
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=lims_r1_backup_jobs npx vitest run tests/api/backup-
# the same on a PC whose clock, PostgreSQL session and libpq are all Cairo
TZ=Africa/Cairo PGTZ=Africa/Cairo PGOPTIONS='-c timezone=Africa/Cairo' <same command>
# memory (opt-in, minutes and disk): a 2,048 MB attachment database; each of backup, verify and restore in its own process
BACKUP_SCALE_MB=2048 npx vitest run tests/api/backup-scale.test.ts --reporter=verbose
# shared checks against a server built from this tree (HOST=127.0.0.1 PORT=3105; fresh seeded database)
BASE=http://127.0.0.1:3105/api tests/security-controls.sh     # 34 PASS
BASE=http://127.0.0.1:3105/api tests/backup-restore.sh        # 18 PASS (13 before, 5 added)
```

### Acceptance

| Criterion | Evidence |
|---|---|
| M14: under `TZ=Africa/Cairo`, backup then restore leaves `signatures.timestamp`, `results.entered_at`, `samples.created_at` byte-identical | `backup-timezone.test.ts`: the backup and the restore run in a child whose clock, PostgreSQL session and libpq options are all Cairo (checked: offset -180, session zone `Africa/Cairo`); values include `00:30:00.000001` inside a spring-forward gap and `22:59:59.999999`; the three columns and `audit_trail` compare equal as the text PostgreSQL prints in a UTC session. Fails on the old code (`.889123` came back `.889`). The whole `tests/api/backup-*` set also passes with `TZ`, `PGTZ`, `PGOPTIONS` Cairo (90 pass) |
| M14: a 5 GB attachment database backs up with peak RSS under 300 MB | measured at **2 GB** (`backup-scale.test.ts`, 2,048 rows of about 1 MB in `results.attachment_data`): backup 1,165 MB file in 161 s, **peak RSS 203 MB**; verify 174 MB; restore 202 MB, every table hash identical to the backup. A 256 MB run peaked at 237 MB and a 500 MB run at 207-246 MB over three runs: the peak is set by garbage-collector timing and the `tsx` loader (about 80 MB), not by the size of the data. The shipped bundle (`dist-server/backup-cli.cjs`, 500 MB database) peaks at **139-154 MB** for the backup and 101 MB for verify. The 5 GB run itself was not made |
| M14: with nobody logged in a backup appears at the schedule time and is mirrored with a matching sha256; an unavailable mirror records `mirror_ok=false` and shows a banner | `backup-jobs-scheduler.test.ts` (last block): the default `backup.daily` schedule, due at 02:00, runs through scheduler, queue and handler; file and mirror have the same SHA-256; the run belongs to `svc-scheduler` with reason `Scheduled: backup.daily`. `backup-runs.test.ts`: a mirror path under a regular file gives `mirror_ok=false`, `mirror_error`, an audit entry `BACKUP_MIRROR_FAILED`, and the `MIRROR_FAILED` banner. Also run in the real bundle: a schedule made overdue in the database, the server started, the backup ran within a second and was mirrored |
| M14: the monthly drill writes `restore_drills.passed=true`, and one corrupt frame fails verify with its index | `backup-runs.test.ts`: the drill restores into a scratch database, compares chain, counts, every table and the timestamp columns, records `passed=true`, drops the scratch database; with one bit flipped in one frame it records `passed=false` and `error` names `frame N`. `backup-format.test.ts`: a flipped bit in frames first, middle and last is reported with that index by the synchronous and the streaming verifier; dropped, swapped, truncated and appended frames are refused |
| M15: killing the server mid-job leaves a running row that is reclaimed and completed with attempts=2 | `backup-jobs-queue.test.ts`: a separate Node process claims a job and hangs, is killed with SIGKILL, the row stays `running`, a second runner's sweeper requeues it and it completes with `attempts = 2` |
| M15: two server processes execute each job exactly once; user B gets 403 on user A's artifact | the same file: 60 jobs, two OS processes, each job recorded once, both processes took part, `attempts = 1` for all. `backup-jobs-reports.test.ts`: analyst2, QA and Admin get 403 on analyst1's status and on the PDF; unknown id 404; no token 401 |
| M15: a schedule due while the PC was off runs once at start (injected-clock unit test) | `backup-jobs-scheduler.test.ts`: due at 02:00, `now` 09:30, one job for the service principal; five missed days collapse into one job whose payload says `missed: 5`; 8 simultaneous ticks enqueue once; `startScheduler` runs the catch-up before its first tick |
| M15: a PDF request for a Testing sample returns 409 | `backup-jobs-reports.test.ts`: Logged, Testing, Pending Review and Rejected each answer 409 `SAMPLE_NOT_APPROVED` and queue nothing |

## Evidence recorded while building this track

* **Test first.** The tests were written before the code. On the old tree: `backup-format` 4 failed and 3 not run, `backup-timezone` failed, `backup-routes` 7 of 9 failed, and the five files for new modules could not load. Four probes against the old behaviour (a temporary test file, deleted): backup in a Cairo process lost the microseconds; a Testing sample got 200 and a job; another user got 200 on a job's status; a job left `processing` by a crash was still `processing` after the old poller had run for 7 s, and `publishTask` returned `job-kqjc3mt3b` (about 46 bits).
* **Mutation checks** (change the code, the named test must fail): default type parsers in the backup reader (timezone and round-trip tests fail); no `SKIP LOCKED` (the claim race, the runner and the two-process tests fail); no owner check (the 403 test fails); no state check (the four 409 tests fail); no collapse of missed slots (the catch-up test fails); watermark default back to Approved (the DRAFT test fails).
* **Gate emulation.** A copy of the tree with the r1-audit and r1-identity gate patches applied (r1-audit's without its `backup.ts` hunk), `desktop/schema.sql` and `tests/route-table.json` regenerated and `docs/changes/r1-backup-jobs.gate.patch` applied: `npx vitest run` 433 passed, 3 skipped (the opt-in scale tests), 0 failed. In the shared tree as it is now the failures are the ones the gate resolves (route table x2, `desktop/schema.sql` x2, r1-audit's `boot`/`protections`/`upgrade-v0.1.0`, r1-identity's `server-start`/`system-info`); none is in a file of this track.
* **Shared checks**, server built from this tree and started on port 3105 against a freshly migrated and seeded database: `security-controls.sh` 34 PASS, 0 FAIL (a second consecutive run fails `URS-005-correct-totp-issues-session` by design: the TOTP replay guard of r1-identity); `backup-restore.sh` 18 PASS, 0 FAIL.
* **Real bundle.** CoA end to end over HTTP in that server: Testing sample 409, Approved sample PDF, owner 200 and another analyst 403, the PDF read with `pdftotext`.

## Operating it

Environment (all optional; the gate patch adds them to `src/server/config.ts` and `.env.example`):

| Variable | Meaning |
|---|---|
| `BACKUP_DIR` | where backups go (default `./backups`; the shell sets it) |
| `BACKUP_MIRROR_DIR` | a second location (another disk, a share). Each backup is copied there and the copy is hashed again |
| `BACKUP_PASSPHRASE` or `BACKUP_PASSPHRASE_FILE` | the key of unattended backups, at least 12 characters. Without it a scheduled backup is recorded as failed and the status shows a banner |
| `BACKUP_RETENTION` | `daily/weekly/monthly`, default `7/4/12` |
| `BACKUP_CRON` | time of the nightly backup on a new installation, default `0 2 * * *` (server local time) |
| `ARTIFACT_DIR` | generated documents (default: `artifacts` next to the backups folder) |
| `QUEUE_DRIVER` | `pg` (default) or `amqp` |

What the desktop shell has to do (`desktop/main.cjs`, r1-build-shell): at first setup generate a random passphrase of 24 or more characters, keep it in `safeStorage`, pass it to the server child as `BACKUP_PASSPHRASE`, write a one-time recovery key file (the same passphrase, created with `wx` so it cannot be overwritten, shown once for QA/IT to file), and pass `BACKUP_MIRROR_DIR` when the user picks one. Backups hold keystore ciphertext (authenticator secrets, the AI key); restoring on a PC without the key ring leaves those unreadable (`docs/changes/r1-identity.md`).

Restore (into an empty database; the schema of the backup's version is built from `drizzle/`, so run from the application folder or set `MIGRATIONS_DIR`):

```
RESTORE_DB_NAME=<new empty db> BACKUP_FILE=<file>.bak BACKUP_PASSPHRASE=... node dist-server/backup-cli.cjs restore
node dist-server/backup-cli.cjs drill        # restore into a scratch database, compare, drop it
```
Exit 0 means counts, audit chain, every table and every timestamp column matched. Start the application against the restored database through the installer (`init-db`), which upgrades it if the backup is older than the build.

## Decisions that need confirmation

See the structured report (`decisionsForUser`). In short: retention applies to scheduled backups only; the default times; who may read a job; the service principal; the restore drill needs `CREATEDB`; 30-day artifact retention; no DRAFT preview of a CoA; the unattended passphrase.

## Needs from other tracks (for the wave gate)

Apply `git apply docs/changes/r1-backup-jobs.gate.patch` (route-table allowance, `config.ts`, `.env.example`, `package.json`, `package-lock.json`), then:

| File (owner) | Change |
|---|---|
| `package.json` (r1-build-shell) | `"node-cron": "4.2.1"` in devDependencies, in the patch (the server bundle imports it dynamically; without it the server starts with an error at `startScheduler`) |
| `tests/route-table.json` (r1-core) | regenerate: `NODE_ENV=test JWT_SECRET=<32 characters> SQL_HOST=x SQL_USER=x SQL_PASSWORD=x SQL_DB_NAME=x npx tsx tests/helpers/dump-route-table.ts --stdout > tests/route-table.json` (r1-audit's command with a longer secret: the keystore now refuses `x`). New: `GET /api/admin/backup/status`, `POST /api/admin/backup/drill`, `GET /api/admin/jobs`, `GET /api/reports/artifact/:jobId` |
| `desktop/schema.sql` (r1-migrations) | `npx tsx src/server/boot/migrate-cli.ts export-schema` once the last migration of the wave has landed (0080 changes it) |
| `src/server/backup.ts` hunk of `docs/changes/r1-audit.gate.patch` (r1-audit) | superseded: apply the patch with `--exclude=src/server/backup.ts`; `verifyAuditChain(rows)` in the new file already delegates to `verifyAuditRows` |
| `src/server/obs/health.ts` (r1-build-shell) | `lastSuccessfulBackupAt` in `GET /ready`: `import { lastSuccessfulBackupAt } from '../jobs/backupService'` |
| `desktop/main.cjs` (r1-build-shell) | the passphrase, recovery key file and mirror folder described under "Operating it"; the server child needs `BACKUP_PASSPHRASE`. Also the installer step still needs `MIGRATION_BACKUP_PASSPHRASE` |
| `src/server/routes/index.ts` (r1-core) | optional: list `jobsRoutes` and remove the `router.use(jobsRoutes(ctx))` line in `routes/backup.ts`. `routes/reports.ts` can become `reportsRoutes(ctx)` and `src/server/api.ts` (the shim) can be deleted: nothing imports it now |
| `src/components/SampleDetail.tsx` (r1-results-oos) | show the `error` of a failed `POST /reports/generate` (now 409 with a reason; the screen says only "Failed to generate report") |
| `src/components/Layout.tsx` or `AdminPanel.tsx` (r1-client-shell) | a banner from `GET /api/admin/backup/status` (`banners[]`); `public/backup.html` shows it already |
| `src/components/Reports.tsx` (r1-results-oos) | still hard-codes the "Approved" watermark; `applyGxPTheme` is now safe by default |
| r1-identity / r1-authz | the service principal `svc-scheduler` has role `Service`, which is not in `USER_ROLES`: user administration must never activate it, give it a password or change its role, and the role list in the UI should not offer it |
| `docs/gxp-audit-findings.csv`, `validation/` | no entries yet for backup v2, the drill, the queue and the scheduler (the tests above are the material) |

## Not done

* **Training "Overdue" is still never set.** The scheduler and the handler registry are there; the rule is not: `training_records` has no due date or retraining interval, and defining one is a policy decision for QA and a schema change in the identity domain.
* **5 GB.** Measured at 2 GB; memory does not depend on the size of the database (one frame and one batch), but the 5 GB run itself was not made.
* **`QUEUE_DRIVER=amqp` is untested**: there is no RabbitMQ on this machine. The code path is a doorbell (a message wakes the local runner; the database stays the source of truth), about 15 lines.
* **A mirror copy that failed is not retried for earlier backups**; it is retried with the next backup, and the banner stays until one succeeds.
* **Schedules are changed in the database, not through an API**, and `scheduled_jobs` is not append-only or audited (an Administrator with database access can disable the nightly backup; the status banner shows the backup is stale after 36 hours). An administrative route with password, reason and audit belongs with r1-authz.
* **The recovery key file and `safeStorage`** (shell side), the **banner in the main layout**, **`/ready`**, see the table above.
* **The manual backup route is synchronous.** A very large database can exceed an HTTP client's patience; the scheduled path is a job.
* Blob section: the format reserves it, nothing writes it (M20).
