# R4 gate: r4-pdf, r4-mbr-copy, r4-harness, r4-windows

Built one after the other by the lead. Plan corrected once during the release (r4-pdf owns its fixture; E22#2 says how the
extracted text is checked), committed on its own.

## Merged
- Gate patches: `await textPdf` in `server/routes/logbook.ts` (r1-logbook) and `server/review/service.ts`
  (r2-review-release); `package.json` and lockfile (pdfkit, bidi-js, dejavu-fonts-ttf; development pdfjs-dist, @types/pdfkit).
- Derived files regenerated once: route table (63 routes); the permission matrix is unchanged.
- `.github/workflows/ebr.yml`: job `windows` (windows-latest = Windows Server 2025, PostgreSQL 16 from Chocolatey on port
  5433, the pinned WinSW, `deploy/windows/ci-check.ps1`).
- Validation package: R4 requirements moved from GAP to their tests; E24 and E19#2 to the CI evidence (another machine,
  under DEV-2026-11-16-02); DEV-2026-11-16-01, -04 and -07 CLOSED with their evidence; the VSR conclusion now lists the open
  deviations from the data instead of a fixed text.

## Found by CI (the first Windows runs), fixed
1. `"... $app: ..."`: PowerShell reads `$app:` as a drive-qualified variable; a parse error before anything ran. The R3
   script had never been run (no Windows, no PowerShell where it was written; installing PowerShell here was refused).
2. `psql <url> -c ...` on Windows ignores options after the address (warning, exit 0): the database was never created, the
   server died at start, WinSW restarted it every 11 s, and the install step only said "no health answer". Options first,
   `ON_ERROR_STOP`, the database checked; the install script now prints the end of the server's error log.
Both are rows of the failure catalogue of the skill.

## Checks
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 140 passed (23 files) before the final evidence run |
| Playwright | 34 passed (tablet and desktop), built server; the certified copy goes through the new writer |
| CI run 43872568098 | `test`, `compose`, `windows` all green, logs read: four `PASS E24#...` lines on Windows Server 2025 |
| planted faults | Arabic pieces not reversed; ActualText removed; copy audited against the source; global setup exiting 0: each caught |
| a rendered page | looked at: Arabic line right to left with ٧٠٪ and 12 in order; mixed line keeps "Mixer M-01:" first |

## Not verified
- The plant server (Docker or Windows service), the plant printer, scripts other than Latin and Arabic in PDFs.
- A copy button in the recipe designer (the API exists).
