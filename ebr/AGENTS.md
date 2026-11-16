# B-Pharma EBR & Logbook: agent manual

Every agent reads this file first. It describes what the system is, how it is built, and the rules no change may break.
When the code and this file disagree, one of them is wrong: fix that one in the same change.

## 1. What the system is

An electronic batch record (EBR) and electronic logbook system for a pharmaceutical plant, regulated under GMP
(21 CFR Part 11, EU GMP Annex 11, ALCOA+).

- **Master Batch Records (MBR):** recipes made of phases and steps, versioned, approved by QA before they become effective.
- **Batch execution:** an operator runs a batch from an effective MBR, step by step, on a tablet on the shop floor. A second
  person verifies the critical steps. Values outside limits raise an exception at once.
- **Review by exception and release:** QA reviews the exceptions, not every step, and gives the batch disposition.
- **Logbooks:** equipment and room logbooks (use, cleaning, maintenance, calibration). Equipment status (clean, dirty,
  in use, on hold, calibration expired) is derived from the logbook and checked when a batch wants to use the equipment.

## 2. How it runs

- **One web application**, the same on a tablet and a desktop browser. Touch first: targets at least 44 px, no hover-only
  controls, layouts that work from 768 px (tablet portrait) to wide screens. Installable as an app (PWA manifest), but
  **always online**: a step is recorded only when the server accepted it. There is no offline recording and no local queue
  of unsigned data.
- **Factory server (on-premises).** Node 22 service plus a central PostgreSQL 16, shipped as Docker images with a Compose file,
  and as a Windows service for sites without Docker. No cloud service is required.
- **Unlimited users.** No per-user licence or hard limit. The API is stateless (sessions in the database), so more instances
  can run behind a reverse proxy; database connections go through a pool. Capacity is a tested number (see the roadmap), not
  a promise.
- Standalone. A later release links to the LIMS (samples from a batch, results back). Nothing in R1 or R2 depends on it.

## 3. Stack

TypeScript everywhere. Client: React 19, Vite, Tailwind CSS. Server: Express, Zod for every input, SQL through `pg` (node-postgres) on PostgreSQL 16: no ORM, every query parameterised.
Tests: Vitest (unit and API, against a real PostgreSQL, never a mock of it) and Playwright (two viewports: tablet 820x1180 and
desktop 1440x900). Authentication: local accounts with scrypt password hashes, TOTP second factor, optional LDAP/AD.
Not used, do not add: any cloud database or identity service (Firebase included), any per-seat licensed component,
a message broker (background work uses a `jobs` table).

## 4. Rules no change may break

1. **Audit trail in the same transaction** as the change it records: who, what, when (server time, UTC), old and new value,
   reason where the change corrects a record. Entries are hash-chained and never updated or deleted.
2. **Electronic signatures** carry the signer, the meaning (performed, verified, reviewed, approved, released), the date and
   time, and the version of the record signed. The password is re-entered at each signing. A signature is invalid when
   the record changes afterwards.
3. **Two people for verified steps:** the verifier must be a different user from the performer, checked on the server.
4. **Server-controlled fields** (ids, timestamps, actor, status, versions) are never taken from the client. The actor is the
   session user.
5. **Optimistic concurrency:** every update states the version it read (`WHERE id = $1 AND version = $2`); a stale write is
   refused with 409. Several tablets may work on the same batch.
6. **Records are not deleted.** They are cancelled or superseded, with a reason and a signature.
7. **Effective versions only:** a batch starts only from an approved, effective MBR version; equipment is used only when its
   logbook status allows it.
8. **No silent failure.** A failed write reaches the user with its cause; nothing is retried in a way that could record twice.
9. **Strict schemas:** unknown fields are refused, not ignored.

## 5. How work is organised

The plan is `docs/roadmap/roadmap.json` (releases, tracks, gaps with acceptance criteria). It is built with the
`gxp-software-factory` skill: one track owns its files; shared files change only through a gate patch; every track writes
`docs/changes/<track>.md`. Migrations are forward-only, numbered within the track's reserved range.
