---
name: gxp-wave-delivery
description: How to build or extend a large regulated or multi-module software system (GxP / 21 CFR Part 11 / LIMS / QMS, but also any big codebase with a roadmap) by running several parallel agents in dependency waves, with one integration gate per wave, a commit and push per wave, and CI follow-up until an installer or release is green. Use this skill whenever the user asks to continue a roadmap or release (R1, R2, R3, "كمل", "ابدأ الموجة", "wave", "gate", "tracks"), wants a feature set built "like a team of senior engineers", asks to run parallel agents or a multi-agent build, wants a Windows installer built through GitHub Actions, or when a stop hook asks to commit while agents are still writing files. Also use it when moving the project to a new GitHub repo or when CI fails in a few seconds.
---

# Wave delivery for regulated software

This is the working method that took a GxP LIMS (React/Express/PostgreSQL, Electron installer) from an audit through three releases. It works because three things stay separate: **tracks** build, a **gate** integrates and proves, and the **lead** (you) only coordinates, verifies and pushes. Most failures in the project came from mixing those roles or from environment differences between the dev box and CI, so both are covered below.

Reply to the user in the language they write in (this project: Egyptian Arabic, short, no jargon walls). Start from what is done and what needs their decision; never bury a failure.

## 1. Plan: roadmap, tracks, waves

- Keep one roadmap file (`docs/roadmap/roadmap.json`) with releases → tracks. Each track has: name, gap ids, `ownsFiles` globs, dependencies, a reserved migration number range. Disjoint ownership is what lets agents run in parallel in one working tree.
- Group tracks into waves so that a track only depends on earlier waves. Shared-file edits (route registry, permission matrix, schema index, upgrade-test counts) do NOT go to the tracks; each track writes them into a `docs/changes/<track>.gate.patch` and the gate merges them.
- Give every track its own database name and port (`lims_<track>`, 3100+n) so parallel runs do not drop each other's databases.
- Write each track's brief into a file in the scratchpad and pass the agent a pointer to it (see `references/templates.md`). The brief repeats the house rules, so agents do not drift.

## 2. Run a wave

1. Launch all tracks of the wave in one message (background agents). Tell each: edit only owned files, test first (watch it fail on the old behaviour), real PostgreSQL not mocks, **no `git add`/`commit`/`stash`/`reset`**, write `docs/changes/<track>.md`, a gate patch, and one JSON report (status complete|partial|blocked, done, notDone, testEvidence, decisionsForUser, needsFromOtherTracks).
2. While they work, do not touch the tree and do not commit. Hooks will keep asking to commit; answer in one line that the wave is mid-flight and who will commit. Committing half-written work pushes broken code to CI and can collide with agents.
3. When a report arrives, read only the summary. Reports can arrive repeatedly from an agent that keeps waking on its own background job: acknowledge once, then message it to stop and clean up so it does not compete for the machine.
4. If an agent dies on a usage limit, it is not lost: its work is in the tree. After the reset, resume it with `SendMessage` (same agent id) and ask it to continue from where it stopped. Never restart finished tracks.

## 3. The gate

When every track has reported, launch ONE gate agent with the gate brief (`references/templates.md`). It applies the patches, merges conflicts by hand, regenerates derived files once, runs every check on a fresh database, and commits. The lead then verifies (`git log`, trailers, clean tree) and pushes. Details that matter:

- **Sum, don't pick.** Counters that several tracks bump (signature meanings, permissions, route counts in upgrade tests) must be recomputed from all additions; each patch's own number is wrong.
- **Regenerate once, at the end:** `desktop/schema.sql`, permission matrix, route table.
- **Gate checklist:** lint + typecheck (no new baseline errors), full test suite, upgrade/migration suite and fresh-vs-upgraded schema diff, API contract check, build + bundle budget, installer + seed, security-controls and backup-restore scripts (give the backup tool the same secrets as the server, or it reports a false "audit chain broken"), desktop/Electron tests under xvfb, traceability check, repo-root hygiene.
- **Test integrity/installer checks on a really packaged folder**, not on the source tree or a hand-made one: run the real packager (`electron-builder --linux dir`) and run the verifier on the result. A manifest that passed every unit test still stopped the first installed build, because the packager rewrites `package.json` and the build workflow never wrote a manifest.
- Never weaken an assertion to get green; if a test must change, say why in the gate record. Never fake RTM/validation rows; open a deviation instead.
- `.gitignore` can swallow new directories (`release/` also matched `scripts/release/`, `build/` matched `validation/build/`). After the gate run `git status --ignored` and look.

## 4. CI traps (passed locally, failed on GitHub)

The dev box is root, UTC-ish and uses a `C` collation; GitHub runners are none of those. Check for these before every push:

- Text `ORDER BY` depends on collation → `COLLATE "C"` or sort in JS. Test on an ICU en-US database.
- Tests that rely on being root (read-only files, `chmod`) → run the new tests as `nobody` with a writable HOME/TMPDIR.
- `localhost` resolves to `::1` on runners → use `127.0.0.1` or allow both.
- Code that runs at test **collection** time (inside `describe`) must not need build output like `dist/`.
- `spawnSync` of long commands blocks the test worker past its heartbeat → use async `spawn`.
- Time zone, locale and Node ICU digits → pin them in format tests, run under several TZ values.
- First-sign-in / "create if missing" races → take an advisory lock on the natural key inside the same transaction as the audit entry.
- Shared databases between parallel agents → separate names per agent, and never let two agents run whole-suite runs against the same template database.

## 5. After the push: watch CI

- List the runs for the branch; read job steps, not only the conclusion.
- **A job that fails in 3–5 seconds with no steps never started.** That is the GitHub account (Actions minutes, spending limit, private repo billing), not the code. Re-running does not help. Tell the user where to look (repo → Actions → red run banner; Settings → Billing → Usage) and the fastest fixes: make the repo public (free Actions; scan the repo and history for secrets first and tell the user what becomes visible) or raise the limit. A personal-account upgrade does not cover an Enterprise's organisations, and an Enterprise only covers repos inside its organisations.
- When it runs, give the user the release link and what is *not* in the installer.

## 6. Moving to another repository or account

- You cannot take access; the user must grant it (install the Claude GitHub app on the repo, reconnect GitHub on claude.ai). Never ask for tokens or passwords.
- Attach the repo with `add_repo` (push access). If a direct `git push` of the history to a new remote is blocked by the permission classifier, do not work around it and do not retry; offer the user two options: add a permission rule, or push themselves. A spoken "allow" does not change the classifier.
- If the user uploads a zip instead, extract it into a fresh directory, `diff -r` it against `git archive HEAD`, then commit it on a work branch of the attached clone. Say clearly that history stays in the old repo.

## 7. Honesty rules for regulated work

- Never invent signatures, approvals, regulatory citations or retention numbers. Ship conservative defaults, leave `approvedBy` blank, mark drafts as drafts (e.g. a machine-translated catalogue is a DRAFT for QA/linguistic review), and list every judgement call under *decisions for the user*.
- Report partial work as partial and say exactly what was not run: Windows, a real Active Directory, a browser pass, the full suite, items blocked on a vendor hash.
- Do not silently ship something broken: if an installer would contain no embedded database, the build must say so (warning plus clear runtime message), and the user must be told.

## 8. What to tell the user after each wave

Short, in their language: what was built (3–6 bullets), the test numbers (suite, security 34/34, backup 18/18, desktop scripts), what is not done or not tested, decisions only they can make, and what you are starting next. If CI is red or never started, say so first.
