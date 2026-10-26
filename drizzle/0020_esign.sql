-- 0020_esign (roadmap M07): one e-signature service for every record type.
--
-- Why: signatures.sample_id was NOT NULL with a foreign key to samples, but a specification approval wrote the specification id into
-- it, the ELN fell back to the worksheet id and the batch release to the batch name. A fresh installation therefore could not approve
-- a specification, and so could not register a sample. The meaning of a signature came from the browser or from strings in the
-- routes, the signer's name and role were looked up again every time a signature was shown (a renamed user changed every old
-- manifestation), and a signature whose hash was 'N/A' verified as valid.
--
-- What this adds:
--   signature_meanings   the catalog: code, the text a signature prints, the roles that may use it, whether it needs a reason, and
--                        whether it is exempt from the software-training requirement (the training meanings themselves). The client
--                        sends only the code. Not append-only: a text or a role list is corrected with a migration, and every
--                        signature keeps the text it was signed with (signatures.meaning), so history cannot be rewritten by an edit.
--   signatures           sample_id becomes nullable (the foreign key stays for rows that belong to a sample), plus
--                          entity_type, entity_id   what was signed: any registered record type and its id
--                          meaning_code             the catalog entry (null for a legacy free-text meaning)
--                          signer_name, signer_role the printed name and role as they were when the signature was made
--                          auth_method              how the signer proved identity: password or password+totp
--                          hash_version             1 = the formulas of v0.1.0 (one per record type, some not recomputable),
--                                                   2 = the uniform formula of src/server/esign/hash.ts
--                        A version 2 row must carry all of them (CHECK); a version 1 row, which is what the signing routes that have
--                        not moved to signRecord yet still write, may leave them null and is read through its audit entry.
--
-- Existing rows: entity_type and entity_id are taken from the audit entry the signature points at (its entity and entity id), and
-- from the sample the signature was written against where there is none; meaning_code from the text where it is one the product
-- printed; signer_name and signer_role from the user record AS IT STANDS NOW (the true values at signing time were never stored,
-- which is what this migration ends); auth_method 'password'. These are the only columns written, and only on rows that have
-- nothing in them yet. The guard trigger on signatures refuses any update, so the backfill switches the table's user triggers off for
-- the length of one statement block and switches them on again; the block compares a digest of every hash-covered column before and
-- after and raises, rolling the whole migration back, if a single byte changed. This file therefore needs QA review: its
-- checksum is in the journal and in the SCHEMA_MIGRATED audit entry. The runner re-creates every guard before it commits in any case.

CREATE TABLE "signature_meanings" (
	"code" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"allowed_roles" text[] NOT NULL,
	"requires_reason" boolean DEFAULT false NOT NULL,
	"training_exempt" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);

-- The catalog is seeded only under the migration runner, which has journaled the earlier files by now (schema_migrations is not
-- empty). A restore replays this file into an EMPTY database to get the structure and then loads the rows of the backup, the
-- catalog included; a seed here would collide with them (duplicate key) and every script built from the migrations (desktop/schema.sql)
-- is meant to create structure and no rows.
INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('AUTHORSHIP', 'Authorship: I performed or recorded this work and confirm that it is accurate and complete.', ARRAY['Analyst','Reviewer','QA','Admin'], false, false),
	('SUBMIT_FOR_REVIEW', 'Review and verification of analytical results: I confirm that the results are accurate and complete and submit them for independent review.', ARRAY['Analyst','Admin'], false, false),
	('APPROVAL', 'Approval (release disposition): I have reviewed this record and approve it.', ARRAY['Reviewer','QA','Admin'], false, false),
	('REJECTION', 'Rejection (return or quarantine): I have reviewed this record and reject it.', ARRAY['Reviewer','QA','Admin'], true, false),
	('OOS_CLOSURE', 'OOS investigation closure and disposition approval: I confirm that the investigation, the root cause and the conclusion are complete.', ARRAY['QA','Admin'], true, false),
	('SPECIFICATION_APPROVAL', 'Master data approval: I approve this specification for use in testing.', ARRAY['QA','Admin'], false, false),
	('BATCH_RELEASE', 'Final batch release disposition: I authorise this batch for release.', ARRAY['QA','Admin'], false, false),
	('CALIBRATION', 'Calibration: I performed or witnessed this calibration and confirm that the result is recorded correctly.', ARRAY['Analyst','QA','Admin'], false, false),
	('RECEIPT', 'Receipt: I received this material and checked it against its certificate and the order.', ARRAY['Analyst','QA','Admin'], false, false),
	('TRAINING_ACKNOWLEDGEMENT', 'Training read and understood: I have read and understood this training material.', ARRAY['Analyst','Reviewer','QA','Admin'], false, true),
	('TRAINING_CERTIFICATION', 'Training certification: I confirm that this person has completed and understood the training.', ARRAY['QA','Admin'], false, true),
	('ADMIN_AUTHORISATION', 'Administrative authorisation: I authorise this change to a user account or a system setting.', ARRAY['Admin'], true, true)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

ALTER TABLE "signatures" ALTER COLUMN "sample_id" DROP NOT NULL;
ALTER TABLE "signatures" ADD COLUMN "entity_type" text;
ALTER TABLE "signatures" ADD COLUMN "entity_id" text;
ALTER TABLE "signatures" ADD COLUMN "meaning_code" text;
ALTER TABLE "signatures" ADD COLUMN "signer_name" text;
ALTER TABLE "signatures" ADD COLUMN "signer_role" text;
ALTER TABLE "signatures" ADD COLUMN "auth_method" text;
ALTER TABLE "signatures" ADD COLUMN "hash_version" integer DEFAULT 1 NOT NULL;

DO $$
DECLARE
	before_digest text;
	after_digest text;
BEGIN
	SELECT md5(coalesce(string_agg(row(id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id)::text, '|' ORDER BY id), ''))
		INTO before_digest FROM "signatures";

	ALTER TABLE "signatures" DISABLE TRIGGER USER;

	UPDATE "signatures" s SET
		"entity_type" = q.entity_type,
		"entity_id" = q.entity_id,
		"meaning_code" = q.meaning_code,
		"signer_name" = q.signer_name,
		"signer_role" = q.signer_role,
		"auth_method" = 'password'
	FROM (
		SELECT sg.id,
			coalesce(a.entity, 'Sample') AS entity_type,
			coalesce(a.entity_id, sg.sample_id) AS entity_id,
			CASE sg.meaning
				WHEN 'Approval (Release Disposition)' THEN 'APPROVAL'
				WHEN 'Rejection (Return / Quarantine)' THEN 'REJECTION'
				WHEN 'Review & Verification of Analytical Results' THEN 'SUBMIT_FOR_REVIEW'
				WHEN 'OOS Investigation Closure & Disposition Approval' THEN 'OOS_CLOSURE'
				WHEN 'Master Data Approval' THEN 'SPECIFICATION_APPROVAL'
				WHEN 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)' THEN 'BATCH_RELEASE'
				WHEN 'I am the author of this observation' THEN 'AUTHORSHIP'
				WHEN 'Authorship' THEN 'AUTHORSHIP'
				WHEN 'Authorship & Verification of Laboratory Records (21 CFR Part 11)' THEN 'AUTHORSHIP'
				ELSE NULL
			END AS meaning_code,
			coalesce(u.name, sg.signer_id) AS signer_name,
			coalesce(u.role, 'Unknown') AS signer_role
		FROM "signatures" sg
		LEFT JOIN "audit_trail" a ON a.id = sg.audit_entry_id
		LEFT JOIN "users" u ON u.id = sg.signer_id
	) q
	WHERE q.id = s.id AND s.entity_type IS NULL;

	ALTER TABLE "signatures" ENABLE TRIGGER USER;

	SELECT md5(coalesce(string_agg(row(id, sample_id, signer_id, meaning, reason, "timestamp", record_version, content_hash, audit_entry_id)::text, '|' ORDER BY id), ''))
		INTO after_digest FROM "signatures";
	IF before_digest IS DISTINCT FROM after_digest THEN
		RAISE EXCEPTION '0020_esign: the backfill changed a column of signatures that the signature hash covers; nothing was applied.';
	END IF;
END $$;

ALTER TABLE "signatures" ADD CONSTRAINT "signatures_meaning_code_signature_meanings_code_fk" FOREIGN KEY ("meaning_code") REFERENCES "public"."signature_meanings"("code") ON DELETE no action ON UPDATE no action;
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_v2_complete" CHECK ("signatures"."hash_version" < 2 OR ("signatures"."entity_type" IS NOT NULL AND "signatures"."entity_id" IS NOT NULL AND "signatures"."meaning_code" IS NOT NULL AND "signatures"."signer_name" IS NOT NULL AND "signatures"."signer_role" IS NOT NULL AND "signatures"."auth_method" IS NOT NULL));

CREATE INDEX "signatures_entity_idx" ON "signatures" USING btree ("entity_type","entity_id");
