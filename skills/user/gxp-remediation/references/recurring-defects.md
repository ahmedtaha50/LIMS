# Recurring defects and their fixes

The defects that appear in nearly every bespoke regulated application, with the
fix that holds. Each was observed in production GxP code.

## Identity and access

**A header supplies identity.** `if (req.headers['x-user-id'] && !authHeader)`.
Anyone with curl becomes any user. Often written for testing and never removed;
frequently the *primary* path, because the client sends it too.
→ Delete. Test authentication uses a real token from the identity mechanism.

**A magic token.** `if (token === 'TEST_TOKEN')`.
→ Delete. There is no acceptable version of this.

**Unverified decode on verification failure.** `catch { payload = JSON.parse(atob(token.split('.')[1])) }`.
A forged token is accepted *because* it is invalid.
→ Verification failing is a 401. Full stop.

**A universal password.** `if (hash !== password && password !== '123456')`.
→ Delete, and add a build-gate rule for password literals. This class returns.

**Reversible password storage**, often in a column named `password_hash`.
→ argon2id or bcrypt. Null every existing value and force a reset: they are
compromised, not re-hashable.

**A role helper applied to nothing.**
→ Permission matrix as data; `requirePermission` on every route; a startup
assertion that refuses to boot if a route lacks one, detecting by an explicit
marker rather than a function name.

**Role derived from the email address.** `role = email.startsWith('admin') ? 'admin' : 'user'`.
→ Explicit assignment, signed and audited.

## Audit trail

**Two writers with incompatible schemes.** One chains, one does not; different
hash functions over different serialisations.
→ Delete one. Add a gate rule so a second cannot return.

**Non-transactional writes.** The change and its audit entry are separate
statements; either can succeed alone.
→ Same transaction, always. Never queue an audit write.

**Truncated hash.** `.digest('hex').substring(0, 16)` — a 256-bit digest
computed and then discarded.
→ Full length, and a gate rule.

**Placeholder actor fallback.** `req.user?.id || 'system'`. Converts an
authentication failure into a falsified record with nothing raised.
→ Resolve once; unresolved is a 401. Add a database trigger rejecting
placeholder actors, because application discipline alone has not held.

**Whole-object entries.** `JSON.stringify(record)` into `oldValue`.
→ One entry per changed field, with old value, new value and reason.

**The chain read without a lock.** Concurrent writes read the same tail and
fork the sequence.
→ Transaction-scoped advisory lock, plus a unique index on the sequence.

## Signature

**Client-side verification** — see inert-controls shape 8.

**Signature decoupled from the change.** Reauth is one request, the write is
another.
→ One endpoint, one transaction.

**Signatures as a JSON blob on the record**, writable through the ordinary
update path.
→ A dedicated table with UPDATE and DELETE revoked and a refusing trigger.

**A fabricated content hash.** A 32-bit string hash plus `Date.now()`, labelled
`sha256_…` — neither a digest nor reproducible.
→ Server-side SHA-256 over a canonical serialisation. A `CHECK` constraint that
the stored value is 64 hex characters catches the next one.

**A failed attempt leaves no record** — see inert-controls shape 7.

## Workflow

**A generic transition endpoint** accepting whatever `targetState` it is sent,
with no state check, role check, segregation check, signature or audit entry.
→ Delete it. Per-entity transitions driven by a table. The client sends an
*action*; the server derives the state.

**A carve-out.** "Entity X may change status through the normal update
endpoint." Usually a temporary shortcut that got written down as a design
decision.
→ No carve-outs. Every entity's update schema omits status, and a test asserts
it for each.

**Free-string states.** `type State = string`, so a designer screen can create
states at runtime — states that carry no guards, no signature meaning and no
segregation rule.
→ Closed unions, with a test asserting every state a transition mentions is
declared. If configurability is genuinely needed, make it *parameters* — roles,
SLAs, optional steps — that can only narrow.

## Records and data

**Client-side record numbering** from a local counter. Two machines issue the
same number; clearing storage reissues numbers already used.
→ A database function allocating inside the create transaction.

**Optional concurrency control.** `if (expectedVersion !== undefined && ...)`,
compared in memory and written without the predicate.
→ Mandatory, and in the `WHERE` clause. Zero rows affected is a conflict.

**The client guesses the version.** `res.newVersion || record.version + 1`.
→ A missing authoritative version is an error, not something to paper over.

**Client-side store with a swallowed sync failure.** The user sees success;
the record never left the machine.
→ Complete the migration; fail loud; extract trapped data before any cutover.

**Approved records editable in place**, with signatures still attached.
→ State check on the update path; amendment with re-approval.

## Lists, exports and reports

**A page without the matching total.** The most misleading defect in the set,
because nothing about the output looks wrong.
→ Every list and export states filters, page and total matching. A response
missing the total is a contract failure, not something to render around.

**A verification banner that cannot fail.**
→ Derive at generation; render the real verdict including the failing location.

**A draft that prints like an approved record.**
→ Watermark; mark controlled copies explicitly.

## Tests and process

**Placeholder tests tagged with requirement identifiers.** The worst case for
validation evidence: the matrix reports verification that never happened.
→ Delete them. A missing test is honest.

**A CI step named after a standard, running tests that assert constants.**
→ Rename or remove until it verifies something.

**Referenced build scripts that are 0-byte files.**
→ Implement or delete. A gate that passes by doing nothing is worse than no
gate, because it is cited as evidence.

**Ad-hoc mutation scripts in the repository root.**
→ Delete, with a dry-run script listing them and a commit carrying the GxP
impact statement: configuration management only, no GxP function affected.

**Contributor or agent rules that encode the defects.** In one project the
repository's own manual instructed developers to use the identity fallback, the
version guess, and the status carve-out.
→ Rewrite. A rule authorising a defect is worse than a missing rule, because
every future change follows it faithfully.
