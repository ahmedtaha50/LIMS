# r6-screens: every function a person uses has a screen (E32)

Found by matching every route against the calls of the screens: user management, creating, changing and retiring a
logbook, a new version of a logbook type and its draft, copying a recipe, the audit trail review, the certified copy check
and the LIMS samples of a batch were reachable only through the API.

- `tests/unit/screens-coverage.test.ts`: every route a person can call must be called by a screen with its method; two
  named exceptions (the health check; the list of signature meanings for other systems). Hiding the users screen makes it
  name the four user routes (planted fault).
- Screens: Users (create with roles and first password, change roles, name and status with a reason, unlock), Logbooks
  (new logbook from an effective type, change with a reason, retire signed), Logbook types (start a new version, edit the
  draft with the same designer), Recipes (copy any version into a new draft recipe), Audit trail (latest entries filtered by
  record, action, user and period; history and signatures of one record; chain verification; certified copy check from a
  PDF file), Batch (LIMS samples and approved results).
- `server/routes/audit-review.ts`: `GET /api/audit/recent` (audit.read), filters as parameters (a filter is data: `%` is
  a character, an injection attempt finds nothing).
- Every checkbox and radio button is now 44 px (they were 20 px; the Arabic tour of the new Users screen caught it, and the
  same size was used, unseen, in three other screens).
- Arabic for every new text (the dictionary test enforces it); the Arabic tour now includes Users and Audit trail.

Evidence: unit 19, `tests/api/audit-review.test.ts` 2, `tests/e2e/admin.spec.ts` 2 (tablet, desktop: account created and
re-roled, logbook created and retired, recipe copied, type version started and its draft saved, audit trail filtered and
chain verified); whole suite 169, Playwright 40. A silent catch written on the way (new type version) was replaced by the
error shown to the user before the commit.

NOT covered by a browser test: the LIMS samples card (it needs a LIMS; the API is covered by tests/api/lims-link.test.ts)
and the certified copy check by file upload (the API is covered by tests/api/review.test.ts).
