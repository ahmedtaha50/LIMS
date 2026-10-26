-- 0003_indexes: the secondary indexes the application's queries need. v0.1.0 had none beyond the primary keys, and PostgreSQL
-- does not index foreign keys, so every "results of this sample", "signatures of this sample" and "samples of this batch" was a scan.
--
-- Each index below serves a query that exists today:
--   results(sample_id)                      sample detail, CoA/PDF, batch report, traceability, transition checks
--   signatures(sample_id, timestamp)        sample detail and ELN (newest signature first), batch report
--   samples(batch)                          batch release, batch report, traceability
--   samples(material)                       reports filter and spec lookup by material
--   samples(state)                          dashboard and list filters
--   samples(created_at)                     sample list (newest first) and trend reports
--   oos_investigations(sample_id, status)   "open investigation for this sample" gate in batch release
--   oos_investigations(result_id)           investigation of a result
--   lab_notebook(sample_id, entered_at)     notebook entries of a sample, oldest first
--   batch_materials(batch)                  batch traceability
--   training_records(user_id)               a user's training records
--   specifications(material, status)        "the Active specification of this material" on every registration
--   audit_trail(entity, entity_id)          the history of one record
--   audit_trail(user_id)                    what one user did

CREATE INDEX "results_sample_id_idx" ON "results" USING btree ("sample_id");
CREATE INDEX "signatures_sample_id_timestamp_idx" ON "signatures" USING btree ("sample_id","timestamp");
CREATE INDEX "samples_batch_idx" ON "samples" USING btree ("batch");
CREATE INDEX "samples_material_idx" ON "samples" USING btree ("material");
CREATE INDEX "samples_state_idx" ON "samples" USING btree ("state");
CREATE INDEX "samples_created_at_idx" ON "samples" USING btree ("created_at");
CREATE INDEX "oos_investigations_sample_id_status_idx" ON "oos_investigations" USING btree ("sample_id","status");
CREATE INDEX "oos_investigations_result_id_idx" ON "oos_investigations" USING btree ("result_id");
CREATE INDEX "lab_notebook_sample_id_entered_at_idx" ON "lab_notebook" USING btree ("sample_id","entered_at");
CREATE INDEX "batch_materials_batch_idx" ON "batch_materials" USING btree ("batch");
CREATE INDEX "training_records_user_id_idx" ON "training_records" USING btree ("user_id");
CREATE INDEX "specifications_material_status_idx" ON "specifications" USING btree ("material","status");
CREATE INDEX "audit_trail_entity_idx" ON "audit_trail" USING btree ("entity","entity_id");
CREATE INDEX "audit_trail_user_id_idx" ON "audit_trail" USING btree ("user_id");
