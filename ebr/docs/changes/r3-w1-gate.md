# R3 wave 1 gate: r3-scale, r3-directory, r3-lims-link, r3-deploy

Built one after the other by the lead. The plan was corrected twice during the wave (the LIMS route file; the backup scripts
and `.dockerignore`), each committed on its own after the ownership audit found them.

## Merged
- Gate patches applied cleanly, in order: `r3-scale` (r1-core `db.ts`, r2-execution batch list by number), `r3-directory`
  (r1-identity `auth.ts` and `index.ts` with the directory sign-in, the signature check for directory users and the
  `bootstrapAdmin` that r3-deploy needs; `package.json` and lockfile for `ldapts`), `r3-deploy` (r1-core `main.ts`). Deleted.
- Derived files regenerated once: route table (62 routes), permission matrix (unchanged permissions).
- `package.json`: `test:perf`. `.github/workflows/ebr.yml`: the capacity test as an INFORMATIVE step (new check; it becomes
  blocking once seen green on the runner), and a `compose` job: `docker compose up --build` on a clean runner, health, and
  the bootstrap administrator signing in with `mustChangePassword: true`.

## Integration fixes
- `server/core/db.ts`: after r3-scale's fix the loss of a connection reached two listeners and was reported twice; r1-core's
  test (exactly one report) caught it. The same error is now reported once.
- `tests/api/batch.test.ts` (r2-execution): it needed a step type without a handler; since this wave every type has one.
  It now checks the same rule (a step that cannot be recorded is refused with the reason, never skipped) with a sample step
  and no LIMS configured.
- `AGENTS.md` said "Drizzle ORM"; the code uses SQL through `pg` with no ORM. The manual is corrected (the code was right).

## Skill found wanting (fixed in the skill, separate commit)
- `manual-check.cjs` read "Not used, do not add: ... (Firebase included)" as a claim that Firebase is used, and did not scan
  `client/`, so React looked unused. Both fixed, with drill cases (105 checks).

## Checks (fresh databases)
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 117 passed, 0 failed (19 files) |
| `npx playwright test` | 34 passed (tablet and desktop), built server |
| built server, empty database | 13 migrations; `/api/health` ok |
| `npm run test:perf` | PASS: 300 users, 1200 signed steps in the database, instance stopped halfway, step p95 162 ms |
| `manual-check.cjs` | the manual names nothing the code lacks |
| planted faults (tracks) | escaping of the LDAP user name removed; LIMS look-up before create removed; the connection listener removed: each caught |

## Not verified here (and why)
- `docker compose up`: no Docker daemon on this machine; the new CI job is its first run.
- The Windows service script: no Windows server; not run.
- The plant's directory and the real LIMS: tested against a real LDAP server started by the test and a stand-in LIMS.
  The LIMS of this repository does not yet offer the integration endpoints the contract needs.
