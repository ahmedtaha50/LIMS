# r1-esign: one e-signature service for every record type (roadmap M07)

Release R1, wave 3, run beside r1-authz. Branch `claude/project-implementation-tirr4j`, changes left uncommitted for the wave gate.
Companion file: `docs/changes/r1-esign.gate.patch` (the edit to another track's test that this change forces; see "For the gate").

Status: **partial**. The service, the schema, the catalog, the verification and the screens are done and tested, and two of the four
acceptance criteria are met on the real endpoints today. The other two (the Draft specification approval returning 200, and "three wrong
passwords on any signing endpoint") are met by `signRecord` on every record type and demonstrated over HTTP on a reference route, but the
real endpoints still run their own signing code, which lives in files this track does not own (see "Acceptance").

## What changed

| Area | Files |
|---|---|
| Migration (forward-only) | `drizzle/0020_esign.sql`: table `signature_meanings` (catalog, seeded under the runner), seven columns on `signatures`, `sample_id` nullable (foreign key kept), a CHECK that a version 2 row is complete, an index, and a digest-guarded backfill of the existing rows |
| Schema and protections | `src/db/schema/signatures.ts`; `src/db/protections/signatures.ts` (statements unchanged, comment only: the link-once trigger is kept and now also compares the new columns) |
| The service | `src/server/esign/`: `signRecord.ts` (the one way to sign), `authorize.ts` (role, reason, lock, training, password, TOTP, in one order), `registry.ts` + `entities.ts` (record types and what a signature on each covers), `hash.ts` (canonical JSON, hash version 2), `meanings.ts` (catalog), `verify.ts`, `legacy.ts` (the v0.1.0 formulas), `index.ts` |
| Routes | `src/server/routes/signatures.ts`: `GET /signatures/verify/:id` (rewritten), new `GET /signatures/meanings` and `GET /signatures/entity/:type/:id` |
| Validation | `src/lib/validations/signatures.ts`: `signatureFields` (what every signing route spreads into its own strict schema), strict parameter schemas |
| Screens | `src/components/SignatureBlock.tsx` (new: the signatures of a record, Verify, `SignatureVerdict`), `src/components/ElectronicSignatureModal.tsx` (meaning code and TOTP field; the training exemption now follows the meaning) |
| Tests | `tests/api/esign-schema.test.ts` (11), `esign-sign.test.ts` (59), `esign-verify.test.ts` (12), `esign-legacy-upgrade.test.ts` (8), `esign-backup.test.ts` (2), `esign-ui.test.ts` (11): 103 tests against the real application and PostgreSQL |

Files outside the ownership list that this change touched: **none**. (`tests/route-table.json`, `desktop/schema.sql` and
`tests/upgrade/upgrade-v0.1.0.test.ts` need edits that this change forces; they are listed under "For the gate" and not made here.)

## How a signing route looks (for every track that signs)

```ts
const { result, signature } = await signRecord({
  db, user: (req as any).user,                       // only the id is used; the signer is read again
  meaningCode: req.body.meaningCode,                 // a catalog code. A meaning text from the client is never read.
  credentials: { password: req.body.password, totpCode: req.body.totpCode },
  reason: req.body.reason,
  entityType: 'Specification', entityId: id,         // a registered record type
  sampleId,                                          // only for a record that belongs to a sample
  context: securityEventContext(req),
  execute: async (tx, afterCommit) => {              // the change being signed, inside the signing transaction
    const row = await updateVersioned(tx, specifications, id, req.body.expectedVersion, { status: 'Active' });
    afterCommit(() => emit(io, 'spec:approved', { id }));
    return { recordVersion: row.version, audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Active', reason: '...' }, result: row };
  },
});
```

Request schema: `z.object({ ...signatureFields, expectedVersion: z.number().int().min(1) }).strict()`. A `meaning` key in the body is an unknown
key, so the request is a 400.

What `signRecord` does, in order:

1. Looks the meaning up in the catalog and the record type up in the registry (400 `UNKNOWN_MEANING`, `UNKNOWN_ENTITY_TYPE`).
2. `authorizeSigner`, before any transaction: signer exists and is active (401 `USER_INACTIVE`); role is allowed for the meaning (403 `ROLE_NOT_ALLOWED`); a reason of at
   least 5 characters where the meaning requires one (400 `REASON_REQUIRED`); signing is not locked (401 `SIGNING_LOCKED`); software training is complete unless the meaning is
   training-exempt (403 `TRAINING_REQUIRED`); password (401 `INVALID_PASSWORD`); if the signer has an authenticator, a current code that was not used before (401
   `MFA_CODE_REQUIRED`, `INVALID_CODE`). A wrong password or code is counted and written, with its `SignatureFailed` audit entry, in **its own transaction** (r1-identity's
   `recordSigningFailure`) and committed before the error is thrown. `execute` has not run.
3. One transaction: `execute` makes the change; the audit entry is written **first**; the content hash is computed from the record as it now stands; the signature row is
   inserted pointing at that audit entry. Any failure rolls all of it back, so no change exists without its signature and no signature without its audit entry.
4. The `afterCommit` hooks run after COMMIT and never on rollback.

The signature row carries a **snapshot** of the printed meaning, the signer's name and role, and the authentication method. Renaming a user, changing a role or correcting the
catalog later changes nothing that an old signature shows.

To add a record type: `registerSignable({ type, canonical })` from the owning module (`canonical` returns the content the signature covers and must stay stable after signing;
read `src/server/esign/registry.ts`). A registered type cannot be registered twice. To change what a type signs: a new hash version, not a change to version 2.
To add or correct a meaning: a migration (`signature_meanings` is not edited by the application).

### What each existing signing path becomes (the other tracks' files)

| Path today | File (owner) | `meaningCode` | `entityType` / `entityId` | Notes |
|---|---|---|---|---|
| Sample review, approve, reject | `routes/samples.ts` (r1-results-oos) | `SUBMIT_FOR_REVIEW`, `APPROVAL`, `REJECTION` | `Sample` / sample id, `sampleId` set | Remove the hand-written failure handling in the catch block |
| OOS closure | `routes/oos.ts` (r1-results-oos) | `OOS_CLOSURE` | `OOS` / OOS id, `sampleId` set | Lock the investigation after closure: `PUT /oos/:id` on a closed one would now show `record-modified` |
| Batch release | `routes/release.ts` (r1-results-oos) | `BATCH_RELEASE` | `BatchRelease` / **the batch name** | The entity id is the batch (the audit entries of releases always were). Needs no sample for the foreign key any more |
| Notebook observation | `routes/eln.ts` (r1-quality-fixes) | `AUTHORSHIP` | `LabNotebook` / the entry id | Today signs nothing (`N/A`); lock the entry |
| ELN worksheet | `routes/eln.ts` (r1-quality-fixes) | `AUTHORSHIP` | `LabNotebook` / worksheet id | Drop the `meaning` field of the body |
| Specification approval | `routes/specifications.ts` (r1-spec) | `SPECIFICATION_APPROVAL` | `Specification` / spec id | Supersede the previous Active specification inside `execute`. This is the fresh-install defect |
| Calibration | `routes/instruments.ts` (r1-quality-fixes) | `CALIBRATION` | `Instrument` | An event signature; `recordVersion` 1 until the table has a version column |
| Reagent receipt | `routes/reagents.ts` (r1-quality-fixes) | `RECEIPT` | `Reagent` | The receipt screen posts a password the route never checked |
| Training certification | `routes/training.ts` (r1-identity) | `TRAINING_CERTIFICATION` | `User` / the trained user | Replaces `assertActorPassword` |
| Administrator actions | `routes/admin.ts` (r1-identity) | `ADMIN_AUTHORISATION` | `User`, or a type the track registers | Replaces `assertActorPassword`; the signature row is the missing "e-signature for administrator actions" |

## Verification (`GET /api/signatures/verify/:id`)

Recomputes what the signature was bound to and checks the audit chain through the signature's entry (bounded work, `verifyAuditChainTo`). The answer keeps its old fields and adds
`status`, `statusText`, `entityType`, `entityId`, `hashVersion`. **`valid` is true only for status `valid`.**

| status | meaning |
|---|---|
| `valid` | the record hashes to what was signed and the chain is intact |
| `record-modified` | the record was changed after signing (`contentHashMatches: false`) |
| `record-missing` | the signed record is gone |
| `chain-broken` | the record matches but an audit entry up to the signature's was altered |
| `legacy-unverifiable` | the hash cannot be recomputed (`N/A`, or a formula whose input was never kept): neither confirmed nor refuted, never valid |
| `audit-missing`, `unsupported` | a version 2 signature without its audit entry; a record type this build does not know |

Hash version 1 (v0.1.0, and what the routes that have not moved still write) is recomputed for a sample transition, an OOS closure and an ELN signature, with the formulas copied
from the old routes. A batch release signed a list of sample ids that was not kept, and a notebook observation signed nothing: both are `legacy-unverifiable`, permanently.
Hash version 2 is `sha256(canonicalJson({v: 2, entityType, entityId, recordVersion, content}))`. Records that are drafted and then frozen (Sample, OOS, Specification,
LabNotebook, BatchRelease) sign their content, with the lifecycle value (state, status) taken **as signed** from the audit entry, so a later legitimate move does not break an earlier
signature. Records that are a series of events (Instrument, Reagent, User) sign the event; the audit chain is what protects them, and the verifier reports a broken chain.

## Why (findings from `synth.topDefects` and M07)

* "A fresh install cannot approve a spec, so it cannot register a sample": the specification approval wrote its id into `signatures.sample_id`, which had a NOT NULL foreign key to
  samples (the ELN and the release did the same). Reproduced on the untouched code: `POST /specifications/:id/approve` as QA answered **500** and wrote no signature.
* "Failed e-signature counters and SignatureFailed audits roll back": on the untouched code three wrong passwords on a specification approval answered 403 three times, wrote **no**
  `SignatureFailed` entry and left the counter at 0 and no lock; on the OOS closure the answer was "2 attempt(s) remaining" three times in a row (the count never advanced).
  The calibration, release, certification and notebook paths keep no count at all.
* "Verify returns valid when the hash is null" and "Signatures with contentHash 'N/A' verify as valid": both now `legacy-unverifiable`. The OOS and ELN signatures were never
  recomputed, so altering the signed row in SQL changed nothing.
* "Only 4 of 9 sign paths enforce training"; "Meanings come from client or hard-coded strings"; the signer's name and role were looked up again at every display.

## Deliberate behaviour changes

1. `signatures.sample_id` is nullable; seven columns are added; `signature_meanings` exists (migration 0020, needs QA review: it switches the table's user triggers off for one
   statement block to backfill the existing rows, and aborts the whole migration if a digest of every hash-covered column differs afterwards).
2. `GET /signatures/verify/:id` says `valid: false` for a signature whose hash cannot be recomputed (it said true). A v0.1.0 installation therefore shows its batch release and notebook
   observation signatures as `legacy-unverifiable`, and its ELN and OOS signatures are checked for the first time.
3. `chainIntact` is `null` (not a whole-chain re-hash) for a signature that points at no audit entry.
4. The signature dialog asks for the authenticator code when `user.mfaEnabled`, shows the catalog's text when it is given `meaningCode` + `token`, and exempts a user from the training
   guardrail only when the **meaning** is training-exempt. Without `meaningCode` the old action-name and `isTrainingBypass` heuristics remain, so existing callers keep working.
5. Two read routes are added (`meanings`, `entity/:type/:id`).

## Acceptance (M07) and what is met

| Criterion | Status |
|---|---|
| Approving a Draft spec as QA returns 200 with a signature row `entity_type='Specification'` on a schema built from migrations | **Met by `signRecord`**: the reference route in `esign-sign.test.ts` (real `requireAuth`, real database, HTTP) returns 200 with the row. **Not yet on `POST /specifications/:id/approve`**: that route (r1-spec) still writes `sample_id = spec.id` and answers 500 |
| Three wrong passwords on any signing endpoint leave three `SignatureFailed` rows and a persisted lock | **Met for every record type through `signRecord`** (Sample, OOS, Specification, LabNotebook, BatchRelease, Instrument, Reagent, User, and over HTTP on the reference route). The not-yet-migrated endpoints keep their own behaviour (the sample transition already persisted its count; the specification approval and the OOS closure roll their count back; the ELN keeps a count without an audit entry; release, calibration and notebook keep none) |
| Altering an OOS or ELN row in SQL makes `/signatures/verify` return `valid=false`, `contentHashMatches=false` | **Met on the real routes today** (`esign-verify.test.ts` closes an OOS and signs an ELN through the current endpoints, alters the row, verifies) |
| A client-supplied meaning is ignored, and renaming a user leaves old manifestations unchanged | **Met for rows written by `signRecord`** (a forged `meaning` is stored as the catalog text; a rename and a role change leave the old manifestation and the next one shows the new name). The not-yet-migrated ELN route still reads `meaning` from the body, and rows it wrote show the user's current name (`signature.snapshot: false`) |

## How to verify

```
# the new tests (103 in 6 files) and the whole suite
SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<base> npx vitest run tests/api/esign
SQL_... npx vitest run                                  # see "For the gate"

npm run lint                                            # web clean; server: the 25 known baseline errors, none new

# shared validation evidence on a database made with the shipped installer and seeded, server on 127.0.0.1:3106
node scripts/build-server.cjs
BASE=http://127.0.0.1:3106/api tests/security-controls.sh      # 34 PASS, 0 FAIL
BASE=http://127.0.0.1:3106/api tests/backup-restore.sh         # 18 PASS, 0 FAIL
```

## Evidence

* **Test first.** `esign-schema`, `esign-verify` and `esign-legacy-upgrade` were run on the untouched code: **29 failed, 2 passed** (the 2 are the 401/404 of an unknown signature and the
  manifestation fields that already existed). Failures that show the old behaviour rather than a missing column: a tampered OOS closure and a tampered ELN worksheet verified with `valid: true,
  contentHashMatches: null`; a signature with hash `N/A`, a legacy batch release and a signature with an empty hash verified as `valid: true`. `esign-sign` could only fail by absence (no
  `src/server/esign`); the old behaviour of the signing endpoints was recorded separately (see "Why").
* **Mutation checks** in a private copy, 14 mutations, each must turn a test red, and all do: role check off (1 test), failure not persisted (12), training check off (1), TOTP replay allowed
  (1), TOTP not required (3), reason rule off (1), meaning text taken from the caller (1), hash ignores the content (12), signer name read live at verification (1), null hash counts as
  valid (4), chain ignored (1), legacy OOS never recomputed (3), audit entry written outside the transaction (1), a record type can be registered twice (1; this one survived the first run
  and a test was added).
* **A defect the first whole-suite run found, now fixed and tested.** The first version of migration 0020 seeded the catalog with a plain INSERT. A restore builds the structure by replaying
  the migrations into an empty database and then loads the rows of the backup, so every restore failed with `duplicate key ... signature_meanings_pkey` (`backup-timezone` and
  `timezone-pool` failed). The seed is now `WHERE EXISTS (SELECT 1 FROM schema_migrations)`: the runner has journaled earlier files, a replay has not. `esign-backup.test.ts` covers the replay
  (no catalog rows) and a backup round trip with the catalog and a v2 signature. r1-authz's migration 0040 independently uses the same guard.
* **Shared checks**, production bundle on 127.0.0.1:3106, database made by `dist-server/init-db.cjs` (8 migrations) and seeded: `tests/security-controls.sh` 34 PASS, 0 FAIL; `tests/backup-restore.sh`
  18 PASS, 0 FAIL. (Run once each, in that order, on a fresh database. Running `security-controls.sh` a second time on the same database fails 4 checks, because the first run leaves accounts locked and the
  server's in-memory sign-in limiter remembers the failures; that is how the scripts behave and has nothing to do with this change.)
* **Whole suite.** In a private copy of the tree without r1-authz's in-flight files, with `r1-esign.gate.patch` applied and the route table and `desktop/schema.sql` regenerated: **539 passed,
  3 skipped, 0 failed** in 52 files (2 skipped files are the opt-in scale tests). A first run of the suite reported one unhandled `57P01` (a scratch database dropped while a client was still closing) from
  `tests/upgrade/runner.test.ts`; that file passes alone (three runs in a row) and the final whole-suite run reported no error, so it is a teardown race of the harness under load, not
  something this track touches.
  In the shared tree the failures that are not r1-authz's in-flight tests are exactly the three forced ones listed under "For the gate".

## Decisions that need confirmation

See `decisionsForUser` in the structured report. In short: the catalog's wording and role lists, the training exemption for three meanings, the authenticator code at every signing for a user
who has one, what a legacy signature shows, event-type signatures resting on the audit chain, the seed guard, and the catalog being changed only by migration.

## Not done

* The real signing endpoints of other tracks (table above). Until they move, they write version 1 rows with no binding, and the specification approval still answers 500 on a fresh install.
* `ElectronicSignatureModal` is used by eight screens; none passes `meaningCode` or `token` yet, so they keep the old display text and heuristics. `SampleDetail.tsx` and `OOSInvestigations.tsx`
  still show a green "Verified" banner for any HTTP 200 from the verify route (top defect); they should render `SignatureVerdict` from `SignatureBlock.tsx`, which colours by `status`.
* The password re-entry of administrator actions, training certification and calibration still goes through each route's own code (r1-identity, r1-quality-fixes).
* Records that must not change after signing are not locked by this track (OOS after closure, a notebook observation, a released batch). The verifier shows `record-modified` if they are
  edited; stopping the edit is the owning track's job.
* No admin screen for the catalog; no trigger protects the catalog rows against someone with database access (the snapshot in each signature protects history, and the migration journal records
  the original seed).
* `signatures.entity_type` and `entity_id` stay nullable so the routes that have not moved keep working; a later migration should make them NOT NULL once none writes version 1 rows.
* Signatures for system settings and integrations (`SystemSettings`, `Integration`) are not registered record types; r1-identity can `registerSignable` them when its routes move.
* The validation package (`validation/`) has no entries yet for the catalog, the hash version 2 and the legacy statuses; this document and `tests/api/esign*.test.ts` are the material. Nothing was approved or signed.

## For the gate

1. `git apply docs/changes/r1-esign.gate.patch`, then delete it. It changes `tests/upgrade/upgrade-v0.1.0.test.ts` (r1-migrations): the five v0.1.0 signatures now carry the backfilled
   columns, the catalog is installed with 12 rows, and the verification expectations follow the new statuses (3 recomputed, 2 `legacy-unverifiable`). No assertion about data kept,
   immutability or refusal is removed or weakened.
2. Regenerate `tests/route-table.json` (`npx tsx tests/helpers/dump-route-table.ts`): two new routes, both `auth: true`: `GET /api/signatures/meanings` and `GET /api/signatures/entity/:type/:id`.
3. Regenerate `desktop/schema.sql` (`npx tsx src/server/boot/migrate-cli.ts export-schema`) after the last migration of the wave: it carries 0020 once regenerated.
4. **r1-authz's route table** (`src/server/authz/routeTable.ts`): add rules for the two new routes, or `createApp` will refuse to start once the contract check is wired in:
   `'GET /signatures/meanings': SELF()` (any signed-in user; the signature dialog needs it) and `'GET /signatures/entity/:type/:id'` with the permission that already guards
   `GET /signatures/verify/:id` (`record.verify`) or a view permission. Also reconcile the catalog's `allowed_roles` with the permission matrix (migration 0040 and this one are both reserved
   numbers of the same wave; the roles in `signature_meanings` are defence in depth, the matrix is the authority).
5. The failures in `tests/api/authz-*`, `route-contract` and `tests/upgrade/schema-drift` seen in the shared tree while this track was built belong to r1-authz's in-flight work (the drift test
   passes with 0040 removed; it fails inside drizzle-kit's introspection when 0040 is present).
