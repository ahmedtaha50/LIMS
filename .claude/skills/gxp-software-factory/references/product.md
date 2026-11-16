# Product completeness: what the user touches, not what the tests call

Distilled from the second project of this skill (an EBR and logbook web application, Arabic and English, tablets and
desktops, Docker or a Windows service). Its API was complete, tested on the real database and green in CI, and the user
still could not use it: seven functions had no screen, there was no data to try a batch with, and no page said how to start
it. The user's words were "انت بتهزر" ("you are kidding"). Green tests are not a product. Read this page before the gate of
any release with a user interface, and before saying "done" to a user who will try it themselves.

## 1. Every function a person can call has a screen

- Keep a route-table snapshot (`[{ method, path, permission }]`), regenerated once per gate as a derived file.
- `node scripts/screen-coverage.cjs --repo <project>` reads it and the screen sources; set `SCREENS` in
  `factory.config.json` (`routeTable`, `clientDir`, `exceptions`). `factory.cjs exit gate` runs it when `SCREENS` is set.
- A route no person calls (health, a list for other systems, a machine API) is an exception **with its reason**. An exception
  for a route that no longer exists is a finding.
- The test is cheap and the omission is expensive: put it in the first release that has a screen, not after the user notices.
- An end-to-end test per role walks the main path through the screens (the user's path, not the API's).

## 2. A decision that is the user's does not block the code

When the user says "implement all" (or "نفّذ الكل") about open decisions (session length, lockout, limits, a directory, a
language), each one becomes a **site setting**:
- a conservative default (the stricter choice), bounds checked on the server, a unit;
- a change is signed (password re-entered), carries a reason, and is written to the audit trail in the same transaction;
- a screen lists each setting with its value, its default and its last change;
- the open-items register keeps the decision as the plant's ("confirm the defaults"), so the code no longer waits for it.
Never invent the plant's value and present it as decided; the default is a proposal.

## 3. Built-in content is reviewed, not trusted

Definitions that ship with the product (logbook types, templates, roles) are data that a quality person must review before
use: mark them "needs review" at installation, refuse to use them until a QA signature, and show the review in a screen.

## 4. The user can try it in ten minutes

- **A run guide** (`README.md`): the commands to start it (Docker and the native service), the first sign-in, and a scenario
  that walks a whole record through every role. A test reads the guide and fails when it names a script, a file or a step
  that does not exist.
- **Demo data, through the real services**: one command creates accounts for every role, ready equipment, released
  materials and an approved recipe, with the demo accounts' own signatures, so the audit chain verifies. It refuses a
  database that holds anything (demo data never mixes with real records), and its password comes from a variable, never
  from the code. Run it in CI inside the delivered container, as the guide says.
- **Both languages and directions** when the users need them: the English text is the key, every screen text goes through
  `t()`, a test reads the screens and fails on a missing translation or a visible text that bypasses the dictionary; logical
  layout classes (start/end, never left/right). Kit: `assets/kits/web-i18n/`. The language is the user's preference, stored on
  the server: a shared tablet changes hands.
- Touch targets of 44 px on the tablet viewport, keyboard order that follows the screen, the same tests at the tablet and the
  desktop viewport.

## 5. The validation package follows the roadmap while it is ahead of the code

The requirements are the roadmap's acceptance criteria (kit `assets/kits/validation-roadmap/`). When a release is planned and
not yet built, its rows are `GAP` under ONE open deviation ("Release R5 is planned and not yet built"); the gate stays green
and honest. The deviation is closed, with the evidence named, when the release's tests pass. The summary report's
conclusion is computed from the open deviations, never typed.

## Exit: before "done" to a user who will try it

- `screen-coverage.cjs` passes (or `SCREENS` is set and `exit gate` shows it PASS);
- the run guide's test passes, and the demo data ran inside the delivered container in CI;
- every open decision is either a setting with its default or a named item in the register;
- you say what the user will see first, the accounts to sign in with, and what has not been tried on their machine.
