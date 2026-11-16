# r4-pdf: every character in exports and certified copies (E22)

The R3 writer (`server/logbook/pdf.ts`, Helvetica, no font embedded) printed `?` for every character outside ASCII: an
Arabic comment or an accented name was lost in the logbook export and in the batch certified copy.

- `server/pdf/writer.ts` (pdfkit, an embedded subset of DejaVu Sans from `dejavu-fonts-ttf`, `bidi-js`):
  - each line is put in visual order by the Unicode bidirectional algorithm (levels from bidi-js, rule L2 reordering,
    brackets mirrored in right-to-left runs); a right-to-left paragraph is right-aligned;
  - the font lays a string out right to left only when its FIRST character is Arabic script, so each run is cut into pieces
    that are all Arabic script or all not, and an Arabic piece is handed over in logical order (its letters join). Found by
    looking at the first render: a run starting with a space was not reversed, Arabic-Indic digits were (٧٠ printed ٠٧);
  - each line carries its stored text as ActualText (what a reader copies and searches); plain ASCII lines as a literal
    string, so English records stay searchable in the uncompressed file (the existing export and copy tests are unchanged).
- `server/logbook/pdf.ts` delegates to it. `textPdf` is now asynchronous.

Gate needs: `await` at the two callers, `server/routes/logbook.ts` (r1-logbook) and `server/review/service.ts`
(r2-review-release); `package.json` (pdfkit, bidi-js, dejavu-fonts-ttf; development: pdfjs-dist, @types/pdfkit).

Evidence: `tests/api/pdf.test.ts` 7 passed: no character lost for an Arabic, an English-with-accents and a mixed line
(pdf.js, an independent reader); the drawn glyph order read back from the PDF through its ToUnicode map equals bidi-js's
reordering; the carried text equals the stored text; long lines wrap; a certified copy made by the R3 writer (fixture) still
verifies against its registered hash and a changed one does not. Planted faults: Arabic pieces not reversed (the bug of the
first render) caught by two tests; ActualText removed caught by three. A page rendered and looked at: the Arabic line reads
right to left with ٧٠٪ and 12 in order, the mixed line keeps "Mixer M-01:" first. Whole suite 135 passed, Playwright 34.

Also seen: with `pdftotext -bbox`, poppler returns each line exactly as stored (it uses the ActualText); in its plain mode it
prints Arabic in visual order, by design, which is why E22#2 names the carried text and an independent reader.

NOT verified: a printed page on the plant's printer; fonts for scripts other than Latin and Arabic.
