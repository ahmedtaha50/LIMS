# r1-client-shell: client session layer (roadmap M06)

Release R1, fourth wave (with r1-esign, r1-authz). Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.

Status: **partial**. The three acceptance criteria of M06 are met and tested (data layer against the real server and PostgreSQL, behaviour in a real browser).
One sentence of the gap's GxP risk is not met, because it needs a server route this track does not own: *unlock* is audited (the server writes `AUTH_REAUTH`),
the *lock* is not (see "Not done", item 1). Everything else the design lists is delivered, with the limits under "Not done".

## What changed

| Area | Files |
|---|---|
| Session layer | `src/lib/api.ts` (new): `apiFetch`, typed `ApiError`, the session store (`sessionStore`, `useSessionState`), `sessionEvents`, `reauth`, `bootSession`, `signOut`, `authApi`, and `installSessionFetch` (the bridge for the existing `fetch()` calls) |
| Idle lock | `src/components/SessionGuard.tsx` (new): idle timer from `GET /auth/me`, 60 s warning, lock; `src/components/ReauthModal.tsx` (new): password and authenticator code, rendered over the mounted page |
| Containment | `src/components/ui/ErrorBoundary.tsx` (new): per-view boundary, inline "Session expired" state, full-page last resort |
| Screens | `src/components/Login.tsx` (rewritten: password, TOTP or recovery code, forced enrolment with QR code, recovery codes shown once), `src/components/ChangePassword.tsx` (new: the forced step) |
| Shell | `src/App.tsx` (session from `/auth/me`, no `atob`, no `'System User'`, one `ToastProvider`, boundary around every view), `src/main.tsx` (installs the bridge, root boundary), `src/components/Layout.tsx` (no static badges, page titles from the navigation, logout owned by App), `src/components/ui/Toast.tsx` (`toast.error/success/info`, stable function, `role=alert`, dismiss, errors stay 12 s), `src/index.css` (one rule for `[inert]`) |
| Tests | `tests/api/client-session.test.ts` (53, real app, real PostgreSQL, real HTTP), `tests/unit/client/static.test.ts` (27), `tests/unit/client/screens.test.ts` (22), `tests/client-shell.cjs` (61 checks in headless Chromium against the built bundle) |

Files outside the ownership list: **none** edited. `package.json` is untouched (no new dependency; see "Not done" item 6 for what a DOM test library would need).

## How other tracks use it

New or touched view code:

```ts
import { apiFetch, ApiError } from '../lib/api';

try {
  const rows = await apiFetch<Reagent[]>('/reagents');              // '/api' is added; '/api/reagents' also works
  setReagents(rows);
  await apiFetch(`/reagents/${id}`, { method: 'PUT', body: { ...fields, expectedVersion } });   // objects are sent as JSON
} catch (e) {
  toast.error(e instanceof ApiError ? e.message : 'Could not load reagents.');   // status, code, requestId, details, retryAfterSeconds are on e
}
```

* No `token` prop is needed any more. `apiFetch` sends the current token, waits while the screen is locked and handles the session codes below.
* `ApiError.code` is the server's stable code (`CONFLICT`, `VALIDATION_FAILED`, `PASSWORD_POLICY`, ...). Two codes come from this layer: `NETWORK_ERROR` (status 0) and `BAD_RESPONSE`;
  a non-JSON answer is `HTTP_<status>`.
* Options: `parse: 'text' | 'blob'`, `signal`, `replay: 'never'` (do not repeat this call after an unlock), `auth: false` (sign-in calls), `guard: false` (logout and re-authentication).
* `sessionEvents` (`window` in a browser): `session:locked`, `session:renewed`, `session:expired` (`detail.code`), `session:password-change-required`.

What the server answers and what the layer does (contract of `src/server/auth/requireAuth.ts`):

| Answer | Action |
|---|---|
| 401 `SESSION_IDLE` | not a logout: the screen locks, the call waits, the user re-enters the password (and the code), the call is repeated once with the new token |
| 401 `SESSION_EXPIRED`, `SESSION_REVOKED`, `INVALID_TOKEN`, `USER_INACTIVE`, `UNAUTHORIZED` | the session is over: `session:expired`, the views are replaced by the inline "Session expired" state, "Sign in again" |
| 403 `PASSWORD_CHANGE_REQUIRED` | `session:password-change-required`, the forced change-password screen |
| any other 401/403/4xx/5xx | untouched: an `ApiError` for the caller (a wrong signature password is a 401 and is **not** a lost session) |

**Re-authentication never re-signs anything.** A request whose JSON body contains `password`, `currentPassword`, `newPassword`, `totpCode`, `recoveryCode`, `meaningCode` or `signature`
(an e-signature, a certification, an administrator action), a `FormData`/`Blob` body, or a `Request` object is **not repeated** after an unlock. The caller receives 401 `RESUBMIT_REQUIRED`
("... The action was not carried out: check the form and submit it again.") and the user submits it again on purpose. `ElectronicSignatureModal` and the other callers already show the
`error` text, so the message appears in the signature dialog. Everything else that was refused only because the session was idle is repeated once.

### The existing `fetch()` calls (the bridge)

`installSessionFetch()` (called in `main.tsx` before the first render) replaces `window.fetch`. It only touches same-origin `/api/...` calls that carry **this session's own** token, and not the
sign-in routes, `reauth` or `logout`. For those it does what `apiFetch` does and still returns a `Response`, so each view's own error handling keeps working: an ended session returns the original
401, an idle one is held and then repeated, a call made while locked waits, and the current token is sent however old the one in the view's `token` prop is. The views receive a **stable** `token` prop
(`viewToken`, the token the session started this page with) because several have `useEffect(..., [token])`: a changing prop would reload them, and their half-typed forms with them, at every unlock.
This is the only way to give the acceptance criteria to `Dashboard.tsx` and `Reagents.tsx` without editing files this track does not own. As owners migrate a view to `apiFetch`, the bridge has
less to do; it can be deleted when the last `fetch('/api` has gone (`grep -rn "fetch('/api" src/components`).

## Behaviour of the controls

* **Idle lock.** Length from `GET /auth/me` (`session.idleTimeoutMinutes`, policy 5-120 min, default 15). The timer counts the user's activity (keys, pointer, touch, scroll); one minute before the
  limit a dialog with a countdown offers "Stay signed in"; at the limit the screen locks. After the warning starts, only the button counts (a mouse nudge does not hide it). The clock reads the real time at every
  tick and when the window becomes visible, so a laptop that slept past the deadline locks the moment it wakes.
* **The lock covers the page, it does not replace it.** `ReauthModal` is rendered over the application; the application sits in an `inert` wrapper (nothing behind it can take the focus, verified in the browser) under a blurred backdrop.
  Typed values, selections and scroll positions are exactly as they were. The focus returns to the field that had it. Unlock = `POST /auth/reauth`: same session id, the absolute limit is not extended, the idle clock restarts.
* **A locked screen sends nothing.** Requests made while locked wait (including background polls), so a page left locked cannot keep the server's idle clock alive. The server counts requests, not mouse movements, so while
  the user is active the guard sends `GET /auth/me` at most once a minute (at most every quarter of the timeout) to keep the two clocks in step; when the user is idle, or the screen is locked, it sends nothing and the server session runs out too.
* **A page reloaded after the idle limit** boots into the lock screen (the stored token is asked about with `/auth/me`, the server says `SESSION_IDLE`); one reloaded with a dead token goes to the sign-in screen with a notice.
* **Stale answers.** A request that was in flight when the user unlocked can still come back "idle". Its answer is recognised as stale (an unlock counter) and does not lock the screen again; it is repeated (or answered `RESUBMIT_REQUIRED`).
  This was found by the tests: without it, five parallel calls could leave the page locked again, with nobody to unlock it.
* **Sign-in.** One of three server answers (`authApi.login`): a session, `requiresTotp` (the old screen tested `requireTotp`, so a TOTP user fell through with the token `undefined`), or `requireTotpSetup` (QR code, setup key,
  first code, then the ten recovery codes, shown once, with a required "I have stored them" before continuing). A recovery code can replace the authenticator code. A sign-in answer without a real token is rejected before anything is stored.
  Failures are shown inline (`role=alert`) and as `toast.error`; an expired or spent challenge, or a locked account, returns to the password step.
* **Forced password change.** `mustChangePassword` (from sign-in or `/auth/me`) or a 403 `PASSWORD_CHANGE_REQUIRED` mid-session opens `ChangePassword`; the policy messages are the server's (a list for `PASSWORD_POLICY`); confirmation must match; then `/auth/me` is read again and the application opens.
* **Token.** `sessionStorage` (this window, gone when it closes), never `localStorage`; a key an older build wrote to `localStorage` is deleted. Every storage access is guarded (private window, blocked site data): the page then works from memory.
  The user is `GET /auth/me`, never decoded from the token (`atob` turned an Arabic name into mojibake after a reload, and the catch invented a 'System User').
* **Logout** sends the token (the old call did not, so the server session stayed alive) and says so if the server could not be told; the page is signed out either way.
* **Errors.** `ErrorBoundary` around every view (reset when the user opens another page) and around the whole application. A render crash shows what happened and a retry inside the shell; if the cause is an ended session it shows "Session expired" instead.

## Why (findings from `synth.topDefects` and M06)

"Dashboard.tsx:20-25 and Reagents.tsx:18-22 skip res.ok and there is no ErrorBoundary, so an expired token white-screens the app", "Layout.tsx:36 posts to a logout route that does not exist" (the route exists since r1-identity;
the call carried no token), "Login.tsx:56 tests requireTotp ... falls through to onLogin(undefined) and 'undefined' is stored as the token", "App.tsx:35 decodes the JWT with atob and the catch silently substitutes 'System User'",
"Static '21 CFR Part 11 Validated' badges are shown", and no idle lock, no re-authentication, no forced-change screen and no enrolment screen on the client (r1-identity's "Not done: client screens").

## Acceptance (M06)

| Criterion | Evidence |
|---|---|
| Expiring the token mid-edit shows ReauthModal, the typed value is still there, and the save then succeeds | `tests/client-shell.cjs` C1-C14 (browser): half-typed "Register Sample" form and a result correction with its reason; the session is made idle in the database; Save shows the dialog, the values are still in the inputs, a wrong password stays locked with an inline error, the right one unlocks, the save succeeds without retyping, exactly one sample / the new result value is in the database, the same server session continues, `AUTH_REAUTH` is in the security log. Data layer: `client-session.test.ts` "a write that was refused only because the session was idle is carried out once", the bridge twin, three calls in flight, stale answers |
| An invalid token shows an inline 'Session expired' state on Dashboard and Reagents, never a white screen | `client-shell.cjs` E1, E2: session revoked in the database under a mounted view; the shell stays, "Session expired" and "Sign in again" are shown, no uncaught exception, "Sign in again" reaches the sign-in screen and the dead token is gone from storage. E3: a view that throws for another reason shows a retry inside the shell, and opening another page resets it. On the old bundle the same steps give `Cannot read properties of undefined (reading 'map')` (Dashboard) and `r.filter is not a function` (Reagents) and a blank page |
| A TOTP user reaches the app with a real JWT (not the string 'undefined') | `client-shell.cjs` F1-F5 (wrong code shown, right code reaches the app, token is three base64url parts); `client-session.test.ts` "a TOTP user reaches the application with a real token", wrong code keeps the challenge usable, forced enrolment and recovery-code sign-in |

Also covered: forced password change (G), the client idle timer with a fake clock (D), an Arabic name after a reload (B), logout ends the server session (A9), no compliance badge (A4, H1), the old `localStorage` key removed (H2), a rejected stored token (H3).

## How to verify

```
export SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base>
npx vitest run tests/unit/client tests/api/client-session.test.ts        # 102 tests
npm run lint:web                                                          # clean
node scripts/typecheck-server.cjs                                         # "25 known error(s) in the baseline, none new"

# the browser acceptance run needs a built bundle, a server and a database made with the installer, with users and data
npx vite build --outDir /tmp/cs-dist --emptyOutDir
node scripts/build-server.cjs --outdir /tmp/cs-server
#   create a database, run `node /tmp/cs-server/init-db.cjs` (ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD), `DELETE FROM users`, `npx tsx scripts/dev/seed/index.ts`
DIST_DIR=/tmp/cs-dist HOST=127.0.0.1 PORT=3108 JWT_SECRET=<32+ chars> node --enable-source-maps /tmp/cs-server/server.cjs &
BASE_URL=http://127.0.0.1:3108 ADMIN_EMAIL=analyst1@gxp.com ADMIN_PASSWORD=password node tests/client-shell.cjs        # ONLY=C,E runs some scenarios; needs Playwright (see the file header)

# shared evidence, unchanged assertions (BASE as above)
BASE=http://127.0.0.1:3108/api tests/security-controls.sh        # 34 PASS
BASE=http://127.0.0.1:3108/api tests/backup-restore.sh           # 18 PASS (run from a tree that has dist-server/, drizzle/ and desktop/schema.sql)
```

## Evidence

* **Test first.** The static guards, the screen tests, the API tests and the browser script were written against the untouched client. First run: `tests/unit/client/static.test.ts` 15 of 23 then-existing tests **failed** (`atob`, `'System User'`, `localStorage`, raw `fetch` in App, Layout and Login,
  `requireTotp`, both badges, no error boundary, no `installSessionFetch`); a probe of the old `Layout` and `Login` printed `Validated badge present: true | ALCOA+ Compliant present: true | header is raw id: true` and `Login claims "Compliant": true`;
  the screen and API test files could not even be loaded (no module). The browser script against the **old production bundle** (same server, same database): **9 PASS, 21 FAIL**. Old behaviour seen: the token in `localStorage` and not in `sessionStorage`;
  "21 CFR Part 11 Validated" on screen; the header printing `specs`; Sign Out leaving the server session alive (`before: 1, after: 1`); no dialog at an idle session; no warning; Dashboard and Reagents throwing and leaving a blank page;
  a TOTP user never getting a code field; the forced change never shown; "21 CFR Part 11 Compliant Authentication" on the sign-in screen; no notice after a rejected token.
* **Green.** Unit 49 and API 53 tests; browser **61 PASS, 0 FAIL** (built bundle, seeded database, headless Chromium 141).
* **Mutation checks** on `src/lib/api.ts` (each must turn a test red, and did): stale "idle" answers lock again (2 tests), a request with a password is repeated (2), a locked screen still sends (2), session-ending codes not recognised (6), token also written to
  `localStorage` (1), a sign-in answer without a token accepted (1), the token not swapped at unlock (2), the bridge rewriting any bearer (1), the sign-in/logout routes guarded (1), `requiresTotp` ignored (4), logout without the Authorization header (18). Two of these first
  passed, which showed two tests that were not sensitive (a racy stale-answer test and a raw-logout test that never locked the client); both were rewritten to be deterministic and the mutations then failed them.
* **Shared checks** against the new bundle on a seeded database: `security-controls.sh` 34 PASS, 0 FAIL; `backup-restore.sh` 18 PASS, 0 FAIL.
* **Whole suite** in the shared tree: 737 pass, 46 fail. The 46 are in files of other tracks' in-flight work (`authz-*` 33, `route-contract` 4, `route-table` 1, `tests/upgrade/*` 8: new routes, schema and migrations not yet in `tests/route-table.json` / `desktop/schema.sql`);
  none of them imports a client file. All 102 tests of this track pass in the same run.
* A visual check of the lock dialog (with an inline error), the warning, the expired state, the forced change, the enrolment and the recovery codes in 1280 px screenshots.

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: the idle timer counts the user's activity and the keep-alive ping; the 60 s warning; re-authentication by password (and code or recovery code); credential-bearing requests are never repeated after an unlock;
a locked screen holds every request; token in `sessionStorage`; hard session end loses unsaved entries and the absolute limit is not announced; wording of the sign-in subtitle and the removal of the badges; sign-out proceeds locally if the server cannot be told;
recovery codes can be copied to the clipboard; a boot that cannot reach the server drops the token; the stable view token.

## Not done

1. **The lock is not audited.** Unlock is (`AUTH_REAUTH`, with the session id). A lock needs a lenient route such as `POST /api/auth/lock { reason }` (idle timer or manual) that writes an `AUTH_LOCK` security event (r1-identity / r1-audit, `routes/auth.ts`).
   `SessionGuard` would call it where it calls `lockSession('idle')` (two lines). A server-side idle lock (`SESSION_IDLE`) is not logged either (r1-identity's "not done"). Until then the gap between the last request and the `AUTH_REAUTH` is the only trace.
2. **Views still use `fetch()`** (21 files, 64 calls today); the bridge protects them, `apiFetch` is for new code. Most of them still ignore `res.ok` and keep the `token` prop. `Dashboard.tsx:40` still prints "21 CFR Part 11 Validated"; `Traceability.tsx:587` prints "ISO 14644 Validated".
3. **No voluntary account screen**: change password by choice, or set up an authenticator from inside a session (`/auth/totp-enroll`, `/auth/totp-confirm`, `/auth/recovery-codes` have no UI). With the policy `mfaRequired` off (the default) nobody can enrol; an Administrator turns it on and each user enrols at the next sign-in.
4. **The absolute session limit (12 h) is not announced**: the session ends under the user's hands and unsaved entries are lost (the inline state says so). A countdown banner from `session.expiresAt` is a small addition.
5. **Sockets** are still unauthenticated and keep toasting while the screen is locked (the toasts sit under the blurred backdrop); `Layout` opens the socket as before.
6. **No DOM test library** (jsdom, Testing Library) is installed and `package.json` is not this track's: screens are tested by server rendering and the behaviour by the Playwright script, which has to be run by hand (it needs the built bundle, a server and Chromium; it is not part of `npm test`).
   `@types/react` is not installed either (the web type-check passes because React is untyped), which is why `ErrorBoundary` declares `props` and `setState` itself.
7. The validation package (URS, OQ for the idle lock and re-authentication) was not edited and nothing was approved or signed.

## Needs from other tracks

1. r1-identity / r1-audit: the lock route above (`POST /api/auth/lock`, lenient auth, `AUTH_LOCK` security event, `reason: 'idle' | 'manual'`).
2. Owners of the 21 view files: move calls to `apiFetch`, drop the `token` prop, check the result (a list is never `setX(await res.json())` without `res.ok`); remove the Dashboard and Traceability badges.
3. r1-esign: nothing blocks. After an unlock a signature request answers `RESUBMIT_REQUIRED`; `ElectronicSignatureModal` shows the message and stays open (it shows any `error` text); a test for it in `esign-ui` would be welcome.
4. Wave gate: nothing to regenerate (no route or schema change). `tests/client-shell.cjs` is a hand-run check like `tests/desktop-shell.cjs`; add it to the OQ evidence if QA wants the idle lock covered.
