# r3-search-perf (roadmap M43): global search, code splitting, scale gate

## What changed

* **GET /api/search?q=&limit=&types=** (`src/server/routes/search.ts`). Groups: samples, batches, products, specifications, methods, SOPs, documents, users. A group is searched only when the caller's role holds the permission that opens the same records elsewhere (sample.view, master.view, spec.view, method.view, doc.view, admin.users.view); a group the role may not read is absent from the answer. Audit trail, security log and admin data are not searched. A read: no audit entry. Minimum 3 characters (trigram), strict query schema, at most 20 hits per group, `more` flag, hits ranked "starts with" first then newest.
* **Migration 0340_global_search**: `search_norm(text)` (IMMUTABLE; lower case, Arabic diacritics and tatweel removed, alef/yeh/heh/kaf variants folded, Arabic-Indic and Persian digits to 0-9; ASCII fast path) and six GIN trigram indexes. `CREATE EXTENSION pg_trgm` is attempted in a DO block; if the extension is unavailable the indexes are skipped, the search still works on a scan and the answer says `indexed: false`. Both sides of every comparison go through `search_norm` in SQL, so no JS/SQL drift and no dependence on collation or locale.
* **Ctrl+K palette** (`src/components/CommandPalette.tsx`, mounted from `src/App.tsx`): combobox/listbox in the shared Modal, debounce, abort of stale requests, grouped results, arrow keys + Enter + Esc, visible states for searching / no result / failure. Loaded as its own chunk on first use; a failed load is a toast.
* **Code splitting**: all 14 screens in `App.tsx` are `React.lazy` with a chunk-error boundary (Retry / Reload); `vite.config.ts` `manualChunks` (react, zod, charts, pdf, scanner) and the preload-helper fix (it otherwise dragged the 800 KB PDF chunk into the entry).
* **tests/perf**: `search.test.ts` (functional: permissions per role incl. revocation, Arabic, wildcards, limits, ranking, no audit write, EXPLAIN uses every index), `search-fallback.test.ts` (no indexes), `scale.test.ts` (opt-in seed + p95 gate), `seed.ts`, `bundle.cjs` + `bundle.test.ts` (first-load budget).

## Bundle (raw bytes)

| | before | after (App.tsx + vite.config + gate patch) |
|---|---|---|
| main entry script | 2,694 KB (752 KB gzip) | 352 KB with its static imports |
| first load (entry + Samples screen) | about 2,880 KB | 644 KB (budget 700) |
| PDF stack, charts, QR decoder | in the entry | lazy (Reports 635 KB, vendor chunks) |

With only the files this track owns (App.tsx, vite.config.ts) the entry is 753 KB and Samples 451 KB (the QR decoder is statically imported by `BarcodeScanner`, and `shell/ext/*.tsx` import their screens eagerly): the 700 KB budget needs the gate patch (BarcodeScanner dynamic import; the 15 ext files lazy).

## Performance (PostgreSQL 16, in-process app, real data; p95 of 30 requests)

| | 50k samples / 200k results / 200k audit | 100k / 400k / 1M audit |
|---|---|---|
| GET /search?q=ibu | 23 ms | 35 ms |
| search 'tab' (a third of all samples match) | 208 ms | 214 ms |
| GET /samples | 11 ms | 10 ms |
| GET /dashboard | 70 ms | 100 ms |
| event-loop delay p99 | 11 ms | 11 ms |
| GET /lists/samples?q=ibu (with gate patch to lookup.ts) | 33 ms (was 233 ms with ILIKE) | 373 ms (planner-dependent) |

/samples and /dashboard already met the budget (the findMany-then-filter cost named in the roadmap is no longer present at HEAD); nothing was changed there. Reproduce: `PERF_SAMPLES=100000 PERF_AUDIT=1000000 npx vitest run tests/perf/scale.test.ts` (PERF_SLACK=2 doubles budgets on slow machines).

## Verification

`npx vitest run tests/api tests/unit/core tests/upgrade/schema-drift.test.ts tests/perf` with the gate patch applied: 129 files passed, 1 failure fixed by the patch (qualified-modules core list needs `search`); `tests/unit` 36 files passed; `tsc` web, server typecheck baseline and eslint on my files clean; `xvfb-run -a node tests/desktop-upgrade.cjs` 8/8 and `tests/desktop-shell.cjs` 17/17 after `npm run build`. Tests failed on the old tree (route absent). `tests/security-controls.sh` and `backup-restore.sh` need a running seeded server and were not run (no step of them touches the new route; the migration is additive).

## For the gate

1. `git apply docs/changes/r3-search-perf.gate.patch` (route registry, route-table rule `GET /search: SELF()`, six `src/db/schema` index declarations that keep the drift test green, `lookup.ts` grid search on the index, BarcodeScanner dynamic import, 15 lazy ext screens, vitest include `tests/perf`, route-table.json, qualified-modules core list).
2. Regenerate `desktop/schema.sql` (`npx tsx src/server/boot/migrate-cli.ts export-schema`).
3. Without the patch applied, `tests/perf/search*.test.ts` and the schema drift test fail by design.

## Decisions for the user

* Search visibility uses the same permission as each list endpoint; users are searchable only with admin.users.view (Admin, QA). Confirm.
* Minimum 3 characters (trigram limit). Deactivated users appear marked "inactive" for those who may list users.
* Normalisation folds teh marbuta to heh and alef maksura to yeh (common search practice, lossy by design); Latin accents are not folded (r3-i18n can extend `search_norm` in a new migration).

## Not done

* No Ctrl+K hint button in the header (Layout.tsx is not owned).
* Instruments, reagents, OOS, ELN are not searched (the practical goals list eight kinds).
* Retry after a failed chunk cannot refetch for extension screens (browsers cache a failed module import): it offers Reload.
* pg_trgm presence in the embedded PostgreSQL was not verified; the fallback is tested by dropping the indexes.
* The dist hash/manifest coverage of the new chunks was not separately checked (chunks live under dist/assets as before).
* No browser run of the palette (typecheck, eslint jsx-a11y only).
