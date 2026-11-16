# r4-mbr-copy: copy a recipe into a new master (E23)

- `server/mbr/copy.ts`, `POST /api/mbrs/:id/versions/:versionId/copy` (`server/routes/mbr-copy.ts`, permission
  `mbr.design`): any version (draft, effective, retired) becomes version 1, draft, of a NEW master with its own code and
  product name. The design is parsed again by the current design rules. The source is recorded twice: `based_on` points to
  the source version (no migration: the column already exists and nothing assumed it stays inside one master) and the audit
  entry `mbr.copied` names the source master, code, version id and number. The source is only read.
- The copy follows the normal path: its author signs it into review, QA approves (not the author), and no batch can be made
  from it before it is effective (`no_effective_mbr`).

Gate needs: the route table regenerated (63 routes); the permission matrix is unchanged (`mbr.design` exists).

Evidence: `tests/api/mbr-copy.test.ts` 4 passed (copy with source, any version, wrong master 404, code taken 409, operator
403; audit with the source and the source rows byte-for-byte unchanged; own review, author cannot approve, no batch before
effective). Planted fault: the audit entry written against the source master: caught.

NOT done: a copy button in the designer screen (the API is there; the screen belongs to r1-mbr's files).
