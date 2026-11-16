-- Logbooks (E06, E07, E21). A logbook TYPE defines what can be written (entry kinds and their fields); users create types,
-- QA approves each version. A LOGBOOK belongs to one object (equipment, room, area, instrument, process, other) and is
-- written in with signed ENTRIES that are never changed: a correction is a new entry pointing at the old one.
CREATE TABLE logbook_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  built_in    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX logbook_types_code_key ON logbook_types (lower(code));

CREATE TABLE logbook_type_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id      uuid NOT NULL REFERENCES logbook_types(id),
  version_no   integer NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'effective', 'retired')),
  definition   jsonb NOT NULL,
  author_id    text NOT NULL,
  author_name  text NOT NULL,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (type_id, version_no)
);
-- one effective version per type, enforced by the database
CREATE UNIQUE INDEX logbook_type_versions_one_effective ON logbook_type_versions (type_id) WHERE status = 'effective';

CREATE TABLE logbooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id      uuid NOT NULL REFERENCES logbook_types(id),
  object_kind  text NOT NULL CHECK (object_kind IN ('equipment', 'room', 'area', 'instrument', 'process', 'other')),
  object_code  text NOT NULL,
  name         text NOT NULL,
  location     text NOT NULL DEFAULT '',
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX logbooks_object_key ON logbooks (object_kind, lower(object_code));

CREATE TABLE logbook_entries (
  id                 bigserial PRIMARY KEY,
  logbook_id         uuid NOT NULL REFERENCES logbooks(id),
  type_version_id    uuid NOT NULL REFERENCES logbook_type_versions(id),
  kind               text NOT NULL,
  "values"           jsonb NOT NULL,
  flags              jsonb NOT NULL DEFAULT '[]'::jsonb,
  comment            text,
  author_id          text NOT NULL,
  author_name        text NOT NULL,
  recorded_at        timestamptz NOT NULL,
  corrects_entry_id  bigint REFERENCES logbook_entries(id),
  correction_reason  text,
  signature_id       bigint NOT NULL REFERENCES signatures(id),
  CHECK ((corrects_entry_id IS NULL) = (correction_reason IS NULL))
);
CREATE INDEX logbook_entries_logbook_idx ON logbook_entries (logbook_id, id);

CREATE FUNCTION logbook_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'logbook entries are never changed: % is not allowed (write a correction)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER logbook_entries_no_update BEFORE UPDATE OR DELETE ON logbook_entries FOR EACH ROW EXECUTE FUNCTION logbook_entries_immutable();
