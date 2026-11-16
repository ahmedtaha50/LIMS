-- Site settings (E27): only values an administrator changed are stored; defaults live in server/settings/index.ts.
-- Every change is signed (signatures, entity 'site_setting') and audited with the old and new value.
CREATE TABLE site_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  version     integer NOT NULL CHECK (version >= 1),
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION site_settings_not_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'site settings are changed, never deleted (set the default value back instead)';
END $$;
CREATE TRIGGER site_settings_no_delete BEFORE DELETE OR TRUNCATE ON site_settings FOR EACH STATEMENT EXECUTE FUNCTION site_settings_not_deleted();
