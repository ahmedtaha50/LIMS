# R5 gate: the six decisions implemented

Built one after the other by the lead, in three waves (settings, built-in review, LIMS; yield, directory; interface). The plan
was corrected three times during the release (the directory route file, the language with the account, the R5 screens in
the interface track), each committed on its own before the work it covered.

## Decisions, as implemented (defaults the plant can change in Settings, signed and audited)
| Decision (open item) | Implemented |
|---|---|
| Arabic interface (OI-0004) | Arabic and English for every screen, per user, kept with the account (E26) |
| Session and lockout numbers (OI-0005) | 15 min idle, 12 h, 5 failures in 15 min, 30 min lock: site settings (E27) |
| Built-in logbook types at IQ (OI-0007) | not usable until QA reviews them with a signature (E28) |
| Yield limits per product (OI-0010) | per recipe version, approved with it; site default 95 to 102 % (E29) |
| LIMS endpoints and token (OI-0017, OI-0018) | the LIMS machine API v1 already offers them; the LIMS administrator issues the token (E30) |
| Directory settings (OI-0016) | entered in Settings with a connection test; the service password stays a server secret (E31) |

## Merged
- Gate patches: `server/identity/{roles,sessions,index}.ts`, `server/routes/auth.ts` (settings, directory),
  `server/logbook/service.ts`, `server/interlock/index.ts` (review check), `server/mbr/design.ts`,
  `server/materials/service.ts` (yield), `server/routes/lims.ts` (v1), the e2e seed, the setup of two API suites
  (`tests/helpers/builtin.ts`), `.github/workflows/ebr.yml` (the LIMS OpenAPI document triggers the workflow).
- Derived files regenerated: route table (69 routes), permission matrix (settings.read, settings.manage).
- Validation package: E26 to E31 moved from GAP to their tests; DEV-2026-11-16-08 closed.

## Found during the release
- The settings answer was read outside its transaction (old value shown): fixed, tested.
- The built-in review migration first marked nothing and the old tests still passed: a suspicious pass, found and fixed.
- A first yield rule forced the upper limit to 100 % or more; a product may end below 100 %: fixed by the test.
- The language switch first came before the user name in the keyboard order: an existing accessibility test caught it.

## Checks
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 165 passed (29 files) |
| Playwright | 38 passed: 34 English, 4 Arabic (tablet and desktop) |
| planted faults | fixed lockout number, missing review check, no idempotency key, recipe limits ignored, directory settings ignored, missing Arabic key, untranslated text: each caught |

## Not verified
- A live LIMS instance (the contract is checked against its OpenAPI document), the plant's directory, the Arabic wording by
  a native reviewer at the plant, and everything that needs the plant server (open deviations).
