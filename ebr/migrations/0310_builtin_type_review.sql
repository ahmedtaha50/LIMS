-- QA review of the built-in logbook types (E28). The equipment and room definitions installed by 0031 were made effective
-- by the installation, not approved by QA: they need a QA review (signature, meaning reviewed) before anything is written
-- with them. A version approved by QA through the normal path never needs it.
ALTER TABLE logbook_type_versions
  ADD COLUMN needs_qa_review boolean NOT NULL DEFAULT false,
  ADD COLUMN qa_reviewed_by  text,
  ADD COLUMN qa_reviewed_at  timestamptz;
UPDATE logbook_type_versions v SET needs_qa_review = true
  FROM logbook_types t WHERE t.id = v.type_id AND t.built_in AND v.author_id = 'installation';   -- made by 0031, not approved by QA

-- Second line of defence: whatever path writes an entry (the logbook screen, the batch interlock, a future one), the
-- database refuses it while the type version still waits for its QA review.
CREATE FUNCTION logbook_entry_type_reviewed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT needs_qa_review FROM logbook_type_versions WHERE id = NEW.type_version_id) THEN
    RAISE EXCEPTION 'logbook type version % waits for its QA review: nothing can be written with it', NEW.type_version_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER logbook_entries_type_reviewed BEFORE INSERT ON logbook_entries FOR EACH ROW EXECUTE FUNCTION logbook_entry_type_reviewed();
