# Wave gate W2: identity, audit, backup and jobs

Release R1, wave W2. Tracks: r1-identity (M05, M16), r1-audit (M10), r1-backup-jobs (M14, M15). Merged earlier: r1-core, r1-migrations, r1-build-shell. This record lists what the gate did to the combined tree; the tracks' own records are `r1-identity.md`, `r1-audit.md` and `r1-backup-jobs.md`. Nothing here is a review, approval or signature.

## Gate edits (the tracks' `*.gate.patch` files, applied and deleted)

Applied in this order: `r1-audit.gate.patch` without its `src/server/backup.ts` hunk (r1-backup-jobs' new `backup.ts` already delegates to `verifyAuditRows`), then `r1-identity.gate.patch`, then `r1-backup-jobs.gate.patch`.

| Files | Why |
|---|---|
| `tests/upgrade/boot.test.ts`, `protections.test.ts`, `upgrade-v0.1.0.test.ts`, `system-info.test.ts`, `server-start.test.ts` | They pinned "4 triggers", "exactly the v0.1.0 statements", "upgraded to 0003_indexes", the v0.1.0 column sets and `{id}` tokens signed with `JWT_SECRET`. They now follow the protection registry and the migration list, check that the columns added to old rows hold only their defaults, and sign in or create a session instead of forging a token. No assertion about data kept, immutability or refusal was removed. |
| `src/server/routes/signatures.ts`, `src/server/routes/traceability.ts` | Chain verification uses the shared verifier (`verifyAuditChainTo`, `verifyAuditChain`) instead of re-hashing the whole table per request. |
| `tests/unit/core/route-table.test.ts` | The legacy `asyncHandler` allowance is gone: `reports.ts` now uses `createRouter`. |
| `src/server/config.ts`, `.env.example` | `BACKUP_MIRROR_DIR`, `BACKUP_PASSPHRASE` (secret), `BACKUP_PASSPHRASE_FILE`, `BACKUP_RETENTION`, `BACKUP_CRON`, `ARTIFACT_DIR`, `QUEUE_DRIVER`. |
| `package.json`, `package-lock.json` | `node-cron` 4.2.1 (the scheduler's one-minute tick); it is bundled into `dist-server/server.cjs`. |

## Regenerated

* `tests/route-table.json`: 82 to 91 routes, additions only (every removed-line count against HEAD is zero). The 9 routes new since r1-identity's 14 are r1-audit's `POST /audit/export`, `GET /audit/history`, `GET /security-events`, `GET /security-events/types`, `POST /security-events/verify` and r1-backup-jobs' `GET /admin/backup/status`, `POST /admin/backup/drill`, `GET /admin/jobs`, `GET /reports/artifact/:jobId`.
* `desktop/schema.sql`: from `drizzle/*.sql` through 0080 (`migrate-cli.ts export-schema`); identical to what CI regenerates.
* `scripts/dev/typecheck/baseline.json`: 5 entries that no longer occur were removed (the baseline may only shrink).

## Integration fix

`src/server/app.ts` now mounts `auditContext` (r1-audit) after `express.json()`. r1-identity's `requireAuth` sets the session id in that context and `writeAudit` reads it, but nothing opened the context, so every audit entry was written with `session_id` null although each track's own tests passed. `tests/api/audit-session-wiring.test.ts` goes through `createApp()`: it failed (null) before the line, passes after, covers two users working in parallel, and checks that the chain with its seal still verifies over entries that carry a session id. In the gate run 16 of 17 version-2 audit rows carry a session id (the remaining one is the creation of the `svc-scheduler` service principal by the scheduler at start-up, which has no HTTP request).

## Gate evidence (fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 25 known baseline errors, none new.
* `npx vitest run`: 46 files passed, 2 skipped (opt-in scale tests); 436 tests passed, 3 skipped, 0 failed. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 60 passed. `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have the same schema and journal. `desktop/schema.sql` equals the generated schema.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 7 migrations), the demo seed and the production bundle on 127.0.0.1:3190: server bundle, source map, installer and backup CLI are not served (404 each), `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL.

## Not done at this gate (carried forward, owners named in the tracks' records)

* Client screens for the new sign-in contract (`Login.tsx`, `Layout.tsx`, `App.tsx`), `src/lib/api.ts`: r1-client-shell.
* `admin-cli` is not in the production bundle; `LIMS_MASTER_KEY` / `LIMS_KEYRING` / backup passphrase from the operating-system credential store, `lastSuccessfulBackupAt` in `/ready`: r1-build-shell.
* `init-db.ts` still creates the first administrator directly (no audit entry, no forced password change); the installer, `globalSetup.ts` and CI use `bootstrap-password-123`, which the new password policy rejects for any other route.
* `express.json()` keeps its 100 kb limit for `POST /transcribe` (dictation longer than about 12 s is refused with 413); a larger limit before authentication is a product decision.
* Signature rows for Administrator actions need entity-polymorphic signatures (r1-esign); the sockets stay unauthenticated (r2-events); `QUEUE_DRIVER=amqp` is untested for lack of a broker.
* Validation package not edited: URS-005 overstates the control and the canned transcription is a data-integrity finding (deviations to raise).
