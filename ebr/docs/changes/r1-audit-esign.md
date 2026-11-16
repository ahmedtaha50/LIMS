# r1-audit-esign: audit trail and electronic signatures (E03, E04)

- `migrations/0020_audit.sql`: `audit_log` with user, server time, old and new value, reason, request id, and a SHA-256
  chain (`prev_hash`, `hash`). Triggers refuse UPDATE, DELETE and TRUNCATE for every role, the application's included.
- `server/audit/`: `writeAudit(client, entry)` appends inside the caller's transaction (a transaction-level advisory lock
  keeps the chain one sequence across server instances); `verifyChain` recomputes it in pages and names the first broken
  entry; `canonical()` gives one text per value whatever the key order.
- `migrations/0021_signatures.sql` and `server/esign/`: a signature stores signer, meaning (catalogue of 9), server time,
  record version and the hash of the record content; it is permanent (triggers). `sign()` re-checks the password through
  an injected `PasswordCheck` (r1-identity provides it), audits a refused attempt in its own transaction so it is kept,
  and audits the signing in the caller's transaction. `isValid()` is false once the record changed; `assertDifferentPerson`
  is the server-side two-person rule.
- Routes: `GET /api/audit`, `GET /api/audit/verify`, `GET /api/signatures`, `GET /api/signatures/meanings`.

Evidence: `tests/api/audit.test.ts` 7 passed, `tests/api/esign.test.ts` 6 passed, on PostgreSQL 16.15, with tampering
planted in the database (an entry altered, an entry removed): both reported at the right entry.

Known limit: the chain lock serialises audit writes across the whole system. It is short (one insert); r3-scale measures it
under load.
