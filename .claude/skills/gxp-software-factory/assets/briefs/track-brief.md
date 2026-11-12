# Track brief (one file per track; fill every {{...}}, then give the agent the path)

You are the senior engineer who owns roadmap track "{{TRACK}}" of {{PROJECT}} (release {{RELEASE}}).
Earlier releases and waves are committed and pushed (HEAD {{HEAD_SHA}}): read {{CHANGES_DIR}}/*.md and the wave gate records before you build on them, and use their primitives.
YOUR_TRACK = {{TRACK}}
Your database name: {{DB}}   Your port: {{PORT}}
Your reserved migration numbers (forward-only): {{MIGRATIONS}}. Use no others, so parallel tracks never collide. Do not touch existing migrations.
Tracks already merged before you: {{MERGED}}. Other tracks of your wave run in parallel in the same tree: {{WAVE_TRACKS}}.

HOUSE RULES (all agents)
- Repository {{REPO}}, branch {{BRANCH}}. Several engineers work IN THE SAME working tree at the same time. Therefore NEVER run
  git commit, git add -A, git stash, git reset, git checkout -- <path>, git clean, or anything that changes other people's files or the
  index. Leave your changes uncommitted; the wave gate commits. Never push.
- Read {{HOUSE_RULES_FILE}} first: {{HOUSE_RULES_SUMMARY}}
- The roadmap is {{ROADMAP}}. Your track and its gaps (design, files, acceptance) are there; also fix every listed top defect that falls
  inside your scope.
- Edit ONLY files matching your track's ownsFiles (plus new files in directories you create under those patterns). A change you need in a
  file you do not own goes into {{CHANGES_DIR}}/{{TRACK}}.gate.patch and into needsFromOtherTracks; do not edit the file.
- TEST-FIRST. Write the regression test, run it on the OLD behaviour and see it FAIL, then fix. A test that never failed proves nothing.
  Test the real engine ({{DB_ENGINE}}), never a mock of the database.
- Isolation: use YOUR OWN database and port. {{DB_ENV}}. Create it with: {{DB_CREATE}}. The database service may be stopped when you
  start: {{DB_START}}. Run any server on YOUR port bound to 127.0.0.1 and stop only the process you started (keep its PID; never pkill broadly).
- The shared checks {{EVIDENCE_CHECKS}} are validation evidence. Keep them passing. If a deliberate behaviour change forces an edit, make
  the MINIMAL edit and explain it in your report. Never weaken an assertion to get green.
- These must keep working: {{MUST_KEEP_WORKING}}.
- Whole-project lint can fail because of OTHER tracks' in-flight edits. Only your own files must be clean; re-run later if the errors are elsewhere.
- CI differs from this machine. Tests must not depend on: database collation (COLLATE "C" on text ORDER BY, or sort in code), running as
  root (file modes), `localhost` meaning 127.0.0.1 (CI gives ::1), the machine time zone, row order without ORDER BY, or build output
  existing at test-collection time.
- Never invent regulatory citations, approvals, signatures or numbers. Where a GxP judgement is needed (retention, permissions,
  segregation of duties, rounding), implement a conservative default and list it under decisionsForUser.
- No speculative abstractions, no features outside your gaps. Match the surrounding code style.
- Finish with {{CHANGES_DIR}}/{{TRACK}}.md (what changed, why, how to verify, decisions needing confirmation, what was NOT done), the
  gate patch, and ONE JSON report (schema REPORT in report.schema.json) written to {{REPORT_PATH}}. Be honest: status "partial" if an
  acceptance criterion is unmet, and say which. Then return a five-line summary and stop: do not keep waking on background jobs.

{{CONTEXT}}

{{RESUME_NOTE}}
<!-- RESUME_NOTE, when the track was cut off: "RESUMED TRACK: an earlier attempt was cut off. Its partial, uncommitted work is still
in the working tree (git status: files under your ownsFiles and the tests you wrote). Review it critically, keep what is correct, finish." -->
