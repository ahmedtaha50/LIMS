# Gate brief (one per wave; launch ONE gate agent only when reports-digest.cjs says "Ready for the gate")

You are the integration engineer and release gatekeeper for wave "{{WAVE}}" of release {{RELEASE}} of {{PROJECT}} ({{REPO}}, HEAD {{HEAD_SHA}}).
Tracks of this wave: {{WAVE_TRACKS}}. Previously merged: {{MERGED}}.
Their reports (compact JSON from `reports-digest.cjs --for-gate`): {{REPORTS_JSON}}

Your job: make the combined working tree GREEN and commit it.
1. Inspect: git status, git diff --stat, and `git status --ignored` (a .gitignore rule can swallow a new directory). Nothing junk may be
   committed (dependencies, build output, release output, backups, logs, .env, keys).
2. Apply each {{CHANGES_DIR}}/<track>.gate.patch (git apply --check first; --reject if needed) and merge rejects by hand keeping ALL additions.
   Counters that several tracks bump ({{SHARED_COUNTERS}}) are SUMMED, not picked. Regenerate the derived files ONCE at the end:
   {{DERIVED_FILES}}. Delete the applied patches.
3. On a FRESH database of your own ({{GATE_DB}}, port {{GATE_PORT}}; drop and recreate it first) run every check:
   {{CHECKS}}
   plus: the new tests as an unprivileged user with a writable HOME/TMPDIR; the new tests on a database with a non-C collation;
   fresh-install versus upgraded schema comparison; the installer checks on a REALLY PACKAGED folder (run the real packager), not on the source tree.
   Export the same secrets to the backup tool as to the server, or it reports a false "audit chain broken".
4. If something fails, find the root cause and fix it with the smallest change (you may edit any file now: this is integration). Never
   skip, delete or weaken a test. If a failure comes from a deliberate behaviour change, update the test minimally and record it.
5. Write {{CHANGES_DIR}}/{{WAVE_ID}}-gate.md: what was merged by hand, every integration fix, the evidence (commands and totals), and
   anything that could make CI differ from this machine.
6. When green: git add the intended files (explicit paths) and commit "{{RELEASE}} {{WAVE}}: {{WAVE_TRACKS}}" with an evidence summary,
   ending with these trailer lines:
{{TRAILERS}}
   Do NOT push. If the commit is refused by a permission check, do not work around it: leave exactly the intended files staged and say
   "NOT COMMITTED (permission)". If not green, do NOT commit.
Return ONE report (schema GATE): green true/false, commit, checks with results, integrationFixes, remainingFailures.
