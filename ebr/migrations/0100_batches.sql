-- Batch execution (E10, E11). A batch is made from ONE effective MBR version and keeps a reference to it; its steps are
-- copied from that version at creation, in order. A recorded step is never changed (trigger); a verification adds the
-- second person's signature to it and nothing else.
CREATE TABLE batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number    text NOT NULL,
  mbr_master_id   uuid NOT NULL REFERENCES mbr_masters(id),
  mbr_version_id  uuid NOT NULL REFERENCES mbr_versions(id),
  product_name    text NOT NULL,
  batch_size      jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'in_progress', 'completed', 'in_review', 'released', 'rejected', 'cancelled')),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX batches_number_key ON batches (lower(batch_number));

CREATE TABLE batch_steps (
  id                   bigserial PRIMARY KEY,
  batch_id             uuid NOT NULL REFERENCES batches(id),
  seq                  integer NOT NULL,
  phase_key            text NOT NULL,
  phase_label          text NOT NULL,
  step_key             text NOT NULL,
  definition           jsonb NOT NULL,
  state                text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  value                jsonb,
  comment              text,
  performed_by         text,
  performed_name       text,
  performed_at         timestamptz,
  signature_id         bigint REFERENCES signatures(id),
  verified_by          text,
  verified_name        text,
  verified_at          timestamptz,
  verify_signature_id  bigint REFERENCES signatures(id),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (batch_id, seq),
  UNIQUE (batch_id, phase_key, step_key)
);

CREATE FUNCTION batch_steps_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'batch steps are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.state = 'done' AND (NEW.value IS DISTINCT FROM OLD.value OR NEW.performed_by IS DISTINCT FROM OLD.performed_by
      OR NEW.performed_at IS DISTINCT FROM OLD.performed_at OR NEW.signature_id IS DISTINCT FROM OLD.signature_id
      OR NEW.comment IS DISTINCT FROM OLD.comment OR NEW.state <> 'done' OR NEW.definition IS DISTINCT FROM OLD.definition
      OR (OLD.verify_signature_id IS NOT NULL AND NEW.verify_signature_id IS DISTINCT FROM OLD.verify_signature_id)) THEN
    RAISE EXCEPTION 'step % is recorded: it cannot change', OLD.seq USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_steps_recorded BEFORE UPDATE OR DELETE ON batch_steps FOR EACH ROW EXECUTE FUNCTION batch_steps_recorded();

CREATE TABLE batch_exceptions (
  id                bigserial PRIMARY KEY,
  batch_id          uuid NOT NULL REFERENCES batches(id),
  step_id           bigint NOT NULL REFERENCES batch_steps(id),
  kind              text NOT NULL,
  message           text NOT NULL,
  comment           text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  deviation_number  text,
  raised_by         text NOT NULL,
  raised_at         timestamptz NOT NULL DEFAULT now(),
  closed_by         text,
  closed_at         timestamptz,
  close_note        text,
  version           integer NOT NULL DEFAULT 1
);
CREATE INDEX batch_exceptions_batch_idx ON batch_exceptions (batch_id, status);
