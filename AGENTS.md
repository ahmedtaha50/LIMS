# Project Core Directives & Standards (GxP / QMS / LIMS)

This project is a highly regulated system. Every new feature, code modification, or architectural decision MUST strictly adhere to the following standards.

## 1. Core Technologies Used
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS.
- **Backend:** Node.js, Express.js.
- **Database:** PostgreSQL (via Cloud SQL) using Drizzle ORM.
- **Authentication:** Local accounts in PostgreSQL (`users`): scrypt password hashes, a signed bearer token (JWT, `JWT_SECRET`) that `requireAuth` resolves to the `users` row on every request, and TOTP as the second factor (otplib). Firebase is not used and must not be reintroduced.
- **Real-time & Async:** Socket.io (WebSockets), RabbitMQ (amqplib) for task queues, node-cron for scheduled backups.
- **AI Integration:** `@google/genai` (Gemini AI) for risk analysis and CAPA generation.
- **Security & Validation:** Zod (strict schema validation), bcryptjs, Helmet, Express Rate Limit.
- **Reporting:** jsPDF, jspdf-autotable, xlsx, html2canvas.

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
- **Queue System:** Long-running tasks (like PDF generation or complex AI analysis) should be pushed to RabbitMQ (`publishTask`) and processed by consumers, rather than blocking the Express HTTP response.
- **Cron Jobs:** Critical maintenance (like automated database backups) runs via `node-cron` directly on the server layer.
- **Actor Resolution:** The actor (user) must be resolved at the top of every Express handler via `req.user` (set by `requireAuth` from the bearer token). No fallbacks to 'system' or client-provided identities are allowed for compliance records.
