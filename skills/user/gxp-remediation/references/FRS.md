Bpharma
Advanced Pharmaceutical Industries Co. Ltd · Jeddah, Kingdom of Saudi Arabia
Functional Requirements Specification
Deviation Management System (DMS)
Document Number
VAL/DMS/FRS/001	Document Type
FRS	Version
1.0	Effective Date

System
DMS — Electronic Quality Management System	GAMP Category
Category 5 — Custom Application
 
 
1. Purpose and Scope
This Functional Requirements Specification states how each user requirement in VAL/DMS/URS/001 is technically met. Each item names the specific mechanism — the check, the constraint, the computation — rather than restating the requirement.
Note
Where an item names a database-level constraint, that is deliberate and load-bearing. A control the application enforces but the database does not is a convention, and a convention survives only as long as every future change respects it.
2. Architecture Overview
The DMS is a single on-premise instance: PostgreSQL, an Express application and nginx on one server, reached by browser over the plant network. The frontend is served from the same origin as the interface it calls, so no cross-origin configuration exists anywhere in the system.
The governing principle is that the server is the sole authority for anything that must be true for a record to be valid — identity, role, status, timestamps, version, record number, signature verification and every computed value. The browser displays and collects; it decides nothing. Where the browser performs a check, it is for immediate feedback and is duplicated on the server, which is the copy that governs.
Every operation that changes a record runs as a single database transaction in a fixed shape: lock the row, verify the version, evaluate the guards, write the audit entries, write the signature, apply the change. Any failure at any point rolls back all of it. This is the mechanism behind several requirements that would otherwise need separate machinery — a signature cannot exist without its record change, and a record change cannot exist without its audit entry, because they are one write.
3. General and Regulatory
FRS	Mechanism	Addresses
FRS-001	All components run on one on-premise server. Authentication uses local sessions held in PostgreSQL; there is no external identity provider, and no function required to create, approve or retrieve a record depends on an outbound connection. Optional integrations (SMTP, message queue, analytical assistance) are disabled by default and no workflow state depends on them.	URS-001
FRS-002	All record data resides in one PostgreSQL database. Browser storage holds only interface preferences — theme, language, column layout. The build gate fails on any write of a GxP key to browser storage.	URS-002, URS-150
FRS-003	No delete operation exists for any GxP entity. Retirement is a status change through the transition mechanism with a mandatory reason. Every foreign key is declared ON DELETE RESTRICT, so no cascade can reach a GxP or audit row.	URS-003
FRS-004	Record states are closed TypeScript unions in states.ts. An automated test asserts that every state named by any transition is declared, and that every declared state is reachable, so the two definitions cannot diverge. Configuration cannot introduce a state; the endpoint rejects an unrecognised transition key by name.	URS-004, URS-141
FRS-005	Every record carries workflow_config_version, stamped at creation from the active configuration. Activating a new configuration supersedes the previous version rather than replacing it; both remain queryable.	URS-005, URS-143
FRS-006	A single module, siteTime.ts, holds the timezone rule, driven by DMS_SITE_TIMEZONE. A due date is a calendar date in site time; overdue is determined by comparing site-local dates, never a UTC instant. Overdue is computed on the server and returned with each record; no screen recomputes it.	URS-006, URS-153
FRS-007	The interface supports English and Arabic, including right-to-left layout.	URS-007
4. User Management and Access Control
FRS	Mechanism	Addresses
FRS-010	Each user is one row in the users table with a unique id and email. Sessions reference a single user id. There is no mechanism to associate one session with more than one identity.	URS-010
FRS-011	Authentication compares the supplied password against the stored argon2id hash for that account, using the library’s constant-time verification. No literal credential appears anywhere in the source; the build gate fails on any password literal, and the check runs over every file on every build.	URS-011
FRS-012	Passwords are hashed with argon2id at 19 MiB, two iterations, single lane. The verification path returns false for an absent or malformed hash and burns comparable time, so "no password set" is not observably faster. No response type in the system contains a password field, by construction rather than by filtering.	URS-012
FRS-013	checkPasswordPolicy enforces minimum length twelve, all four character classes, a deny-list of common values, and rejection of passwords containing the user’s own name or email local part. The last five hashes are retained and compared on change. Enforcement is server-side; the identical browser check is advisory.	URS-013
FRS-014	Consecutive failures increment a counter and lock the account at five. The counter is committed outside the transaction that reports the failure — incrementing it inside would roll it back with the rejection, and the lock would never engage. Every attempt is recorded with outcome, address and agent.	URS-014
FRS-015	POST /api/admin/users/:id/unlock clears the lock, requires the administrator’s own password and a reason, and writes a significant audit entry. A service principal cannot be unlocked by any route.	URS-015, URS-022
FRS-016	A session is thirty-two random bytes delivered in an httpOnly, Secure, SameSite=Strict cookie; only the SHA-256 of the token is stored. Idle timeout is fifteen minutes and absolute lifetime twelve hours, both evaluated server-side on every request. Sessions are revocable and are revoked on logout, password change, role change, deactivation and lockout.	URS-016, URS-020
FRS-017	ROLE_PERMISSIONS maps each of six roles to an explicit permission list. Every route declares a permission through requirePermission; assertEveryRouteHasPermission walks the registered stack at startup and refuses to start if any route lacks one. Detection uses an explicit marker rather than a function name, so renaming or minification cannot silently disable it.	URS-017
FRS-018	changeRole and setUserStatus compare the target id against the acting user and refuse a match, before any other check.	URS-018
FRS-019	Deactivation sets users.status and revokes sessions. No route deletes a user. Foreign keys from records to users are ON DELETE RESTRICT, so a user referenced by any record cannot be removed even at database level.	URS-019
FRS-020	Every administrative action re-verifies the administrator’s password, writes a field-level audit entry marked significant, and stores a signature — all in one transaction with the change.	URS-020
FRS-021	Segregation of duties is evaluated in evaluateTransition against the acting user id, with no role exemption. An automated test asserts that an administrator who created a record is refused its approval.	URS-021
FRS-022	SVC-SCHEDULER exists as a user row with no password hash and permanently locked. Background work is attributed to it. The unlock and reset routes refuse any identifier beginning SVC-, returning SERVICE_PRINCIPAL_IMMUTABLE.	URS-022
 
5. Record Management
FRS	Mechanism	Addresses
FRS-030	Numbers are allocated by the PostgreSQL function next_record_number(entity, prefix), which inserts or increments a per-entity, per-year counter row and returns the value, inside the caller’s transaction. Format: PREFIX-YYYY-NNNNN. A rolled-back creation consumes a number: a gap is acceptable, a reuse is not.	URS-030
FRS-031	Because allocation is a single atomic statement inside the transaction, concurrent creations serialise on the counter row. No client input contributes to the number.	URS-031
FRS-032	Each record carries an integer version. Update requires expectedVersion; the value is placed in the UPDATE’s WHERE clause alongside the identifier, and a zero row count is returned as a conflict. Comparing the version in application memory before writing without it leaves a window in which two writers both succeed; the predicate closes it.	URS-032
FRS-033	On conflict the interface refetches the stored record and presents a field-by-field comparison of the user’s unsaved edits against it. The system never resubmits with the newer version — that is last-write-wins and destroys the other change without trace.	URS-033
FRS-034	The update schema requires a reason of at least ten characters. writeAudit refuses an empty reason and raises an error that rolls back the caller’s transaction.	URS-034
FRS-035	The update path reads the current state and refuses with RECORD_LOCKED where it is approved, closed, cancelled, rejected, effective or superseded, naming the amendment path.	URS-035
FRS-036	Every request schema is declared .strict(); server-controlled fields are absent from the schema rather than optional, so supplying one is rejected as an unrecognised key and the key is named in the response. The build gate fails on .passthrough().	URS-036
FRS-037	Validation uses safeParse and branches on the result; every failure is a 400 carrying a per-field message. There is no path that continues past a failed validation.	URS-037
FRS-038	Links are rows in record_links with a relationship from a controlled list. Creation verifies both endpoints exist and refuses otherwise, and writes an audit entry against both records so the link is visible from either end. A partial unique index prevents duplicate active links.	URS-038
FRS-039	Removal sets status to Removed with the remover, timestamp and reason retained, and requires the link:remove permission. No route deletes a link row.	URS-039
FRS-040	Creates and transitions accept an idempotency key stored with a hash of the request. A repeat with the same key returns the original result; the same key with a different body is rejected as reuse.	URS-040
6. Workflow and Segregation of Duties
FRS	Mechanism	Addresses
FRS-050	transitions.ts holds 43 rules across eight entities. Each declares from-state, action, to-state, permitted roles, the segregation rule, the required signature meaning, whether a reason is mandatory, the named preconditions, and the ownership field the transition stamps.	URS-050
FRS-051	The transition endpoint accepts an action and derives the state from the table. There is no path that accepts a target state; the request schema rejects one as an unrecognised key. Status and state are absent from every update schema, for every entity, with no exception.	URS-051, URS-004
FRS-052	evaluateTransition checks the acting role against the rule’s role list, narrowed by the active configuration, and refuses with the permitted roles named.	URS-052
FRS-053	Each rule declares the ownership fields the acting user must not hold. The comparison is against the resolved application user id. The check applies to every role including administrator.	URS-053
FRS-054	Each rule may declare a stamps field, written with the acting user id in the same UPDATE as the state change and recorded as its own audit entry. A test asserts that no field named by any segregation rule is left unstamped by every transition — without it, a rule reads a column nothing writes and can never fire.	URS-054
FRS-055	Preconditions are named in the rule and evaluated against live data. A precondition declared but not evaluated fails closed with an internal error rather than being treated as met. Each returns a message naming what is outstanding.	URS-055
FRS-056	The no_open_child_records precondition queries dependent records and returns their identifiers in the refusal, so the user is not left searching.	URS-056
FRS-057	Rejection transitions require a reason and carry the Rejection signature meaning. They target only the originating state and touch no downstream field.	URS-057
FRS-058	capa_raised_if_required applies where criticality is four or above and requires an active link to a CAPA.	URS-058
FRS-059	deviation_raised_if_required exempts minor complaints and otherwise requires a linked deviation before QA review.	URS-059
FRS-060	capa_raised_for_critical_findings inspects recorded findings and requires a linked CAPA where any is critical or major.	URS-060
FRS-061	rca_complete is methodology-aware: five-whys requires a stated problem and at least three populated levels; fishbone requires factors in at least two categories; every methodology requires a designated primary root cause. Blank entries do not count towards the minimum.	URS-061
 
7. Electronic Signature
FRS	Mechanism	Addresses
FRS-070	Where a transition declares a signature meaning, the endpoint requires a password in the same request as the action and verifies it against the stored argon2id hash at that moment. Session validity is a precondition for reaching the endpoint, never a substitute for the signature.	URS-070
FRS-071	Verification occurs only in prepareSignature on the server. Signature components collect the password and pass it upward; they perform no comparison. The build gate fails on a local password comparison, and the component carries an explicit instruction not to add one for faster feedback.	URS-071
FRS-072	prepareSignature runs inside the transaction that applies the record change. A failure throws, rolling back the state change, the audit entry and the signature together. A test confirms that after a rejected signature the record remains at its original version with no audit entry and no signature row.	URS-072
FRS-073	The signatures table stores signer id, printed name and role captured at signing, meaning, reason, server timestamp, the record version signed, a content hash, and the identifier of the audit entry written in the same transaction.	URS-073
FRS-074	Meaning is one of Authorship, Review, Approval, Responsibility or Rejection, declared by the transition rule and enforced by a database CHECK constraint.	URS-074
FRS-075	The content hash is SHA-256 over a canonical serialisation with keys sorted at every level, computed server-side. Version, state and housekeeping timestamps are excluded: the state change is the consequence of the signature and is applied immediately after it, so including it would make every signature stop verifying at the moment it took effect — a check that can never run. Content changes therefore break the binding, which is what it exists to detect.	URS-075
FRS-076	UPDATE and DELETE on signatures are revoked from the application role and refused by a database trigger regardless of the connecting account.	URS-076
FRS-077	The acting user’s outstanding mandatory training is resolved when the session is established and checked in evaluateTransition before any signature is prepared.	URS-077
FRS-078	The record export renders each signature with printed name, role, meaning, reason, version signed, timestamp with offset, and the current state of its content binding.	URS-078
FRS-079	A failed verification raises SignatureError, which rolls back the transaction, leaving the record unchanged. The attempt is recorded in signature_attempts on a separate connection, so it survives that rollback — bookkeeping placed inside a transaction that will be rolled back is bookkeeping that never happens. Three consecutive failures within fifteen minutes lock the account and revoke its sessions; a successful signature resets the count. Update and delete on the attempt record are revoked from the application role.	URS-079
8. Audit Trail
FRS	Mechanism	Addresses
FRS-090	writeAudit is the only function permitted to insert into audit_trail. The build gate fails on any other insert. Creation, update, transition, signature, administrative action, configuration change, task action, training and export all route through it.	URS-090
FRS-091	Changes are diffed field by field and one entry written per changed field, carrying field name, previous value, new value, actor id, name and role, server timestamp and reason. Creation writes one entry with no field delta, because there is no previous value to record.	URS-091
FRS-092	The actor is resolved once from the verified session; an unresolved actor is a 401 and the action does not occur. writeAudit refuses an incomplete actor. A database trigger additionally rejects any insert whose user id is a placeholder or does not exist in users. Three independent layers, because this defect recurs.	URS-092
FRS-093	writeAudit takes the caller’s open transaction. Audit entries and the record change commit together or not at all. No audit write is deferred, queued or performed after commit.	URS-093
FRS-094	UPDATE, DELETE and TRUNCATE on audit_trail are revoked from the application role, and a BEFORE UPDATE OR DELETE trigger refuses regardless of the connecting account. Altering history therefore requires deliberately disabling a named trigger, which is itself evidence.	URS-094
FRS-095	Each entry carries a full SHA-256 over its own content and the preceding entry’s hash. The tail is read under a transaction-scoped advisory lock, so concurrent writes cannot read the same predecessor and fork the sequence. A unique index on the sequence number prevents duplicates.	URS-095
FRS-096	verifyAuditChain recomputes each hash from the entry’s own content and compares. It distinguishes altered content, a broken link, a missing hash, a sequence gap and a duplicate sequence, and reports the sequence number at which verification failed. Comparing only the linking fields, as the predecessor did, cannot detect an altered value.	URS-096
FRS-097	GET /api/audit is paginated, filterable by entity, record, user, action, date range and significance, and reports the total matching separately from the page. It requires the audit:read permission.	URS-097
FRS-098	Entries carry a significant flag, set for post-approval change, role change, account unlock, failed signature, cancellation, configuration change and export. A trail in which everything appears equally important is not reviewed.	URS-098
FRS-099	POST /api/audit/reviews records reviewer, period, entry count, the verification outcome at the time of review and the findings, with a signature. The row is immutable at database level.	URS-099
FRS-100	audit:review is held only by the quality approver role. Administrator does not hold it.	URS-100, URS-021
 
9. Task Management
FRS	Mechanism	Addresses
FRS-110	Tasks are rows against a parent record with description, owner, due date, status and version, governed by one service for both task types so neither can lose a control the other keeps.	URS-110
FRS-111	Assignment verifies the owner exists and is active. A task assigned to an inactive account could never be completed and would block its parent record indefinitely.	URS-111
FRS-112	Accept, reject and complete compare the acting user against the task owner and refuse a mismatch, naming the owner.	URS-112
FRS-113	requires_signature defaults to true per task. Where set, completion re-verifies the password and stores a Responsibility signature. Where cleared, completion is still audited. The flag is per task so that a signature on every administrative item — which produces signature fatigue — is avoidable.	URS-113
FRS-114	Rejection and cancellation require a reason and are marked significant. Cancellation requires quality authority.	URS-114
FRS-115	Overdue is evaluated by siteTime.ts against the site-local date. A completed, cancelled or rejected task is never reported overdue.	URS-115
10. Training
FRS	Mechanism	Addresses
FRS-120	A completion row carries the module version. A unique index on user, module and version means one row per version, so a version increment leaves the previous completion no longer satisfying the requirement.	URS-120, URS-125
FRS-121	Completion requires the current module version and is refused where the module has been superseded. Every question must be answered.	URS-121
FRS-122	The answer key is stripped before the module is sent to the browser. Scoring occurs on the server against the stored key and is compared to the module pass mark.	URS-122
FRS-123	A passing completion requires the trainee’s password and stores a Responsibility signature bound to the completion record.	URS-123
FRS-124	A failing attempt is stored with its score and written as a significant audit entry. A trail of successes alone cannot evidence competence.	URS-124
FRS-125	Outstanding training is computed as mandatory effective modules with no passing, unexpired completion at the current version, and is resolved when a session is established.	URS-125
11. Reporting, Lists and Export
FRS	Mechanism	Addresses
FRS-130	List endpoints return the records for the page, the total matching the filter, the page and size, the filters applied, and a flag indicating whether a filter is narrowing. The interface renders the total beside the page range; a response lacking the total is treated as a contract failure rather than displayed.	URS-130
FRS-131	No default filter is applied. A test transitions a record and asserts it still appears in the unfiltered list. Where a filter is applied the interface states so and offers to clear it.	URS-131
FRS-132	Search queries the database across every entity the caller may read, capped at five per entity with the true total beside each, and returns the list of entities actually searched.	URS-132
FRS-133	The record export is generated server-side from stored data and contains the record fields, every signature in full, and the record’s audit entries with a stated total.	URS-133
FRS-134	The rendered export carries a SHA-256 of its own bytes, verifiable afterwards with standard operating-system tools and nothing else.	URS-134
FRS-135	A draft export is watermarked DRAFT — NOT APPROVED and a cancelled or superseded one accordingly; only an approved record is marked a controlled copy.	URS-135
FRS-136	Audit export writes a significant audit entry recording the actor and the matching total.	URS-136
FRS-137	The export runs verifyAuditChain over the whole trail at generation and renders the verdict, including the failing sequence number where verification fails. Signature bindings are re-derived against the current content and reported individually.	URS-137
12. Configuration and Administration
FRS	Mechanism	Addresses
FRS-140	workflow_config versions are proposed as Draft and activated separately. Activation refuses where the acting user proposed it, requires a password and a reason, and supersedes the previous version. One active version is enforced by a partial unique index.	URS-140
FRS-141	validateConfig rejects a key naming a transition that does not exist, a role the transition does not already permit, a role list leaving nobody able to act, and disabling a step not marked optional. Configuration cannot reference a signature meaning or a precondition at all.	URS-141
FRS-142	operational_config versions each change with a mandatory reason and an audit entry, superseding the previous version. No signature is required: routing grants no authority, and a bad value produces a blocked action rather than an unguarded one.	URS-142
FRS-143	Superseded rows are retained; deletion is revoked from the application role.	URS-143
FRS-144	Message templates may interpolate only recordId, recordType, status, dueDate, recipientName and actionUrl. Any other variable is rejected, naming it. Without this a subject line could carry batch or investigation content into mailboxes outside the validated system.	URS-144
FRS-145	GET /api/admin/security-status reports locked accounts, overdue passwords, active sessions and failed sign-ins in the last day, excluding service principals so the queue can reach empty.	URS-145
13. Data Integrity, Security and Availability
FRS	Mechanism	Addresses
FRS-150	All GxP reads and writes go through the interface. The former browser store has been removed and the build gate fails on its reintroduction.	URS-150
FRS-151	No optimistic update is applied to a GxP write. The interface renders the record returned by the server. A network failure is reported as NETWORK_UNREACHABLE stating the change was not saved.	URS-151
FRS-152	On failure the entered values remain in the form and the error region states "Not saved" with the per-field messages and a correlation identifier. The build gate fails on an empty catch block.	URS-152
FRS-153	All timestamps are assigned by the server as timestamptz in UTC. Display renders site-local time with the offset shown. No client-supplied timestamp is stored on any GxP record.	URS-153
FRS-154	nginx terminates TLS 1.2 or 1.3 and redirects plain HTTP. The application binds to the loopback interface only, so the proxy is the sole ingress. HSTS, content-type, frame and referrer headers are set at both layers.	URS-154
FRS-155	The backup job produces a pg_dump custom-format archive with a SHA-256 checksum, verifies the checksum immediately, enforces retention and writes a failure marker on any error. RESTORE-TEST-001 defines the restore test, including verification of row counts, chain integrity and the presence of triggers and grants after restore.	URS-155
FRS-156	No restore function exists in the application. Restoration is a database administration procedure.	URS-156
FRS-157	Analytical assistance output is stored as a suggestion with status Pending and is never written to a record. A user accepts or rejects it explicitly; both the suggestion and the value actually committed are retained, and the decision is a significant audit entry distinguishing acceptance as suggested from acceptance with edits. Every request is recorded before it is made, with model, prompt version and the content sent.	URS-157
FRS-158	Where the feature is disabled or unconfigured the endpoint returns 503 with a plain message. There is no fallback content. A provider failure returns 502 and records the attempt with the payload that had been sent.	URS-158
 
14. Coverage
Every requirement in VAL/DMS/URS/001 is addressed by at least one item above. Traceability from requirement to functional item to test case is maintained in the Requirements Traceability Matrix, which is generated from the source rather than maintained by hand.
Note
The matrix records coverage only where a test explicitly declares the requirement it verifies. Where a requirement has no dedicated test, the matrix states so. An uncovered requirement declared as uncovered is the honest position, and the opposite of a matrix that reports verification which was never performed.
15. Approval
Role	Name / Title	Signature	Date
Prepared by (Validation)			
Reviewed by (System Owner)			
Reviewed by (QA)			
Approved by (QA Head)			
