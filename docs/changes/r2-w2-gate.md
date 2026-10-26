# Wave gate R2 W2: data + integration

Release R2, wave W2. Tracks: r2-raw-data (M20), r2-api-v1 (M22), r2-events (M23), r2-audit-tamper (M35). Merged earlier in R2:
r2-ui-foundation, r2-master-data, r2-methods-calc, r2-qms. This record lists what the gate did to the combined tree; each track's own
record is `r2-<track>.md`. Nothing here is a review, approval or signature.

## Gate edits (the four tracks' gate patches, applied in this order and then deleted)

1. `r2-raw-data.gate.patch` (`git apply`, clean): attachments and review routes, `result.reintegration.approve`, `./rawdata` schema
   export, raw-data protections, result-version hook in `saveResult`, coded correction reasons, Approved-transition guard, backup blob
   section, `SampleDetail` file input, seed, `methods-calc` and upgrade-test expectations.
2. `r2-api-v1.gate.patch` (`git apply`, clean; cut on top of raw-data's): `/api/v1` router, api-clients routes, `./api-clients` schema
   export, `Instrument` role in `RESULT_ENTRY_ROLES`, CI contract check.
3. `r2-events.gate.patch` (`git apply`, clean; cut on top of the two above): authenticated Socket.IO and the dispatcher in `server.ts`,
   notifications and subscriptions routes, `./events` schema export, outbox events in `saveResult`, release and the admin broadcast,
   bell in `Layout`, calibration-due handler and schedule, webhook-secret key rotation, `EVENTS_*` configuration, outbox assertions.
4. `r2-audit-tamper.gate.patch` (`patch -p1 -F3`): it was cut without the three patches above in the tree. Every hunk applied as
   written except one; the fuzzed hunks are pure additions next to lines the earlier patches had added (checked one by one:
   `server.ts`, `schema/index.ts`, `permissions.ts`, `backup.ts`, `jobs/handlers/index.ts`, `routes/index.ts`, `schedules/index.ts`).
   * `tests/upgrade/upgrade-v0.1.0.test.ts` (merged by hand): signature meanings 28 (25 with raw-data's REINTEGRATION_APPROVAL, plus
     AUDIT_REVIEW, AUDIT_REVIEW_SETTING and CLOCK_ANOMALY_ACK; the patch alone said 27) and the one `audit_review_settings` row,
     next to raw-data's `result_versions` expectation. No assertion was removed.

## Integration fix

None needed: every gate below passed on the first combined run.

## Regenerated

* `tests/route-table.json`: 28 routes added (7 raw-data, 3 api-clients, 8 events, 10 audit review), none removed or changed.
* `docs/permission-matrix.csv`: 73 permissions (`result.reintegration.approve`, `audit.review`, `audit.review.settings`,
  `clock.acknowledge` added); the new routes appear under their permissions.
* `desktop/schema.sql`: from `drizzle/*.sql` through 0180, now including 0120, 0140, 0150 and 0170 (`migrate-cli.ts export-schema`).
* `scripts/dev/typecheck/baseline.json`: unchanged (18 known errors, none new).

## Gate evidence (fresh database `lims_gate`, server on port 3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run` (JWT_SECRET and LIMS_MASTER_KEY unset): 118 files passed, 2 skipped (opt-in scale tests); 1437 tests passed,
  3 skipped, 0 failed; no unhandled errors. Migration suite alone (`-c tests/upgrade/vitest.config.ts`): 11 files, 60 passed.
  `tests/upgrade/dump-diff.sh`: fresh install and upgraded v0.1.0 installation have identical schema (2029 lines of pg_dump) and journal.
* `npx tsx src/server/v1/openapi-cli.ts check`: the contract of /api/v1 is current.
* `npm run build`, then the shipped installer (`dist-server/init-db.cjs`, 19 migrations ending at 0180_qms; the lims_app role step
  reports 18 append-only tables insert and read only, 36 guard triggers set to fire always), the demo seed, and the production bundle on
  127.0.0.1:3190 (BACKUP_DIR, BLOB_DIR and AUDIT_ANCHOR_DIR in a scratch folder): start-up anchor check "0 checked, the audit trail
  matches"; `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` (server's JWT_SECRET exported, as r2-audit-tamper
  requires for a keyed chain) 18 PASS, 0 FAIL. As QA, `GET` on `/notifications`, `/event-subscriptions`, `/audit/reviews`,
  `/audit/review-settings`, `/audit/anchors`, `/audit/clock`, `/samples/:id/attachments` and `/samples/:id/review-checklist`, and as
  Admin `/api-clients`, all return 200; `/api/v1/openapi.json` 200; `/api/v1/samples` without a token 401.
* Desktop, after `npm run build`: `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed,
  0 failed.
* `npm run check:root`: root is clean. No browser session was run at the gate; the tracks' runs are in their records.

## Behaviour changes to note

* Migrations 0120, 0140, 0150 and 0170 sort before the already applied 0180, so a development database built from the R2 W1 tree is
  refused with OUT_OF_ORDER and must be rebuilt. Fresh installs and v0.1.0 upgrades are not affected (desktop-upgrade passes).
* The audit chain is keyed (hmac-sha256-v1) from this wave on: a backup of a keyed chain is verified only with the server's key
  (LIMS_MASTER_KEY or the JWT_SECRET fallback). The backup SOP must cover the key.

## Not done at this gate (carried forward; owners named in the track records)

* r2-audit-tamper is partial: the request pool still connects as the database owner; the lims_app role is installed and proven but not
  used (r1-migrations / r3-embedded-pg, desktop shell). The migration runner still writes unkeyed rows (DOWNGRADE exemption).
* No antivirus scan, multipart upload or migration of legacy inline attachments (r2-raw-data). No webhooks for results:batch raw files,
  idempotency-row purge or per-client rate limit (r2-api-v1). No retention for outbox, notifications, deliveries, blobs or anchor files.
* Service accounts (role Instrument) still appear in user pickers and the training matrix (r2-ui-foundation, r1-identity).
* No URS/OQ/RTM entries for M20, M22, M23 or M35 (r2-validation). The migration-number choices and the other decisions for the user
  listed in the four track records are open.

## Follow-up gate (after fedb5f0 and 7df6e8e)

The four tracks were re-checked after the first W2 commit. r2-raw-data, r2-api-v1 and r2-events changed no code (their records gained
a re-verification section). r2-audit-tamper fixed one defect found on review: a batch `AUDIT_REVIEW` covered every row up to the moment
of the POST, not the rows the reviewer was shown. The batch body now requires `throughSequence` (added to `AUDIT_REVIEW_KEYS`), and
`createReview` returns 409 `SCOPE_CHANGED` unless it is the batch's current last entry; the screen signs the displayed summary
(`reviewScopeBody`). API change: `POST /audit/reviews` with scope `batch` without `throughSequence` is 400. Route table unchanged.

Files committed: `src/server/audit/review.ts`, `src/server/routes/audit-review.ts`, `src/components/AuditReview.tsx`,
`tests/api/audit-tamper-review.test.ts`, `tests/api/audit-tamper-ui.test.ts`, and the records `r2-api-v1.md`, `r2-events.md`,
`r2-audit-tamper.md` and this file. The shared tree also holds in-flight W3 work (r2-coa-reports, r2-result-ui, r2-docs-training) and
staged W1 follow-ups; none of it is part of this commit, and the gates ran on a copy of HEAD with only the files above.

Evidence (copy of HEAD plus the files above, fresh database `lims_gate`, port 3190; JWT_SECRET and LIMS_MASTER_KEY unset for vitest):
* RED: the two changed test files on the old code: 6 failed, 16 passed (missing `reviewScopeBody`; the old strict schema refuses
  `throughSequence`; no 409).
* `npm run lint`: web clean; server 18 known baseline errors, none new.
* `npx vitest run`: 118 files passed, 2 skipped; 1439 tests passed, 3 skipped, 0 failed. Route-table snapshot matches.
* `npx tsx src/server/v1/openapi-cli.ts check`: current.
* `npm run build`; `dist-server/init-db.cjs` (19 migrations to 0180_qms, lims_app role checked); demo seed; production bundle on
  127.0.0.1:3190: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` (server's JWT_SECRET exported) 18 PASS,
  0 FAIL. On the live server a batch review without `throughSequence` is 400 VALIDATION_FAILED.
* `xvfb-run -a node tests/desktop-upgrade.cjs` 8 passed, 0 failed; `tests/desktop-shell.cjs` 17 passed, 0 failed.
