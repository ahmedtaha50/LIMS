-- Review by exception, disposition and certified copies (E14, E15).
CREATE TABLE batch_reviews (
  batch_id      uuid PRIMARY KEY REFERENCES batches(id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete')),
  started_by    text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_by  text,
  completed_at  timestamptz,
  signature_id  bigint REFERENCES signatures(id),
  version       integer NOT NULL DEFAULT 1
);
CREATE TABLE batch_review_items (
  id               bigserial PRIMARY KEY,
  batch_id         uuid NOT NULL REFERENCES batches(id),
  item_key         text NOT NULL,
  kind             text NOT NULL,
  text             text NOT NULL,
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  note             text,
  signature_id     bigint REFERENCES signatures(id),
  UNIQUE (batch_id, item_key)
);
CREATE TABLE batch_dispositions (
  batch_id      uuid PRIMARY KEY REFERENCES batches(id),
  decision      text NOT NULL CHECK (decision IN ('released', 'rejected')),
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL,
  comment       text,
  signature_id  bigint NOT NULL REFERENCES signatures(id)
);
CREATE TABLE certified_copies (
  id            bigserial PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES batches(id),
  sha256        text NOT NULL UNIQUE,
  bytes         integer NOT NULL,
  generated_by  text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION review_records_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are never changed or deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER batch_dispositions_immutable BEFORE UPDATE OR DELETE ON batch_dispositions FOR EACH ROW EXECUTE FUNCTION review_records_immutable();
CREATE TRIGGER certified_copies_immutable BEFORE UPDATE OR DELETE ON certified_copies FOR EACH ROW EXECUTE FUNCTION review_records_immutable();
