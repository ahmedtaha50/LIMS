# Phase 2: Building in waves

Three roles that never mix: **tracks** build inside their own files, **one gate** integrates and proves, the **lead** (you)
coordinates, verifies and pushes. Templates: `assets/briefs/track-brief.md`, `gate-brief.md`, `report.schema.json`.
With a Workflow tool: `assets/workflows/release-waves.workflow.js`. Without one: one background agent per track.

## Run a wave

1. Take the wave from `roadmap-lint.cjs` (tracks, database, port, migrations). Fill one brief per track; write it to a file in the
   scratchpad and give the agent the path. Launch all tracks of the wave in one message.
2. While they work: do not touch the tree, do not commit. A stop hook will ask for a commit; answer in one line that the wave is
   mid-flight and the gate commits. Committing half-written work sends broken code to CI and collides with the agents.
3. Reports arrive as `report-<track>.json`. Read the table, not the prose:
   `node scripts/reports-digest.cjs <scratchpad> --expect <tracks>`. It refuses to call the wave ready while a report is missing or
   a track is blocked. An agent that keeps reporting again (it wakes on its own background job) gets one message: stop and clean up.
4. A track that died on a usage limit is not lost: its work is in the tree. Resume the same agent id ("continue from where you
   stopped, partial work is in the tree, send exactly one final report"). Never restart a finished track. In a workflow script,
   remove merged waves before resuming or they run again.
5. Launch ONE gate agent with the gate brief and `reports-digest.cjs --for-gate` pasted in.

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
- Output: `<changes>/<wave>-gate.md` (merged by hand, fixes, evidence, what could differ in CI) and one commit. The gate does not push.

## The lead after a gate

`git log --oneline -2`, trailers present, `git status --short` empty, then push (the session's branch; no pull request unless asked),
then Phase 3 (CI). Tell the user: built / numbers / not done / decisions for them / next. `notDone` and `decisionsForUser` from the
reports go to the user verbatim in substance: they are the honest part of the delivery.
