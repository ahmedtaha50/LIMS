# r1-logbook: logbooks of any kind, equipment and rooms, status (E06, E07, E21)

## Create any logbook (E21, the user's request)
- A logbook TYPE is data, not code: entry kinds, and fields of five kinds (text, number with unit and limits, date and time,
  choice, yes/no); optionally the status an entry kind sets and the field that sets the calibration due date.
  `server/logbook/definition.ts` validates a definition as strictly as any input (duplicate keys, min above max, a status
  set by a type that does not track status: refused with the reason).
- Versions: draft → (author signs "authored") in review → (QA signs "approved", a different person, checked on the server)
  effective; the previous effective version retires; one effective version per type is enforced by a unique index. QA can
  send a version back with a signed reason. Entries store the type version they were written with.
- Permissions: logbook.type.design (supervisor), logbook.type.approve (QA).
- Screens: `client/screens/logbook-types/`: the designer (entry kinds and fields, no JSON) and the QA approval.

## Logbooks and entries (E06)
- A logbook belongs to one object: equipment, room, area, instrument, process or other (unique code per kind); created from an
  effective type, changed with a reason and the version read, retired with a signature, never deleted.
- An entry is signed by its author ("performed") at the moment of writing; the signature names the entry. Entries are
  immutable (trigger); a correction is a new signed entry ("corrected") with a reason that points at the old one, and an
  entry can be corrected once (correct the correction after that).
- Values are checked on the server against the type version (E21#4): unknown fields refused, required ones enforced, a
  number outside its limits accepted but flagged, and then a comment is required.
- Export: `GET /api/logbooks/:id/export`, a PDF (`server/logbook/pdf.ts`, no dependency) with every entry, value, flag,
  comment, signer, meaning and time, and the SHA-256 of its content in the header and on each page.

## Status (E07)
- Derived from the entries, never stored (`server/logbook/status.ts`): the last entry that sets a status, then the clock:
  clean longer than the clean-hold time of that item → dirty; past the calibration due date → out of calibration.
  A status change by hand is an entry kind with a required reason, signed like every entry.
- Built-in types `equipment` and `room` (migration 0031) are definitions of the same kind as user types (checked by a test).

## Gate patch `docs/changes/r1-logbook.gate.patch`
- `server/identity/roles.ts` (r1-identity): the logbook permissions for each role.
- `client/api.ts` (r1-shell): errors keep the server's `details`, so the form can list what is wrong.
- `tests/e2e/support/server.mjs` (r1-shell): a supervisor, a QA account with a known authenticator secret, and one equipment
  and one room logbook per viewport.

## Evidence
- `tests/api/logbook.test.ts`: 16 passed (each acceptance criterion; the two-person rule with someone holding both
  permissions). Planted fault: flags switched off in the limit check → 2 tests failed; restored.
- `tests/e2e/logbook.spec.ts` (with the gate patch applied): 8 passed, tablet and desktop: a signed cleaning entry (wrong
  password refused first), a reading outside limits that needs a comment, a type designed by a supervisor and approved by
  QA in a second browser, and the 44 px targets.

## Not done / limits
- Status is computed when read (fine for hundreds of items); r3-scale measures the list with many logbooks.
- The PDF uses the standard Helvetica font: characters outside Latin-1 (Arabic) print as "?". An Arabic export needs an
  embedded font (open item, with the Arabic interface decision).
- The built-in equipment and room definitions are effective from installation: QA reviews them at IQ (a decision).
