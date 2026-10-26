# B-Pharma LIMS – Engineering roadmap

_Generated from a five-engineer code review (LIMS domain, QA/regulatory, security, frontend/UX, platform) and fact-checked against the code. Source of truth for agents: `roadmap.json`._

## Vision

Make the product the validated, offline-first, tamper-evident QC LIMS for small and mid-size pharma labs, and make it bilingual (Arabic RTL and English). The closest comparison is LabWare, STARLIMS, SampleManager and LabVantage. Order of work: R1 closes the integrity holes, so no OOS or empty sample can be released, signatures always verify, MFA cannot be bypassed, and the data survives upgrade and restore. R2 adds the depth buyers expect from the incumbents: versioned specs and methods, calculation engine, controlled CoA, custody and storage, reagents, stability, EM, worklists, instrument capture, QMS and SOP/training control. R3 adds what the incumbents do not do well: Arabic/RTL with locale-safe GxP dates, SPC/OOT trending with shelf-life estimation, zero-install embedded PostgreSQL with least-privilege roles, directory sign-on, archival, and global search. Every change keeps the AGENTS.md rules: audit in the same transaction, e-signatures with meaning and recordVersion, optimistic concurrency, strict Zod, actor from req.user.

## R1 Foundation and integrity

Make the existing system trustworthy and upgradeable. Split api.ts and schema.ts into per-domain modules so later work runs in parallel. Close the critical integrity and security defects: OOS-blind release, MFA bypass, the spec-approval FK failure, failed-signature bookkeeping rolled back, fabricated data, and timestamp corruption in backup. Add the migration runner, scheduler and backup v2. Order: r1-core first (serial), then r1-migrations, r1-identity, r1-build-shell and r1-client-shell, then r1-esign, r1-audit, r1-authz, then the domain tracks. Migration numbers are reserved per track: 0000-0009 migrations, 0010 identity, 0020 esign, 0030 audit, 0040 authz, 0050 results-oos, 0060 spec, 0070 quality-fixes, 0080 backup-jobs. Rule for all later work: the samples and results core tables are frozen (their columns feed signed hashes). New sample or result features add 1:1 sidecar tables (sample_<feature>, result_<feature>) so tracks never edit the same schema file. Result guards, transition guards, release blockers, job handlers and schedules are directory registries, so each track adds its own file instead of editing a shared one.

### r1-core  (depends on: —)

Runs alone first. Characterization test (route-table.json), then a mechanical move of every route into src/server/routes/<domain>.ts: auth, admin, training, eln, notebook-templates, samples, results, oos, release, specifications, instruments, reagents, env, stability, traceability, audit, signatures, dashboard, reports, ai, backup, jobs, system, lookup. Also split lims.ts into per-domain validation files and make server.ts a thin composer of http/security.ts, http/static.ts and realtime.ts. Domain route and validation files transfer to the owning tracks on merge. Adds core primitives and the Vitest harness. Express stays on 4 with the asyncHandler wrapper.

- **M01 Platform core: api.ts split, transactional primitives, central validation and errors, test harness [PLT-03+SEC-06+PLT-06 harness]** — impact high, effort L, fact-check: confirmed

  - Acceptance:
    - tests/route-table.json is identical before and after the split, except the removed duplicate /audit/verify.
    - Two parallel PUTs with the same expectedVersion give one 200 and one 409.
    - A non-string password to any route returns 400 and the server stays up.

### r1-build-shell  (depends on: r1-core)

Repo hygiene and config: delete the 143 root scripts (tag the legacy commit), remove Firebase and xlsx, self-host fonts, add typed Zod config, add a strict server tsconfig with a baseline file. Shell and HTTP hardening: production-by-default, loopback bind, CSP, server bundle moved out of the static root, IPC sender checks, stable port, permission handler, per-user JSON rate limits, pino logs, /api/health and /api/ready, crash supervision. Seed script split into scripts/dev/seed/index.ts plus per-domain seeds/*.ts.

- **M02 Repo hygiene, typed config, dependency cleanup, offline assets [PLT-05+SEC-08 part+PLT-06 tsconfig]** — impact medium, effort S, fact-check: not fact-checked

  - Acceptance:
    - git ls-files at the repo root shows no stray .cjs/.js scripts.
    - Starting with a malformed required variable prints one readable error and exits.
    - The app loads offline with zero font requests, and reintroducing r.expirationDate fails lint.

- **M03 Desktop shell, server HTTP hardening, observability [SEC-07+SEC-11+PLT-08]** — impact high, effort M, fact-check: partly

  - Acceptance:
    - GET /server.cjs.map and /server.cjs return 404.
    - A rotating X-Forwarded-For does not reset the auth limiter, and 429 returns JSON.
    - Killing the server child restarts it within 10 s and the log has the stack trace.

### r1-migrations  (depends on: r1-core)

Versioned forward-only migrations in drizzle/ with a checksum runner, pre-migration verified backup, downgrade guard and SYSTEM_MIGRATION audit. Includes the timestamptz conversion, the counters table, the index set, and the append-only trigger registry (src/db/protections/<domain>.ts). Splits schema.ts into per-domain files handed to the owning tracks: identity, signatures, audit, samples, oos, specifications, eln, equipment, ops.

- **M04 Versioned migrations, schema split, timestamptz fix, indexes [G2+QA-04+PLT-02+PLT-09 indexes]** — impact critical, effort M, fact-check: confirmed

  - Acceptance:
    - A DB created from the v0.1.0 fixture upgrades with a valid audit chain, verifying signatures, a pre-migrate backup and a SCHEMA_MIGRATED audit row.
    - Under PGTZ=Africa/Cairo, DB-default and app-supplied timestamps read back with identical semantics.
    - CI fails when schema.ts changes without a migration, and an edited applied migration is refused by checksum.

### r1-identity  (depends on: r1-core, r1-migrations)

Purpose-typed tokens, working TOTP enrolment, replay and throttle protection, encrypted TOTP secrets, sessions table with idle and absolute timeout and logout, user create/reset/deactivate, password policy and history, split login and signing lockouts, login/lockout/logout security events, break-glass CLI, training-certify fix. Keystore and AI egress control: AI off by default, no canned output, labelled drafts.

- **M05 Identity and authentication: MFA bypass fix, enrolment, sessions, user lifecycle, password policy, lockout split [SEC-01+SEC-03+SEC-04+SEC-05+QA-03]** — impact critical, effort L, fact-check: confirmed

  - Acceptance:
    - A tempToken used as Bearer on GET /api/samples returns 401, and the same TOTP code twice returns 401 the second time.
    - GET /training as an Analyst contains no totpSecret, failedAttempts or lockedAt (serialization test).
    - An analyst created by Admin is forced to change the password, and all other calls return 403 PASSWORD_CHANGE_REQUIRED until done.
    - Three bad signing passwords lock signing for 15 min but not login, and the lock expires by itself.

- **M16 Keystore, field encryption and controlled AI/external egress [SEC-12 + fabricated-output defects]** — impact high, effort M, fact-check: confirmed

  - Acceptance:
    - With no key set, POST /transcribe returns 503 AI_DISABLED and the UI shows toast.error, and no canned text reaches an ELN entry.
    - Enabling AI needs password re-entry and creates an audit row plus an EXTERNAL_CALL event per request.
    - A key rotation writes v2 ciphertext while v1 data stays readable, and a denied-network run completes the OQ suite.

### r1-client-shell  (depends on: r1-core)

apiFetch client with typed errors and 401 handling, session guard with idle lock and re-auth that keeps unsaved form state, ErrorBoundary, working MFA and forced password-change screens, and removal of the static 'Validated/Compliant' badges and of the atob token decode. Develops against the /auth/me and /auth/reauth contract from r1-identity.

- **M06 Client session layer: apiFetch, idle lock and re-auth, error boundary, MFA and password-change screens [UX-01]** — impact critical, effort M, fact-check: confirmed

  - Acceptance:
    - Expiring the token mid-edit shows ReauthModal, the typed value is still there, and the save then succeeds.
    - An invalid token shows an inline 'Session expired' state on Dashboard and Reagents, never a white screen.
    - A TOTP user reaches the app with a real JWT (not the string 'undefined').

### r1-esign  (depends on: r1-core, r1-migrations, r1-identity)

One signRecord service, polymorphic signatures (entity_type, entity_id, nullable FK), signature_meanings catalog, name and role snapshot, failure bookkeeping committed in its own transaction, TOTP step-up, training exemption keyed to the meaning, and verification for every entity type. Other tracks migrate their own signing calls to it.

- **M07 E-signature service: polymorphic binding, meaning catalog, snapshots, uniform failure handling [QA-01+SEC-05 esign+PLT-03 signedAction+G3 polymorphism]** — impact critical, effort L, fact-check: partly

  - Acceptance:
    - Approving a Draft spec as QA returns 200 with a signature row entity_type='Specification' on a schema built from migrations.
    - Three wrong passwords on any signing endpoint leave three SignatureFailed audit rows and a persisted lock.
    - Altering an OOS or ELN row in SQL makes /signatures/verify return valid=false, contentHashMatches=false.
    - A client-supplied meaning is ignored, and renaming a user leaves old manifestations unchanged.

### r1-audit  (depends on: r1-core, r1-migrations)

Audit v2: actor snapshot columns, hash_version/hash_alg, one shared chain verifier (duplicate route removed, Admin/QA only), checkpoints and bounded signature verification, keyset-paged and filtered /audit with CSV export, security_events chain, audit viewer and per-record History tab.

- **M08 Audit core: v2 records, scalable verification, queries and export, security events, history UI [QA-07 part+SEC-09 core+PLT-10+UX-04 part]** — impact high, effort L, fact-check: confirmed

  - Acceptance:
    - With 1M rows, /signatures/verify responds in under 300 ms with under 50 MB allocated.
    - An Analyst calling POST /audit/verify gets 403, and exactly one handler is registered.
    - GET /audit?entity=Sample&entityId=X pages by cursor, and a pre-upgrade v1 chain still verifies.
    - A scripted login failure, lockout and logout each create one security event.

### r1-authz  (depends on: r1-core, r1-migrations, r1-identity)

Permission tables with a default matrix migrated from the four roles. Central route-to-permission table applied as middleware (no edits to route files) with a boot-time deny-by-default assertion. Entity state-machine definitions, shared record-level SoD helper, role-change e-signature, exported matrix, and a fuzz test that posts unknown keys to every mutating route.

- **M09 Server-enforced permission matrix, deny-by-default route table, entity state machines, record-level SoD [QA-02+SEC-02]** — impact critical, effort L, fact-check: confirmed

  - Acceptance:
    - The route-contract test fails when a route is added without a permission.
    - An Analyst approving a spec gets 403, and a QA author approving their own gets 403 (both audited).
    - PUT /oos/:id with a status key returns 400, and PUT on a closed OOS returns 423.
    - Posting an unknown key to every mutating route returns 400 (table-driven).

### r1-results-oos  (depends on: r1-core, r1-migrations, r1-esign, r1-authz, r1-audit, r1-spec)

Server evaluator with USP 7.20 rounding, auto-opened OOS in the result transaction, result-entry role and state rules, completeness and OOS gates on review, approve and batch release, and OOS status vocabulary and legal transitions. Also the isOOS rename and Reports.tsx hotfixes, and the guard, result-guard and release-blocker registries. Sample id via per-year counter, cursor-paged GET /samples, set-based bulk import, spec binding.

- **M10 Result evaluation, OOS auto-open, completeness and release gates, registration hardening [G1+QA-06 core+QA-02 release+G8/UX-08/PLT-09 counters]** — impact critical, effort L, fact-check: confirmed

  - Acceptance:
    - 97.96 against NLT 98.0 gives is_oos=false and 97.94 gives true. '<0.05' is accepted where declared, 'garbage' and '1,234.5' return 400.
    - An OOS result creates exactly one Open investigation in the same transaction, and a forced audit failure rolls both back.
    - Review with a null result returns 400 naming the parameter. Approve with a non-terminal OOS returns 400. Batch release returns 400 for any OOS without a terminal investigation and for a batch with zero samples.
    - A Reviewer PUT on a result returns 403, and a PUT in Pending Review returns 409. 20 parallel POST /samples give 20 unique ids, and the first of a new year is SMP-<year>-00001.
    - The SampleDetail grid shows an OOS badge and the CoA text says CONTAINS OOS RESULTS.

### r1-spec  (depends on: r1-core, r1-migrations, r1-esign, r1-authz)

Specification lifecycle: author, revision_label separate from the OCC counter, strict parameter schema with unit, limit kind and decimals, effective-date selection, SoD approval through signRecord (fixes the FK failure), and resolveActiveSpec() for registration.

- **M11 Specification lifecycle: author, revision vs OCC, effective date, SoD approval, sample binding [G3 part+QA-12 spec]** — impact critical, effort M, fact-check: confirmed

  - Acceptance:
    - Approving as the author returns 403. As QA with training it returns 200 and a Specification signature row.
    - Three draft edits then approve leaves revision_label=previous+1 while the OCC version increments. The UI shows revision.
    - A sample registered under rev 2 keeps spec_revision=2 after rev 3 is approved.
    - PUT parameters with min>max returns 400, and a future-dated spec is not selectable before its date.

### r1-quality-fixes  (depends on: r1-core, r1-migrations, r1-esign, r1-authz, r1-client-shell)

ELN: author-only signing, server-chosen meaning, untruncated audit, template audit and role, notebook entries blocked after Approved. Hotfix wave: calibrate (role, date validation, history, signature), reagent receipt with a verified password, grade-aware EM limits, stability status and edit lock, honest dashboard, and batch-material defaults removed.

- **M12 ELN integrity [QA-11 ELN part+SEC ELN items+QA defects]** — impact high, effort S, fact-check: confirmed

  - Acceptance:
    - Signing someone else's entry as AUTHORSHIP returns 403.
    - An ELN edit audit contains the full old and new content.
    - A notebook POST on an Approved sample returns 409, and the signature row has a real hash and audit link.

- **M13 Hotfix wave: calibration, reagent receipt, EM limits, stability edits, honest dashboard, batch-material defaults [G7 calibrate+G6 receipt+G10 minimal+G9 minimal+G13/UX-14 fabricated data+G12 defaults]** — impact high, effort M, fact-check: confirmed

  - Acceptance:
    - Calibrate with a past date returns 400, an Analyst gets 403, and a calibration_history row exists.
    - Receiving a reagent from the UI succeeds with the right password and returns 401 with a wrong one (audited).
    - Grade A 1 CFU gives Action and opens an excursion. Grade C 40 CFU follows the seeded profile.
    - The dashboard with no samples shows an empty trend (no literals, no Math.random).
    - POST batch material without coaStatus returns 400, and verifier == dispenser returns 403.

### r1-backup-jobs  (depends on: r1-core, r1-migrations)

Backup v2 (streamed, text-exact timestamps, blob section, scheduled run, mirror copy, retention, restore drill) and the DB-backed job queue with node-cron registry and start-up catch-up. Hotfixes: job ownership check, and CoA PDF refused for non-Approved samples with a DRAFT watermark.

- **M14 Backup v2: streaming, text-exact timestamps, scheduled with mirror, retention, restore drills [PLT-01+QA-13 backup+SEC-10 scheduler]** — impact critical, effort M, fact-check: confirmed

  - Acceptance:
    - Under TZ=Africa/Cairo, backup then restore leaves signatures.timestamp, results.entered_at and samples.created_at byte-identical.
    - A 5 GB attachment database backs up with peak RSS under 300 MB.
    - With nobody logged in, a backup appears at the schedule time and is mirrored with a matching sha256. An unavailable mirror records mirror_ok=false and shows a banner.
    - The monthly drill writes restore_drills.passed=true, and one corrupt frame fails verify with its index.

- **M15 Durable job queue and start-up catch-up scheduler [G2 scheduler+PLT-11+QA-13 scheduler]** — impact high, effort M, fact-check: confirmed

  - Acceptance:
    - Killing the server mid-job leaves a running row that is reclaimed and completed with attempts=2.
    - Two server processes execute each job exactly once, and user B gets 403 on user A's artifact.
    - A schedule due while the PC was off runs once at start (injected-clock unit test).
    - A PDF request for a Testing sample returns 409.

## R2 Competitive feature depth

Reach functional parity with LabWare, STARLIMS and SampleManager on the QC workflow: master data, methods and calculations, bench-side result entry, raw-data integrity, instrument capture, controlled CoA, custody and storage, reagents, stability, EM, worklists, QMS, SOP and training, TAT and KPIs, plus an integration API and release engineering. Domain tracks plug into the R1 registries, so they run in parallel. Migration ranges: 0100 and up, reserved per track (0100 master-data, 0110 methods, 0120 raw-data, 0130 instrument, 0140 api, 0150 events, 0160 reports, 0170 oos, 0180 qms, 0190 docs-training, 0200 custody, 0210 reagents, 0220 stability, 0230 em, 0240 worklists, 0250 tat, 0260 audit-tamper). Sidecar-table rule from R1 continues.

### r2-master-data  (depends on: —)

Products, batches, customers. Sample registration through pickers that fill the existing material and batch text columns. Sidecar sample_context table. Dispense and verify controls.

- **M17 Product, batch and customer master data [G12 + traceability fixes]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - Registering via product and batch fills samples.material and batch and stores the ids in sample_context.
    - The migration maps every sample with zero orphans, and old signatures still verify.
    - The same batch_no under two products is allowed, and a duplicate within a product returns 409.

### r2-methods-calc  (depends on: —)

Methods, normalised spec_parameters, test plans, calc_formulas, safe expression parser, result_inputs, SST invalidation. Takes over the R1 spec route and UI.

- **M18 Methods, normalised spec parameters, test plans, calculation engine, SST [G3 rest+G4 server]** — impact high, effort L, fact-check: confirmed

  - Acceptance:
    - 25 table-driven worked examples match hand-calculated values, and '__proto__', ';' and non-allow-listed calls are rejected.
    - Changing a formula afterwards leaves an existing result unchanged (formula version stored).
    - RSD 2.7 against NMT 2.0 sets Invalid and blocks review with no OOS. Entry on a Draft method returns 400.
    - The spec_parameters migration shows identical limits (row-count and value diff).

### r2-result-ui  (depends on: r2-ui-foundation, r2-methods-calc)

Keyboard-first result grid with units, live advisory PASS/OOS chip, instrument and lot selection, atomic multi-row save, and the open-investigation action. Mounts the CoA, custody and history panels delivered by other tracks.

- **M19 Bench-side result workbench [UX-02]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Tab/Enter walks all parameters. Ctrl+S saves all dirty rows in one transaction, and a stale row blocks the whole save with a highlight.
    - An instrument 3 days overdue is disabled in the dropdown, and via the API it returns the existing GxP Violation.
    - Each changed value creates exactly one audit row with reason, old and new value.

### r2-raw-data  (depends on: —)

Append-only result_versions with coded reasons, content-addressed attachment store with hash re-check on read, and a server-evaluated review checklist required for approval.

- **M20 Raw-data integrity: result versions, attachment store, review checklist [QA-11+SEC-13+PLT-13 blobs]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Three edits yield three result_versions rows with codes, and UPDATE/DELETE on that table is refused by the trigger.
    - A 20 MB attachment uploads with its sha256 shown. One changed byte on disk refuses the download and writes an audit row.
    - Approving with a failed server item returns 400 listing the items. Backup and restore round-trips the blobs.

### r2-instrument-integration  (depends on: r2-raw-data, r2-api-v1)

Watch-folder agent, parser registry, mapping profiles with e-signed approval, review and accept screen, instrument usage log.

- **M21 Instrument data capture: watch folder, parsers, review and accept [G7+PLT-13 connector]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - A balance export dropped in the inbox creates one file row with the right sha256 within 15 s, and a duplicate is refused and audited.
    - Fixture CSVs give the expected rows (node:test). A malformed file gets parse_status=Failed with a readable UI message.
    - An overdue instrument is refused and a stale version returns 409. A sample with unaccepted imports cannot move to Pending Review.

### r2-api-v1  (depends on: —)

Scoped service tokens, /api/v1 with batch result ingestion and idempotency keys, OpenAPI 3.1 generated from Zod, problem+json errors.

- **M22 Machine integration API v1 with scoped tokens and OpenAPI [PLT-12]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - 500 results in one call, and replaying the Idempotency-Key creates no new rows.
    - A results:write token calling any signing endpoint returns 403, and a revoked token returns 401.
    - openapi.json validates and the docs page loads offline.

### r2-events  (depends on: —)

Transactional outbox, persistent per-user notifications, authenticated sockets with rooms, signed webhooks, e-mail and file sinks.

- **M23 Events, persistent notifications, webhooks, authenticated sockets [PLT-14+UX-03 notifications+SEC-11 sockets]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - A rolled-back result produces no outbox row and no socket message.
    - A webhook returning 500 three times then 200 receives the event once with a valid HMAC and 4 attempts.
    - A user offline during an OOS sees it at next login. An unauthenticated socket is rejected, and 169.254.169.254 is refused.

### r2-ui-foundation  (depends on: —)

Hash router, shell extension registry, accessible primitives, DataGrid and list contract, entity pickers, task inbox, bench density, a11y lint. Takes over the R1 client-shell files.

- **M24 UI foundation: router, shell, accessible primitives, DataGrid, pickers, inbox, bench density [UX-03 router/inbox+UX-07+UX-09+UX-13]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - A pasted #/samples/SMP-2026-00001 opens that sample, and Back and reload keep the view.
    - Sort, filter and page survive reload. 50k samples render page 1 in under 1 s.
    - axe finds 0 serious violations on 8 key screens. Every modal traps focus and returns it.
    - A QA inbox excludes records the user entered. Export audits the user, filter, row count and sha256.

### r2-coa-reports  (depends on: r2-master-data)

One server-rendered controlled-document pipeline. Numbered, signed, re-issuable CoA. report_runs register, print log, amended-data markers.

- **M25 Controlled CoA and report engine [G5+QA-05+UX-05 server copy control]** — impact critical, effort L, fact-check: not fact-checked

  - Acceptance:
    - POST /coa for a sample in Testing returns 409. For Approved it returns a job and the stored sha256 equals pdf_sha256.
    - An OOS with a closed investigation shows 'Does not comply', and the PDF never contains 'ALL TESTS PASSED' while any flag is true.
    - Re-issue gives COA-…-v2 with the old row Superseded with a reason, in one transaction with the signature and audit. Two concurrent requests produce no number gaps or duplicates.
    - A one-byte change to the stored report fails /reports/runs/:id/verify.

### r2-oos-workflow  (depends on: r2-qms)

Phase I and II tasks, checklist templates, controlled retest, assignable cause, due dates and overdue alerts, deviation link.

- **M26 OOS/OOT investigation workflow per the FDA OOS guidance [QA-06 rest]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Closing as Invalidated without an assignable cause, a QA signature and a linked retest is rejected, and closing by the assignee is rejected.
    - A retest by the original analyst is refused, and the third retest on a plan limited to two is refused.
    - A Phase I investigation past its due date appears as overdue.

### r2-qms  (depends on: —)

One engine for deviation, CAPA, change control and audit finding. Per-type state machines, action tracking, effectiveness check, change-control gate on spec approval and role changes.

- **M27 QMS engine: deviation, CAPA, change control, audit findings [QA-10+QA-12 change control]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - A major deviation cannot close without a linked CAPA and a QA signature.
    - Two simultaneous creations yield distinct ids. A CAPA action past due is flagged overdue.
    - Approving a spec without an Approved change request returns 409 when the setting is on. Editing a Closed record returns 423.

### r2-docs-training  (depends on: r2-methods-calc)

Controlled SOP lifecycle, auto-assigned training on effective versions, qualification gate at result entry, derived software-trained flag.

- **M28 Controlled SOP/document lifecycle and training matrix with qualification gating [QA-08+QA-09]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - A version cannot become Effective without three distinct signatures and a QA role. Making v3 Effective supersedes v2 in the same transaction.
    - A 20 MB PDF uploads, and a tampered file fails the download with an audit row.
    - A user with an overdue mandatory assignment gets 403 QUALIFICATION_REQUIRED on result entry for that method.
    - Certifying a non-LIMS module no longer sets the global signing flag.

### r2-custody-labels  (depends on: r2-ui-foundation)

Receipt and condition, locations, containers and aliquots, hash-linked custody ledger, retain and disposal register, bwip-js labels, wedge-scanner lookup.

- **M29 Sample receipt, chain of custody, storage, aliquots, retain and labels/scanning [G8+G14+UX-08]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Begin Testing on an unreceived sample returns 400. Out-of-range receipt blocks testing until QA signs.
    - Aliquoting 5 mL from 20 mL creates a child and two ledger rows, the balance never goes negative, and UPDATE/DELETE on the ledger is refused.
    - Scanning a sample id anywhere opens it even if it is not in the loaded list, and an unknown code gives toast.error. A label reprint without a reason is refused.

### r2-reagents  (depends on: r2-methods-calc)

Item master, lots, quarantine to approved, in-use expiry, prepared solutions, consumption ledger, usage-to-result link and expiry block.

- **M30 Reagent, reference-standard and solution lifecycle with usage-to-result link [G6]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Saving a result that lists an expired or quarantined lot returns 400 naming the lot and date.
    - Opening a lot sets in_use_expiry, and a solution cannot expire after its parent.
    - reagent_transactions rejects UPDATE/DELETE. The lot traceback returns in under 1 s on 100k results.

### r2-stability  (depends on: r2-master-data, r2-methods-calc)

Approved protocols, ICH conditions, pull calendar with windows, auto-created pull samples, overdue and missed handling.

- **M31 Stability programme [G9 core]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - 8 months × 2 conditions generate 16 timepoints with correct dates across month ends and leap years.
    - A timepoint turns Due and Missed with no user action, including after the PC was off.
    - Pull creates a sample with its stability_timepoint_id and the plan's result rows. Editing an Approved protocol returns 403/409.

### r2-em  (depends on: r2-qms)

Sampling-point master, editable limit profiles, auto excursions, QA-controlled edits, adverse-trend rules, batch impact by room and date window.

- **M32 Environmental-monitoring programme [G10 full]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - A client-supplied status is rejected by .strict(), and an Analyst changing a count gets 403.
    - 3 consecutive alerts at a point are flagged as an adverse trend (fixture).
    - The batch dossier lists only EM results for the batch's rooms within its window.

### r2-worklists  (depends on: r2-methods-calc, r2-docs-training, r2-result-ui)

Worklists grouped by method and instrument, run-sequence CSV export, assignee enforcement, workload view.

- **M33 Worklists and batch runs [G11]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - Adding a result whose method the analyst lacks returns 400 naming the module.
    - After release, an item change without a reason is rejected and audited.
    - A non-assignee entering a result gets 403, and a 20-cell grid save yields 20 audit entries with a per-cell 409 on conflict.

### r2-tat-kpi  (depends on: r2-ui-foundation)

Priority and due date sidecar, business calendar, TAT and aging derived from the audit trail, role-based honest KPI tiles that drill through.

- **M34 Turnaround time and honest role-based KPIs [G13+UX-14]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - A Thursday 16:00 receipt with a 2-business-day SLA and a Fri-Sat weekend is due Monday (table test).
    - Tile counts equal the row totals of the linked list. Closing an OOS reduces Active OOS by one.
    - The TAT endpoint matches hand-computed on-time % and P90 on a 10-sample fixture.

### r2-audit-tamper  (depends on: —)

Signed audit-trail review and review-by-exception, HMAC-keyed chain, daily anchor files, clock guard, lims_app least-privilege role, release interlock.

- **M35 Audit-trail review workflow and tamper-evidence hardening [QA-07 rest+SEC-10]** — impact high, effort M, fact-check: not fact-checked

  - Acceptance:
    - As lims_app, update/delete on audit_trail and drop trigger fail with permission denied.
    - After rewriting and re-hashing the chain as owner, the anchor verify reports a mismatch.
    - Release returns 400 until an AUDIT_REVIEW covers the batch's rows, and a clock set back 10 minutes writes CLOCK_ANOMALY.

### r2-release  (depends on: —)

Signed manifest, start-up integrity check, QA-gated offline update, SBOM, Electron upgrade, silent installer test on Windows CI.

- **M36 Controlled release and update pipeline with integrity manifest [PLT-07+SEC-08 rest]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - The About box shows the version, git sha and 'integrity OK'. One changed byte in dist/server.cjs blocks start and logs the file.
    - An update from v0.1.0 to v0.2.0 via UNC share leaves a verified backup and a SOFTWARE_UPDATED row.
    - The Windows CI job fails if /api/ready does not answer within 60 s. npm audit --omit=dev passes or has a recorded waiver.

### r2-validation  (depends on: r2-ui-foundation)

Playwright-Electron flows, axe gate, RTM and OQ evidence generated from executed test ids, qualified-module registry, retirement of the shell OQ.

- **M37 Validation automation and validated-scope control [PLT-06 rest+UX-10+QA-14]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - Reverting the Login TOTP fix turns the flow test red.
    - Marking a module NotQualified makes its writes return 403 MODULE_NOT_QUALIFIED. Changing the flag needs a QA e-signature.
    - The RTM links every Critical/High URS to an executed test id.

## R3 Differentiators

Features the incumbents do not do well: native Arabic/RTL with locale-safe GxP formatting, SPC and OOT trending with shelf-life estimation, a zero-install embedded database with least-privilege roles, directory sign-on, archival, and global search at scale. Migration ranges: 0300 and up.

### r3-i18n  (depends on: r3-embedded-pg)

Arabic and English UI with logical CSS, bdi for identifiers, Gregorian Latin-digit timestamps, server-side language preference, Chromium printToPDF bilingual copies, dark mode tokens. Asks r3-embedded-pg to register print-service.cjs in main.cjs.

- **M38 Arabic/English UI with RTL, locale-safe GxP dates and numbers, bilingual controlled print [UX-06+UX-05 Arabic]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - Switching to Arabic flips the shell to RTL with no horizontal overflow at 1024 px and persists after restart.
    - Ids, batches and hashes stay left-to-right in Arabic text.
    - On an Arabic-locale Windows PC every date prints as e.g. '13 Oct 2026, 12:12:00 GMT+3'. grep toLocale returns 0 outside format.ts.

### r3-spc  (depends on: —)

I-MR and Levey-Jennings charts, Westgard and Nelson rules, Cpk, versioned signed baselines, OOT alerts, ICH Q1E shelf-life regression.

- **M39 SPC, OOT and stability shelf-life trending [UX-11+QA-06 OOT+G9 trend]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - A 30-point seeded series matches hand-calculated CL/UCL/LCL within 1e-6.
    - A point at 3.2σ is flagged as rule 1, with smoothing off. Unapproved samples are excluded by default.
    - A baseline change needs a reason and e-signature and creates a new version. The stability regression matches a reference calculation to 3 decimals.

### r3-embedded-pg  (depends on: —)

Bundled PostgreSQL 16 with initdb, supervised start and stop, two roles, UTC, loopback, free-disk guard.

- **M40 Zero-install embedded PostgreSQL with least-privilege roles [PLT-04]** — impact high, effort L, fact-check: not fact-checked

  - Acceptance:
    - On a clean Windows 11 VM with no PostgreSQL, install and first launch reach the login page with no database input.
    - Killing postgres.exe recovers within 15 s with no data loss, and quitting leaves no postgres.exe.
    - An existing PostgreSQL on 5432 does not conflict, and show timezone returns UTC.

### r3-directory  (depends on: —)

LDAPS bind with AD group-to-role mapping re-evaluated at each login, flagged break-glass account, e-signature validated against the directory.

- **M41 Windows directory (LDAP/AD) sign-on with group-to-role mapping [SEC-14]** — impact medium, effort L, fact-check: not fact-checked

  - Acceptance:
    - An AD user logs in with the mapped role, and removal from the group removes it at next login.
    - A disabled AD account is refused at login and at e-signature.
    - With LDAP unreachable only the break-glass account works and each use is logged.

### r3-periodic-archive  (depends on: —)

Periodic reviews (user access, instrument, specification, system), retention classes and legal hold, verifiable batch archive bundles, signed restore tests.

- **M42 Periodic review, retention, legal hold and batch archive [QA-13 rest+QA-03 access review]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - archiveBatch produces a bundle that passes verifyArchive, and one altered file fails it. Archived records return 423 on update.
    - A due user-access review shows on the QA dashboard, and completing it needs a signature.
    - A record class under legal hold cannot be flagged for purge.

### r3-search-perf  (depends on: —)

Ctrl+K role-filtered global search, lazy-loaded routes and heavy libraries, 100k-sample performance gate.

- **M43 Global search, code splitting and scale performance gate [UX-12+PLT-09 rest]** — impact medium, effort M, fact-check: not fact-checked

  - Acceptance:
    - First-load JS is at most 700 KB raw, and jspdf, xlsx and html5-qrcode load only on first use.
    - Search 'ibu' returns grouped hits in under 300 ms on 50k samples, and an Analyst never sees audit hits.
    - On the 100k seed, GET /samples p95 is under 300 ms, /dashboard under 500 ms, and event-loop lag under 100 ms.

## Defects found in the review

- VERIFIED. MFA bypass: the pre-MFA tempToken ({id,temp:true}, src/server/api.ts:2242) is accepted by requireAuth as a full 5-minute session, because .temp is only read at api.ts:2267 and 2303. A user holding only the password gets a Bearer token valid on every protected route.
- VERIFIED. isOOS vs isOos: the UI and API read r.isOOS (SampleDetail.tsx:241,252,402; Reports.tsx:236,241; api.ts:1521; types.ts:30) but the column is isOos. OOS results render PASS, the CoA says ALL TESTS PASSED, and /reports/metrics never shows a failure.
- VERIFIED. Spec approval writes the spec id into signatures.sample_id, which has an FK to samples (api.ts:2774, schema.ts:66). Same pattern at ELN (api.ts:299) and batch release (api.ts:642). By static reading, a fresh install cannot approve a spec and so cannot register a sample. Confirm it with an executed test.
- VERIFIED. The reagent dashboard counts use r.expirationDate, but the column is expiryDate (api.ts:1303-1304), so expired/active reagent counts are always 0.
- VERIFIED. Login.tsx:56 tests requireTotp while the server returns requiresTotp (api.ts:2243). A TOTP user falls through to onLogin(undefined) and 'undefined' is stored as the token. There is no MFA enrolment path.
- Sample transition never checks results or open OOS (api.ts:1889-1960). tests/security-controls.sh:34-41 approves a sample with zero results with HTTP 200. Batch release blocks only status==='Open' (api.ts:615-624), ignores results.is_oos and needs no Approved sample. PUT /oos/:id (api.ts:2594-2624) accepts any status and edits closed signed investigations.
- Result PUT has no role check and allows edits in Logged and Pending Review (api.ts:1796-1816). OOS is evaluated with parseFloat, so '<0.05' and 'ND' give NaN and '1,234.5' gives 1, with no USP 7.20 rounding (api.ts:1834-1838). OOS investigations are never created automatically.
- Failed e-signature counters and SignatureFailed audits are written inside the transaction that then throws, so they roll back (OOS close api.ts:2408-2411, spec approve api.ts:2742-2743). Calibrate, release, certify and notebook keep no counter at all.
- The e-signature lockout sets lockedAt=now+15min but login rejects any non-null lockedAt forever (api.ts:2217), and Admin unlock fires only on active false-to-true (api.ts:3003). A signing lockout becomes an indefinite login lockout. Three bad logins also deactivate a user (api.ts:2226), so anyone can lock out the only Admin.
- TOTP secrets are leaked: GET /api/training (api.ts:1054-1056) and GET /api/admin/users (api.ts:2975) return totpSecret, which is stored in plaintext (schema.ts:17). There is no replay protection on TOTP codes.
- Backup timestamp corruption: backup reads through default pg parsers (local-time Date) and restore inserts into naive timestamp columns, shifting signature and entry times by the machine's UTC offset. The schema also mixes defaultNow() in the PG session zone with drizzle's UTC reads. createBackup also throws RangeError near 512 MB of JSON.
- init-db.ts:20-26 never upgrades an existing schema and there is no migration journal, so any new column cannot reach an installed PC. node-cron is absent despite AGENTS.md section 4, so there are no scheduled jobs and Overdue training is never set.
- Any authenticated user can crash the server: non-string content/password at POST /samples/:id/notebook (api.ts:1741-1760), certify and adminWithPassword are unhandled rejections in Express 4. There is no error middleware or process handler.
- Fabricated data on GxP screens: dashboard trendData literals Jan-Apr (api.ts:1306-1313), Math.random heatmap padding (api.ts:2879-2891), canned transcription when no AI key (api.ts:77-80, preferred over spoken text at VoiceRecorder.tsx:99), batch-material defaults (coaStatus 'Verified Pass', potency 100.00 %) with verifiedBy equal to dispensedBy (api.ts:555-562).
- pdfWorker stamps 'Official (System Generated)' on any sample state and prints 'null - null' for text specs. Reports.tsx hard-codes the Approved watermark, lets the user pick it, and reads fields the API never returns (r.specification, e.recordId, o.openedAt, s.role). The audit PDF therefore prints blank record ids and every actor as 'System'.
- EM status uses viableCount>10 for every grade (api.ts:2501, 2675): a Grade A plate with 5 CFU passes. 'Action Level' is not styled by the UI. PUT /env-records lets anyone edit counts. The seed contradicts the rule (Grade D 15 and 22 CFU seeded Pass).
- Specification `version` is both the revision and the OCC counter (a spec edited once and approved shows v3). There is no author column, so no SoD. Spec PUT and approve and calibrate have no role check. Calibrate accepts any date string and reactivates Out of Service instruments (api.ts:2796-2827).
- The reagent receipt UI posts a password the strict schema rejects (Reagents.tsx:34 vs lims.ts:59-64), so every receipt returns 400. Even if accepted, the handler never verifies it (api.ts:2551-2568). The Instruments 'Log Cal' button never mounts its modal (Instruments.tsx:135).
- The SampleDetail save payload omits instrumentId and attachments (SampleDetail.tsx:152-156), so the calibration block is unreachable from the UI. express.json()'s 100 kb limit blocks base64 attachments. The 200 requests per 15 min per-IP limiter is one shared bucket on loopback and is spoofable via X-Forwarded-For (server.ts:18,30-35).
- The sample id is COUNT(*)+1 with no lock (api.ts:1568-1569, 1660-1665): concurrent registrations collide on the PK (HTTP 500) and the counter never resets per year. No UPDATE carries a version predicate (27 update().set() calls), contrary to AGENTS.md section 2.
- POST /audit/verify is registered twice and the unguarded one wins (api.ts:1979 vs 2028). /signatures/verify re-reads and re-hashes the whole audit table on every click (api.ts:2108-2124). Signatures with contentHash 'N/A' verify as valid. SampleDetail.tsx:689 and OOS 'Verify Seal' show a green banner for any 200 response.
- Dashboard.tsx:20-25 and Reagents.tsx:18-22 skip res.ok and there is no ErrorBoundary, so an expired token white-screens the app. Layout.tsx:36 posts to a logout route that does not exist, and AdminPanel posts to a missing /api/admin/broadcast.
- Production start mode is insecure: `npm start` has no NODE_ENV, so the dev middleware and the public JWT secret 'dev-only-insecure-jwt-secret' are used and HOST defaults to 0.0.0.0. express.static serves server.cjs and server.cjs.map unauthenticated. Sockets are unauthenticated and OOS notifications are broadcast to all of them before commit (api.ts:1848-1857).

## Deferred / dropped

- Serial-port and ASTM instrument adapters, Windows-integrated Kerberos/SPNEGO sign-on, SAML/OIDC, and SCIM provisioning (deferred): a folder-and-CSV capture plus LDAP covers the single-site lab, and each adds a new external dependency to the validation scope.
- ERP/MES inbound and outbound beyond the file hand-off and the /v1 batch endpoints (deferred): no customer has asked for it yet, and the v1 API is the extension point.
- DataMatrix labels, silent printing to a named printer through an IPC channel, and ZPL output (deferred): bwip-js with window.print covers the first label release, and silent printing can be added later through the shell track.
- Levey-Jennings with QC materials is kept only as phase 2 of M39. Training quiz tables are dropped for now, since read-and-understood plus OJT signatures meet 211.25. Customer-specific CoA templates and a customer portal are deferred until customers exist (customers master data is in M17).
- Express 5 upgrade (dropped): the asyncHandler/route wrapper gives the same safety on Express 4 with less change risk. One-active-session-per-user and take-over (dropped): optional, and little value on shared bench PCs.
- Auto-update from the internet and cloud sync (rejected): the product stays offline-first and updates only through a QA-gated, signed, LAN or file-based path.
- AI features beyond opt-in, labelled, disableable drafts (deferred): AI is off by default, never in the calculation path, never populates regulated fields without human edit and signature, and no new AI features are planned until the egress control (M16) has been validated.
- Table partitioning and Redis/RabbitMQ as primary queue (dropped): Postgres-backed jobs and indexes suffice at lab scale. RabbitMQ stays optional via QUEUE_DRIVER=amqp.
- Removing the legacy 'N/A' signature rows (rejected): append-only rows are never rewritten. They are displayed as legacy-unverifiable.
- Conflict resolutions: migrations live in drizzle/ with a checksum runner (not desktop/migrations); the CoA engine is server jsPDF first, with Chromium bilingual print in R3 (Chromium output is not byte-deterministic, so the stored PDF and its sha256 are the record); attachments and PDFs are content-addressed files (not base64 columns), with backup v2 carrying a blob section; sessions use a server-side idle timeout with a hard cap of 12 h and /auth/reauth (no sliding-token header); login lockout and signing lockout are separate counters; OOS closure status is 'Closed' with a decision column (existing 'Approved' is mapped); the samples and results core tables are frozen and new features use sidecar tables.
