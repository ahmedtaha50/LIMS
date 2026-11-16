-- Master batch records (E08, E09). A master is the product's recipe; its versions go draft -> in_review -> approved ->
-- effective -> retired. Only one version of a master is effective (unique index). Once a version has left draft, its
-- design can no longer change in the database, whatever the application does (trigger): a change is a new version.
CREATE TABLE mbr_masters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  product_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mbr_masters_code_key ON mbr_masters (lower(code));

CREATE TABLE mbr_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id     uuid NOT NULL REFERENCES mbr_masters(id),
  version_no    integer NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'effective', 'retired')),
  design        jsonb NOT NULL,
  based_on      uuid REFERENCES mbr_versions(id),
  author_id     text NOT NULL,
  author_name   text NOT NULL,
  approved_by   text,
  approved_at   timestamptz,
  effective_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (master_id, version_no)
);
CREATE UNIQUE INDEX mbr_versions_one_effective ON mbr_versions (master_id) WHERE status = 'effective';

CREATE FUNCTION mbr_versions_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'master batch record versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'draft' AND NEW.design IS DISTINCT FROM OLD.design THEN
    RAISE EXCEPTION 'version % is %: its design cannot change (create a new version)', OLD.version_no, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mbr_versions_frozen BEFORE UPDATE OR DELETE ON mbr_versions FOR EACH ROW EXECUTE FUNCTION mbr_versions_frozen();
