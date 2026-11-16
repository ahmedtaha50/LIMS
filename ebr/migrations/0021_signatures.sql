-- Electronic signatures (E04): signer, meaning, server time, and the exact version and content hash of the record signed.
CREATE TABLE signatures (
  id             bigserial PRIMARY KEY,
  entity         text NOT NULL,
  entity_id      text NOT NULL,
  record_version integer NOT NULL,
  record_hash    text NOT NULL,
  meaning        text NOT NULL,
  signer_id      text NOT NULL,
  signer_name    text NOT NULL,
  signed_at      timestamptz NOT NULL,
  comment        text
);
CREATE INDEX signatures_entity_idx ON signatures (entity, entity_id, id);

CREATE FUNCTION signatures_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signatures are permanent: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER signatures_no_update BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION signatures_immutable();
