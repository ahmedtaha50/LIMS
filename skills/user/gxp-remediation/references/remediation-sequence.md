# Remediation sequence

The order is not preference. Later work is meaningless without earlier work:
there is no point enforcing segregation of duties on top of an identity anyone
can forge, and no point writing validation documents for controls that do not
exist.

## Phase 0 — Containment (days)

Before any refactoring, close what is exploitable now:

- Delete hardcoded credentials and authentication bypass paths. These are
  deletions, not rewrites. They break the demo login, which is the point.
- Close any world-readable or world-writable datastore.
- Put authentication on unauthenticated endpoints.
- Secure or remove plaintext credential dumps already on disk.

If real GxP data exists in the system, consider whether it should continue in
use while identity cannot be established. Record the decision either way.

## Phase 1 — Trust foundation (2–3 weeks)

Nothing above this layer means anything until it holds.

Password hashing · one authentication path with no bypasses · actor resolved
once with no fallback · authorisation applied to every route with default-deny ·
strict schemas with server-controlled fields absent · transactions introduced ·
security middleware.

## Phase 2 — Records and audit (2–3 weeks)

One audit writer · full-length hashes · chain lock inside the transaction ·
verification that recomputes · field-level entries · audit entries on every
mutating path · database-level immutability · server-side record numbering ·
foreign keys, indexes, pagination.

Decide honestly what to do with pre-existing audit entries. They cannot be
retro-chained truthfully. Mark the boundary and declare the segment as a
residual risk. Do not re-hash history.

## Phase 3 — Workflow and signature (2–3 weeks)

Delete any generic transition endpoint · the transition table as the single
source of truth · guards wired into every path with normalised identifiers ·
real signatures atomic with the change · post-approval locking · idempotency.

## Phase 4 — Persistence cutover (2–3 weeks)

Complete the migration away from client-side storage. Extract data trapped in
browsers **before** anyone clears a cache — it is in no backup. Delete seeded
data, especially seeded audit entries.

## Phase 5 — Discipline (1–2 weeks, overlapping)

Purge ad-hoc mutation scripts · implement the build gate and the traceability
generator as real gates · replace placeholder tests · rewrite the repository's
agent/contributor rules · documentation · backup and restore, tested ·
deployment.

## Phase 6 — Validation (3–4 weeks)

Only now. The system has controls worth documenting.

## Two sequencing lessons

**The frontend becomes a blocking dependency, not a parallel track.** Once the
backend uses cookie sessions and a CSRF header, the old client cannot
authenticate at all. Plan for the UI work to sit between backend completion and
any end-to-end testing.

**Cold start is a real step.** If migration nulls every stored password —
because they were reversible and must be treated as compromised — then nobody
can sign in until a bootstrap step creates the first administrator. Write that
script, make it refuse to run twice, and test that the system says so clearly
when it has not been run.

## Adjusting the sequence

Two conditions change it:

**Starting clean** (no data migration) removes Phase 4's extraction work,
simplifies Phase 2's boundary handling, and lets client-side stores be deleted
outright rather than shimmed. It also removes the legacy audit epoch — and the
declaration of it must be made conditional, because declaring a non-verifiable
segment that does not exist puts a false residual risk into the assessment.

**No production data at all** means the deletion list becomes much larger and
the migration risk much lower. Ask early; it changes weeks of work.
