# Project Core Directives & Standards (GxP / QMS / LIMS)

This project is a highly regulated system. Every new feature, code modification, or architectural decision MUST strictly adhere to the following standards.

## 1. Core Technologies Used
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS.
- **Backend:** Node.js, Express.js.
- **Database:** PostgreSQL 16 using Drizzle ORM, with forward-only versioned migrations (`drizzle/`). On the desktop it is the built-in database (a private cluster started by the shell) or an existing PostgreSQL chosen at set-up. There is no cloud database.
- **Authentication:** Local accounts in PostgreSQL (`users`): scrypt password hashes, a signed bearer token (JWT, `JWT_SECRET`) that `requireAuth` resolves to the `users` row on every request, and TOTP as the second factor (otplib). Optional directory (LDAP / Active Directory) sign-on. Firebase is not used and must not be reintroduced.
- **Real-time & Async:** Socket.io (WebSockets). Background work goes through `publishTask`, which writes to the `jobs` table in PostgreSQL (the database is the source of truth); RabbitMQ (`QUEUE_DRIVER=amqp`) is optional and only wakes workers sooner. Schedules are rows in the database; node-cron only ticks the scheduler once a minute.
- **AI Integration:** `@google/genai` (Gemini AI), behind the egress control in `src/server/routes/ai.ts`; outside the validated scope until QA declares it.
- **Security & Validation:** Zod (strict schema validation), scrypt (Node crypto) for passwords, Helmet, Express Rate Limit.
- **Reporting:** jsPDF, jspdf-autotable, html2canvas. `xlsx` and `bcryptjs` are not used (they are still in package.json, but no source file imports them): do not build on them.

## 2. Regulatory Compliance (21 CFR Part 11 & ALCOA+)
Any new feature MUST adhere to the following regulatory standards:
- **Immutable Audit Trail:** Every creation, update, or deletion must be logged in the `audit_trail` table within the SAME database transaction. The log must include `userId`, `action`, `entity`, `oldValue`, `newValue`, and a cryptographic hash.
- **Electronic Signatures:** E-signatures must explicitly capture the meaning (e.g., Authorship, Approval, Training Read and Understood) and be linked to the specific `recordVersion`.
- **Optimistic Concurrency Control:** All updates must check the `version` field in the WHERE clause (`WHERE id = $1 AND version = $2`) to prevent data overwriting by concurrent users.

## 3. UI/UX & Guardrail Patterns
- **Context-Aware Exemptions (The SignatureModal Rule):** When using global guardrails (e.g., blocking e-signatures if `hasCompletedSoftwareTraining` is false), the system MUST provide a programmatic bypass for the specific entity granting that requirement. (e.g., allow signing the "Training" module itself without requiring prior training completion).
- **No Silent Failures:** Every user action must have explicit feedback. If validation fails (e.g., failing a quiz), the UI must display a clear `toast.error` (or equivalent) explaining the failure. Never use `alert()` or swallow errors.
- **Data Validation:** Use `.strict()` Zod schemas for all API inputs. Server-controlled fields (like `id`, `status`, `version`, `signatures`) must be stripped from user input schemas.

## 4. Backend & Async Processing
- **Queue System:** Long-running tasks (like PDF generation or complex AI analysis) should be queued with `publishTask` (the `jobs` table) and processed by a job handler, rather than blocking the Express HTTP response.
- **Scheduled Jobs:** Critical maintenance (like automated database backups) is a schedule in `src/server/schedules/` run by the database-backed scheduler, under a named service principal.
- **Actor Resolution:** The actor (user) must be resolved at the top of every Express handler via `req.user` (set by `requireAuth` from the bearer token). No fallbacks to 'system' or client-provided identities are allowed for compliance records.
