-- Immutability triggers exactly as v0.1.0 installed them (src/db/protections.ts at commit cc95dbb, ensureProtections()).
-- v0.1.0 ran these at every server start; the upgrade must preserve them.
CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gxp_signature_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.audit_entry_id = 'pending' AND NEW.audit_entry_id <> 'pending'
         AND (to_jsonb(NEW) - 'audit_entry_id') = (to_jsonb(OLD) - 'audit_entry_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'GxP: % on signatures is not permitted (append-only record)', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gxp_audit_trail_row_guard ON audit_trail;

CREATE TRIGGER gxp_audit_trail_row_guard BEFORE UPDATE OR DELETE ON audit_trail FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();

DROP TRIGGER IF EXISTS gxp_audit_trail_truncate_guard ON audit_trail;

CREATE TRIGGER gxp_audit_trail_truncate_guard BEFORE TRUNCATE ON audit_trail FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

DROP TRIGGER IF EXISTS gxp_signatures_row_guard ON signatures;

CREATE TRIGGER gxp_signatures_row_guard BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION gxp_signature_guard();

DROP TRIGGER IF EXISTS gxp_signatures_truncate_guard ON signatures;

CREATE TRIGGER gxp_signatures_truncate_guard BEFORE TRUNCATE ON signatures FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
