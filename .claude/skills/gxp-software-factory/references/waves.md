# Phase 2: Building in waves

Three roles that never mix: **tracks** build inside their own files, **one gate** integrates and proves, the **lead** (you)
coordinates, verifies and pushes. Templates: `assets/briefs/track-brief.md`, `gate-brief.md`, `report.schema.json`.
With a Workflow tool: `assets/workflows/release-waves.workflow.js`. Without one: one background agent per track.
Enter when `factory.cjs status` names a next wave. Parallel agents need permission: if the session allows agents only on request,
ask once, or build the tracks one after another yourself with the same briefs, ledger and gate (`references/judgement.md`, section 1).

## Run a wave

1. Generate the briefs; do not type them: `node scripts/make-briefs.cjs --release <name or number> --wave <n> --out <scratchpad>`.
   It writes `prompt-<track>.txt` with the track's database, port, migration range, the tracks beside it, what is merged, and the
   numbered acceptance criteria its report must answer. It refuses while the roadmap has errors or a project fact is missing.
   Launch all tracks of the wave in one message, each with the path of its brief.
2. While they work: do not touch the tree, do not commit. A stop hook will ask for a commit; answer in one line that the wave is
   mid-flight and the gate commits. Committing half-written work sends broken code to CI and collides with the agents.
3. Reports arrive as `report-<track>.json`. Read the table, not the prose, and hold it against the plan:
   `node scripts/factory.cjs exit wave --tracks <a,b> --reports <scratchpad>`. It runs `reports-digest.cjs` with the roadmap (a
   report is missing, a track is blocked, an acceptance criterion is unanswered, "met" names no test, "complete" hides an unmet
   criterion) and `ownership-audit.cjs` (a track edited a file that is not its own). Fix what it refuses before the gate: the gate
   may edit any file, so this is the last moment a foreign edit is visible.
   An agent that keeps reporting again (it wakes on its own background job) gets one message: stop and clean up.
4. A track that died on a usage limit is not lost: its work is in the tree. Resume the same agent id ("continue from where you
   stopped, partial work is in the tree, send exactly one final report"), or regenerate its brief with `--resume <track>`. Never
   restart a finished track. In a workflow script, remove merged waves before resuming or they run again.
5. Put the leftovers on the list before the gate, so the register is committed with the wave:
   `node scripts/open-items.cjs add-reports <scratchpad> --roadmap <roadmap>` (not done, unmet criteria, decisions for the user).
6. Generate the gate brief (`make-briefs.cjs ... --gate --reports <scratchpad>`; it carries the digest) and launch ONE gate agent.

## The gate

- **Apply patches, merge by hand, keep every addition.** Counters several tracks bump (signature meanings, permission counts, route
  counts asserted by upgrade tests) are **summed**: each patch's own number is wrong.
- **Regenerate derived files once, at the end** (schema export, permission matrix, route table).
- **Fresh database, every check**: lint and types with no new baseline error; full suite; migration suite and fresh-versus-upgraded
  schema; contract check; build and bundle budget; install, seed, start the built server, run the shared evidence scripts (give the
  backup tool the server's secrets, or it reports a false "chain broken"); desktop tests; traceability gate; root hygiene.
- **CI conditions locally**: new tests as an unprivileged user, on a non-C collation, with `localhost` resolving to `::1`.
- **Really packaged folder** for installer and integrity checks: run the real packager and verify its output. A manifest that
  passed every unit test stopped the first installed build, because the packager rewrites `package.json`.
- **`git status --ignored`**: `.gitignore` swallowed `scripts/release/` (rule `release/`) and `validation/build/` (rule `build/`).
- Never weaken an assertion. A test changed for a deliberate behaviour change is named in the gate record with the reason.
- Known debt goes behind a ratchet (`scripts/ratchet.cjs`): the list may shrink, never grow, and each entry names a deviation.
- Applied patches are deleted. A patch that is deferred on purpose stays, and goes on the list with its reason
  (`open-items.cjs add --kind not-done --source gate "<file> not applied: <why>"`).
- Temporary edits carry the marker `FACTORY-TEMP`; `precommit-guard.cjs` refuses a commit that still holds one, a focused or
  skipped test, a secret, or build output.
- Output: `<changes>/<wave>-gate.md` (merged by hand, fixes, evidence, what could differ in CI) and one commit. The gate does not push.

## The lead after a gate

`node scripts/factory.cjs exit gate` (tree clean, trailers present, gate record in the commit, no patch left unaccounted, nothing
temporary or secret committed, leftovers registered), then push (the session's branch; no pull request unless asked), then
Phase 3 (CI). Tell the user: built / numbers / not done / decisions for them / next. The not-done lines and the decisions come
from `open-items.cjs list`, in substance verbatim: they are the honest part of the delivery.
