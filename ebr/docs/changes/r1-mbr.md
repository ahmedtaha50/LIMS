# r1-mbr: master batch record designer, versions and QA approval (E08, E09)

## Design (E08)
- `server/mbr/design.ts`: a recipe is a batch size and phases of steps of eight types: instruction, recorded value (unit,
  limits, decimals), signature, step verified by a second person, calculation, material (code, quantity, unit, tolerance),
  equipment or room, sample (test, quantity). Any step can be marked critical.
- Checked when saved (E08#2): unique keys, a lower limit above the upper one, limits without a unit, and every reference of
  a calculation: it must name a recorded value or calculation that comes BEFORE it (the order of steps is part of the check).
- `server/mbr/formula.ts`: formulas are parsed into a tree (numbers, step references, + - * / and brackets) and evaluated
  without `eval`; a division by zero or a missing value is an error, never Infinity. R2 uses the same evaluator on the server.
- Screen `client/screens/mbr/`: the designer (phases, typed steps, move up, remove) and the version actions; it is used on
  tablet and desktop (E08#3, Playwright at both viewports).

## Versions and approval (E09)
- `migrations/0040_mbr.sql`: masters and versions draft → in review → approved → effective → retired. A unique index keeps
  one effective version per master; a trigger keeps the design of any version that left draft unchanged, and refuses
  deletion, whatever the application does.
- The author signs "authored" to send a draft to review; QA signs "approved" (a different person, checked on the server,
  also for someone holding both roles); QA signs again to make it effective, which retires the previous effective version in
  the same transaction; QA can send a version back with a signed reason. A change to an effective recipe is a new draft
  based on it, with the history kept.
- Permissions: mbr.read (operator, supervisor, QA), mbr.design (supervisor), mbr.approve (QA).

## Gate patch `docs/changes/r1-mbr.gate.patch`
- `server/identity/roles.ts` (r1-identity): the MBR permissions. It touches the same lines as r1-logbook's patch: the gate
  merges both by hand.

## Evidence
- `tests/api/mbr-formula.test.ts`: the formula engine, including 2,000 random formulas compared with JavaScript arithmetic
  (seeded), and the design checks.
- `tests/api/mbr.test.ts`: the whole life of a recipe through the API, the two-person rule for someone holding both roles,
  edits and deletion refused in the database, one effective version enforced by the index, every step audited.
- `tests/e2e/mbr.spec.ts`: a supervisor designs a recipe at each viewport, the server refuses a formula naming a missing
  step, QA approves and makes it effective in a second browser.
- Totals: in the wave 4 gate record (the tests need the permissions of the gate patch).

## Not done
- A recipe cannot yet be copied into a new master (a new product starts empty).
- Step types are data now; executing them is R2 (r2-execution, r2-materials, r2-interlock).
