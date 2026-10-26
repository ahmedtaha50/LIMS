# Change record: repository hygiene and shell/HTTP hardening (roadmap M02, M03)

| | |
|---|---|
| Record | Change record for track `r1-build-shell` (release R1). Reference number to be assigned by QA. |
| Gaps | M02 (repository hygiene, typed configuration, dependency cleanup, offline assets), M03 (desktop shell, server HTTP hardening, observability) |
| Status | **Implemented in the working tree, not approved, not released.** The approval block below is intentionally blank. |
| Baseline | Git tag `pre-r1` (commit `cc95dbb`), the last commit that still contains the removed files |
| Detail | `docs/changes/r1-build-shell.md` (what changed, how to verify, open decisions) |

## 1. Description of the change

1. 143 one-shot patch/fix scripts, five other root files (`clear-audit.ts`, `check-db.ts`, `fix-db.ts`, `bun.lock`, `firebase-applet-config.json`) and the unused Firebase and duplicate queue sources were removed from the repository. `scripts/check-root-clean.sh` fails the build when a script reappears at the root.
2. Firebase packages were removed from the dependency tree. (`xlsx` is still present: `Reports.tsx` imports it; see the detail record.)
3. Start-up configuration is read and validated in one place (`src/server/config.ts`). A malformed or missing required variable stops the server with one readable message. Production is the default mode; development has to be requested.
4. The server bundle moved from `dist/` (served to browsers) to `dist-server/`. Responses for `/server.cjs`, `/server.cjs.map` and the other bundles are 404.
5. HTTP layer: Content-Security-Policy on, no external hosts; fonts are bundled; the client address can no longer be chosen by the client; rate limits are per session and per e-mail address and answer JSON; `/api/health` and `/api/ready` were added; the server listens on 127.0.0.1 only.
6. Electron shell: supervised server process with restart and a rotating log; fixed port; the database-connection bridge exists only in the setup window and checks the caller; navigation is compared by exact origin; only the microphone/camera permission is granted, only to the local origin.
7. `tsconfig` was split. The server project is type-checked with `strictNullChecks`; known errors are listed in a baseline that may only shrink. `npm run lint` runs both projects.
8. The demo seed moved to `scripts/dev/seed/` (one file per domain); it refuses to run with `NODE_ENV=production`.
9. `AGENTS.md` now describes the authentication stack that actually exists (local accounts, signed bearer token, TOTP) instead of Firebase.

## 2. Reason and risk addressed

| Finding | Risk before | Reference |
|---|---|---|
| Root patch scripts, `clear-audit.ts` | Unattributed generation of regulated code; a script that deletes the audit table sat next to the product source | GX-14 (`docs/gxp-audit-findings.csv`), roadmap M02 |
| `npm start` without `NODE_ENV` | Development branch, public signing secret, listening on all interfaces: anyone on the LAN could forge an Administrator token | roadmap M03, top defect "Production start mode is insecure" |
| `express.static` over the folder that held `server.cjs` and its source map | Unauthenticated download of the complete server source | roadmap M03 |
| One shared 200 requests / 15 min bucket, `trust proxy` = 1, plain-text 429 | Brute-force limit bypassed by a header; 100 result saves lock every user out; the UI cannot parse the refusal | roadmap M03 |
| Electron: prefix match on the origin, unchecked IPC, bridge in the application window, no permission handler, silent server | A page script could repoint the application at another database; no log, no restart | roadmap M03 |
| No strict type checking | `r.expirationDate` and `r.isOOS` compiled and silently produced zero counts | roadmap M02 |
| Google-hosted fonts | Fails offline; usage leaks to a third party | roadmap M02, M03 |

Annex 11 s.12 (security) and s.17 (archiving/operation) are named by the roadmap for M03. This record makes no further regulatory claim.

## 3. Impact assessment

* **Validated state.** The two shared checks (`tests/security-controls.sh`, 34 checks; `tests/backup-restore.sh`, 12 checks) pass unchanged against the new bundle. The one edit to them is the path of the backup command line (`dist/` to `dist-server/`).
* **Installation qualification.** File locations and the shell changed: the Windows installer contents, the user-data folder (new `logs/` and a stored `port`) and the process tree (supervisor). IQ-W has to be re-executed on the target PC (DEV-06 of the validation package). The sandbox run in `validation/evidence/` names `dist/*.cjs`; it needs a refresh (`validation/build/collect-evidence.sh`).
* **Operational.** Anything that started `node dist/server.cjs` must start `node dist-server/server.cjs` (`npm start` does). A server install now needs `JWT_SECRET` and the four `SQL_*` variables; without them it refuses to start.
* **Data.** No schema, record or audit-trail change.
* **Rollback.** Check out tag `pre-r1` (all removed files are in it) and rebuild. The user-data additions (`logs/`, `port`) are ignored by the old shell.

## 4. Verification performed

See "How to verify" and "Evidence" in `docs/changes/r1-build-shell.md`: Vitest (`tests/unit/shell`), the two shared checks against the production bundle, a headless-browser run (no external request, no CSP violation), and a run of the real Electron shell under a virtual display (`tests/desktop-shell.cjs`, 17 checks).

## 5. Approval

Intentionally empty. No review, approval or signature has been given; this record must not be treated as approved until the fields below are completed by the responsible people in the quality system.

| Role | Name | Decision | Signature / date |
|---|---|---|---|
| Author | | | |
| System owner | | | |
| QA | | | |
