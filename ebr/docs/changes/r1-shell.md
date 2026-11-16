# r1-shell: touch-first shell for tablet and desktop (E05)

- `client/`: React 19, Vite 7, Tailwind 4. UI primitives (`client/ui`) are at least 44 x 44 px with visible labels. Screens
  are folders `client/screens/<name>/index.tsx` exporting `screen`, found by `import.meta.glob`: later tracks add a folder.
  The shell shows a side list on wide screens and a bottom bar on a tablet. Sign-in screen with the authenticator code field.
- `client/api.ts`: the only way to the server; a request that does not arrive is the error "Nothing was saved", never queued.
- PWA: manifest and `sw.js`, which keeps only the application files and never touches `/api/`.
- `eslint.config.js`: jsx-a11y strict set as errors on every `.tsx` of the client.
- `playwright.config.ts`, `tests/e2e/`: the BUILT server on a fresh database, tablet 820x1180 (touch) and desktop 1440x900.

Gate patch `docs/changes/r1-shell.gate.patch` (files of r1-core): client dependencies and scripts in `package.json` and the
lockfile, `vite.config.ts` plugins, `server/app.ts` (serves the built client, page never cached, `/api` `no-store`, security
headers), `server/main.ts` (passes the client folder).

Evidence: lint (both TypeScript projects, accessibility lint) clean; Playwright 10 passed (5 tests x 2 viewports).
Planted faults: buttons made 32 px high failed the 44 px test at both viewports; a `div` with a click handler failed the
accessibility lint with 2 errors. Both restored.

Not done: the signed-in layout tests stand in for `/api/auth/me` (the sign-in API is r1-identity, wave 3); once it exists,
a test signs in for real. The interface is in English; Arabic (right to left) is not in the plan yet: a decision.
