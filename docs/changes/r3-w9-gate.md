# Wave gate R3 W9: Arabic / RTL interface and directory sign-on race fix

Release R3, wave W9. Tracks: r3-i18n (M38 Arabic/English interface, RTL, locale-safe formatting; own record `r3-i18n.md`) and a separate fix for the race
between two first directory sign-ins of one person (`src/server/auth/ldap.ts`, note in `r3-directory.md`). Both are committed together. Nothing here is a
review, approval or signature; no signing key was generated or committed. The Arabic catalogue is a machine-assisted DRAFT and needs QA and linguistic review.

## Gate edits

* `r3-i18n.gate.patch` applied with `git apply` against 1227ad5: it applied cleanly (nothing rejected, nothing merged by hand), then the patch file was
  deleted. It carried: schema export, route registry, route-table rule, both tsconfigs, `ui/Modal.tsx`, `ui/Toast.tsx`, `lib/utils.ts`, `lib/pdfUtils.ts`,
  the qualified-modules test, `desktop/schema.sql`, the `reports.ts` trend date.
* Regenerated at the end: `desktop/schema.sql` (through 0350), `docs/permission-matrix.csv` (113 permissions), `tests/route-table.json` (`GET/PUT /api/me/preferences`).
  All three came out byte-identical to what the patch had already applied (the patch was current).
* **`tests/unit/i18n/format.test.ts`**: the check that the old `toLocaleString('ar-SA')` printed Arabic-Indic digits now names the numbering system
  (`ar-SA-u-nu-arab`). Before, it depended on the CLDR default of the Node build running the test. The assertion itself is unchanged in meaning.
* **Licence in the package**: `public/licenses/OFL-Noto-Sans-Arabic.txt` (copy of `src/i18n/fonts/OFL-Noto-Sans-Arabic.txt`) so that `dist/licenses/` carries the
  SIL OFL text next to the font files in the installer (`files: dist/**`). Before, the text was in `src/` only, which the package does not contain.
  (The older Outfit and Plus Jakarta fonts are also OFL and have no licence text in `dist/`; not changed here, a decision for QA/release.)
* **Tests edited by the track, checked**: `tests/ui-foundation.cjs` only narrows two selectors (`main select >> nth=0` to `main label:has-text("State") select`),
  because the header now holds the language select; the checks and expected values are the same. `tests/a11y/baseline.json` drops the "quality management"
  `color-contrast` entry: the a11y run on the clean HEAD tree (1227ad5, 3 of 3 runs) already reports that entry as stale ("no longer occurs"), so the removal is
  honest and nothing was weakened. `tat-kpi-ui` pins `localizedError(err, 'dash.kpiFailed')` and `equipment-dashboard` pins the key `dash.trend.empty` plus its English text in `en.json` (the sentence moved from source to catalogue); same visible text is asserted.

## Gate evidence (fresh database `lims_gate`, C.UTF-8, server on 127.0.0.1:3190)

* `npm run lint`: web clean; server 18 known baseline errors, none new; eslint 0 errors, 67 warnings (none new).
* `npx vitest run` as root (JWT_SECRET and LIMS_MASTER_KEY unset): **172 files passed, 4 skipped; 2183 passed, 11 skipped, 0 failed, no unhandled error**
  (twice, the second after the test and licence edits above).
* New i18n, format, preferences, directory, qualified-modules, tat-kpi-ui, equipment-dashboard and ui-foundation tests as `nobody` (writable HOME and TMPDIR,
  writable copy of the tree): 278 passed, 2 skipped (bundle test, no `dist/`).
* `tests/upgrade` suite: 12 files, 63 passed. `dump-diff.sh`: fresh install and upgraded v0.1.0 identical (4898 lines of pg_dump, journal equal).
  `openapi-cli check`: current.
* `npm run build`; `tests/perf/bundle.test.ts`: **first load 696.3 KB (budget 700 KB), entry 405.1 KB, all JS 2874.9 KB.** W8 was 644.1 / 351.9 KB: this track
  adds 52 KB to the first load (both catalogues are in the entry). **Headroom is now 3.7 KB**; the next track that touches the entry will fail the budget unless
  the Arabic catalogue is loaded on demand. The three Arabic font files (49, 53, 50 KB woff2) are outside the first load.
* Installer `dist-server/init-db.cjs` to `0350_i18n_preferences` (31 append-only tables, 79 guard triggers); demo seed; production bundle:
  `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh` 18 PASS, 0 FAIL (server JWT_SECRET and LIMS_MASTER_KEY exported to both); no error-level
  log line. Smoke: `GET /api/me/preferences` gives `{"language":"en","digits":"latin","version":0}` for an analyst and 401 without a token.
* Desktop (Electron, xvfb): `desktop-upgrade` 8/0, `desktop-shell` 17/0, `desktop-integrity` 5/0, `desktop-embedded` 24/0.
  `npm run test:installer` 27/27. `node validation/build/check.cjs`: 86 requirements, 74 Critical/High, all linked. `npm run check:root`: clean. The RTM was not touched.

## Browser run (`node tests/e2e/run.cjs --only client-shell,ui-foundation,a11y`, works here)

Three runs on this tree: 132 PASS, 5 KNOWN each time; a11y alone twice: 28 PASS, 0 FAIL. Failures that appeared, all intermittent and none caused by this track
(the same run on a clean worktree of HEAD 1227ad5 shows them too):

* `client-shell A5` is listed in `known-failures.json` but passed in 5 of 6 runs (3 on this tree, 2 on HEAD, then the removal run) (the entry says it is a race in the script). I removed the entry once, a
  later run failed A5, and I **restored the entry unchanged**. It stays a coin flip; the owner of the script (DEV-2026-10-25-07) should fix the wait.
* `a11y reports` `color-contrast` (`.border-slate-100 > p`, the empty-state placeholder) appears only after the other flows have created data (HEAD: 1 of 2 combined
  runs; this tree: 3 of 3 combined runs, 0 of 2 standalone a11y runs). `a11y OOS` `button-name` was absent in one run. Baselines for these were **not** changed because the runs do not prove them gone.

## CI traps checked

* **Timezone and locale**: `tests/unit/i18n` and `tests/api/i18n-preferences.test.ts` (154 tests) pass with `TZ` set to UTC, America/Los_Angeles, Pacific/Kiritimati,
  Asia/Riyadh and Asia/Kolkata, each with `LANG`/`LC_ALL` `en_US.UTF-8` and `ar_SA.UTF-8`. The format tests pass an explicit `timeZone` or set `process.env.TZ` and
  restore it; `formatDate` for bare dates is checked under three zones. Node is v22.22 with full ICU 77; the one test that read ICU data for Arabic digits now names
  the numbering system (see above). A Node build with `small-icu` was not available to test.
* **Collation**: the i18n/directory/qualified-modules/tat/equipment/ui-lists/ui-lookup tests (249) also pass on a second PostgreSQL 16 cluster initialised with ICU
  `en-US` as default provider (the cluster was removed afterwards). `en_US.UTF-8` libc is not installed on this box, so the exact CI collation was not run.
  The preferences code orders nothing by text.
* **Root**: the new tests pass as `nobody`, with and without `dist/`. **Loopback**: no `localhost` in the new tests or sources (127.0.0.1 only).
* **Directory race**: `ldap.ts` takes `pg_advisory_xact_lock(hashtextextended('directory-account:' + externalId, 0))` at the start of `syncAccount`; the new test
  (many concurrent first sign-ins, several people at once: one account and one Create audit entry each) passes as root, as `nobody` and on the ICU cluster. The old
  23505 retry stays for a different person taking the same e-mail. The advisory lock is a PostgreSQL 16 built-in; the embedded database uses the same.

## Font, CSP, packaging, offline

* Noto Sans Arabic 400/600/700 (Arabic subset woff2, 152 KB), SIL OFL 1.1, text in `src/i18n/fonts/OFL-Noto-Sans-Arabic.txt` and now also in `dist/licenses/`.
* `@font-face` uses relative `url(./...)`; vite emits the files to `dist/assets/` and the CSS points at `/assets/...` (checked in the built CSS, no `http`
  anywhere in `noto-sans-arabic.css` or `index.css`). `unicode-range` means an English session never fetches them. Served by the production server: `200`.
* CSP of the server: `font-src 'self' data:` and `default-src 'self'`: the font loads, no CDN. electron-builder `files` contains `dist/**` and `desktop/**`; the
  fonts are inside `dist/assets`. `asar` is false. The desktop shell/embedded tests (which load `dist/`) pass.
* Not done: a screenshot of Arabic rendering inside the packaged Electron app (no `electron-builder` package was built here).

## Not done at this gate

* No visual review of Arabic layout in a browser beyond the e2e scripts; Arabic wording is unreviewed. No translation of PDFs (they stay English, see `r3-i18n.md`).
* No requirements-traceability rows or OQ/PQ for the interface language; QA must add them. Decisions for the user are listed in `r3-i18n.md`.
