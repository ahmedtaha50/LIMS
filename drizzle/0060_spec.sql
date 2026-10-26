-- 0060_spec (roadmap M11): the revision of a specification is not the optimistic-concurrency counter, and a specification has an author.
--
-- Why: specifications.version was both. The create form let the user type it, every edit added 1 and the approval added 1 more, so a
-- first revision edited once and approved showed "v3". Nothing recorded who wrote a specification, so nothing could stop the author
-- from approving it (21 CFR 211.160, 211.165 master data; Annex 11 s.12 segregation of duties).
--
-- What this adds to specifications (all additive; version, status, effective_date and parameters are not touched):
--   revision_label  integer NOT NULL DEFAULT 1   the revision, per material, assigned by the server. Existing rows are numbered per
--                                                material in the order they take effect: effective date, then the order the audit
--                                                trail saw them created, then id. (The ties and the unaudited rows are the only place
--                                                a judgement is made; the numbering is a label, not a record: nothing signed covers it.)
--   created_by      text -> users(id), nullable   the author, read from the first Create entry of the audit trail. Null where the
--                                                installation never audited the creation (the demo seed): such a row is already Active.
--   approved_by     text -> users(id), nullable   the approver, read from the latest Approve entry, for Active and Obsolete rows only.
-- and the unique index (material, revision_label): two revisions of one material cannot share a number, whatever the application does.
--
-- audit_trail and signatures are only read here. The migration writes no row of either.

ALTER TABLE "specifications" ADD COLUMN "revision_label" integer DEFAULT 1 NOT NULL;
ALTER TABLE "specifications" ADD COLUMN "created_by" text;
ALTER TABLE "specifications" ADD COLUMN "approved_by" text;

UPDATE "specifications" s SET "revision_label" = ranked.rev
FROM (
	SELECT sp.id,
		row_number() OVER (PARTITION BY sp.material ORDER BY sp.effective_date, created.first_sequence NULLS LAST, sp.id) AS rev
	FROM "specifications" sp
	LEFT JOIN LATERAL (
		SELECT min(a."sequence") AS first_sequence
		FROM "audit_trail" a
		WHERE a.entity = 'Specification' AND a.entity_id = sp.id AND a.action = 'Create'
	) created ON true
) ranked
WHERE ranked.id = s.id;

UPDATE "specifications" s SET "created_by" = a.user_id
FROM (
	SELECT DISTINCT ON (entity_id) entity_id, user_id
	FROM "audit_trail"
	WHERE entity = 'Specification' AND action = 'Create'
	ORDER BY entity_id, "sequence" ASC
) a
WHERE a.entity_id = s.id AND EXISTS (SELECT 1 FROM "users" u WHERE u.id = a.user_id);

UPDATE "specifications" s SET "approved_by" = a.user_id
FROM (
	SELECT DISTINCT ON (entity_id) entity_id, user_id
	FROM "audit_trail"
	WHERE entity = 'Specification' AND action = 'Approve'
	ORDER BY entity_id, "sequence" DESC
) a
WHERE a.entity_id = s.id AND s.status IN ('Active', 'Obsolete') AND EXISTS (SELECT 1 FROM "users" u WHERE u.id = a.user_id);

CREATE UNIQUE INDEX "specifications_material_revision_uq" ON "specifications" USING btree ("material","revision_label");
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "specifications_created_by_idx" ON "specifications" USING btree ("created_by");
CREATE INDEX "specifications_approved_by_idx" ON "specifications" USING btree ("approved_by");
