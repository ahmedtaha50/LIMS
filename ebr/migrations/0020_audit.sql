-- The audit trail (E03). Written in the same transaction as the change it records; hash-chained; never changed.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  actor_id    text,
  actor_name  text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  request_id  text,
  prev_hash   text NOT NULL,
  hash        text NOT NULL UNIQUE
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id);

-- Nobody changes or removes an entry, the application's own role included: corrections are new entries.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
