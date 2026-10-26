-- 0050_results_oos (roadmap M10): results are judged against the limit they were registered with, a sample keeps the
-- specification revision it was registered under, and an OOS investigation has a phase, a decision and one open record per result.
--
-- Why: v0.1.0 judged a result with parseFloat against spec_min / spec_max, which are `real` (0.005 reads back as 0.004999999888) and
-- carry no limit kind and no declared decimals, so USP 7.20 rounding was impossible; registration took "the" Active specification
-- of the material and kept no reference to it; nothing stopped two open investigations for one result (21 CFR 211.192, 211.194;
-- Annex 11 s.5 data, s.6 accuracy checks).
--
-- What this adds (all additive and nullable; no existing row is changed, the columns the signature hashes cover are untouched):
--   results.unit, limit_kind, lower_text, upper_text, decimals, acceptance_text
--                       the limit copied from the specification revision at registration, limits as decimal text. NULL on rows written
--                       before this migration: the evaluator then reads spec_min / spec_max and compares without rounding.
--   samples.spec_id -> specifications(id), samples.spec_revision
--                       the revision the sample is tested against. NULL on samples registered before this migration.
--   oos_investigations.phase, decision
--                       Phase I | Phase II | Pending QA while open; the outcome QA signs on closure. NULL on old rows.
--   oos_investigations_one_open_per_result_uidx
--                       at most one investigation per result that is not Closed (or v0.1.0's Approved).
--
-- audit_trail and signatures are not touched.

ALTER TABLE "results" ADD COLUMN "unit" text;
ALTER TABLE "results" ADD COLUMN "limit_kind" text;
ALTER TABLE "results" ADD COLUMN "lower_text" text;
ALTER TABLE "results" ADD COLUMN "upper_text" text;
ALTER TABLE "results" ADD COLUMN "decimals" integer;
ALTER TABLE "results" ADD COLUMN "acceptance_text" text;

ALTER TABLE "samples" ADD COLUMN "spec_id" text;
ALTER TABLE "samples" ADD COLUMN "spec_revision" integer;
ALTER TABLE "samples" ADD CONSTRAINT "samples_spec_id_specifications_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specifications"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "samples_spec_id_idx" ON "samples" USING btree ("spec_id");

ALTER TABLE "oos_investigations" ADD COLUMN "phase" text;
ALTER TABLE "oos_investigations" ADD COLUMN "decision" text;
CREATE UNIQUE INDEX "oos_investigations_one_open_per_result_uidx" ON "oos_investigations" USING btree ("result_id") WHERE "oos_investigations"."status" NOT IN ('Closed', 'Approved');
