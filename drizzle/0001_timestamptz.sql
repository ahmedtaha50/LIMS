-- 0001_timestamptz: every timestamp column becomes timestamptz, and the database time zone becomes UTC.
--
-- Why. The v0.1.0 columns were `timestamp without time zone`. DEFAULT now() stored the wall clock of the PostgreSQL session zone,
-- the application stored the UTC wall clock of a JavaScript Date, and drizzle read both back as UTC: on a machine whose zone is not
-- UTC (Cairo: +2/+3 h) the two kinds of value differed by the zone offset, and a backup/restore moved them again by the offset of
-- the machine that ran it. A timestamptz is an absolute instant; neither the session zone nor the client zone can change it.
--
-- Rule for existing values: a naive value is read as UTC, which is exactly how the application has always displayed it, so every
-- value reads back the same instant it showed before the migration. Values that v0.1.0 wrote through DEFAULT now() on a database
-- whose zone was not UTC keep the offset they always had; audit_trail.timestamp_str (the value the hash chain covers) is untouched.
--
-- Append-only tables (audit_trail, signatures): this is a column type change, not an UPDATE; the row triggers do not fire, no
-- value of the hash chain or of a signature changes, and the migration adds no row to them (the runner appends its own audit entry).

ALTER TABLE "audit_trail"
  ALTER COLUMN "timestamp" DROP DEFAULT,
  ALTER COLUMN "timestamp" TYPE timestamp with time zone USING "timestamp" AT TIME ZONE 'UTC',
  ALTER COLUMN "timestamp" SET DEFAULT now();

ALTER TABLE "batch_materials"
  ALTER COLUMN "dispensed_at" DROP DEFAULT,
  ALTER COLUMN "dispensed_at" TYPE timestamp with time zone USING "dispensed_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "dispensed_at" SET DEFAULT now();

ALTER TABLE "batch_releases"
  ALTER COLUMN "released_at" TYPE timestamp with time zone USING "released_at" AT TIME ZONE 'UTC';

ALTER TABLE "jobs"
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" SET DEFAULT now(),
  ALTER COLUMN "updated_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE "lab_notebook"
  ALTER COLUMN "entered_at" DROP DEFAULT,
  ALTER COLUMN "entered_at" TYPE timestamp with time zone USING "entered_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "entered_at" SET DEFAULT now(),
  ALTER COLUMN "signed_at" TYPE timestamp with time zone USING "signed_at" AT TIME ZONE 'UTC';

ALTER TABLE "results"
  ALTER COLUMN "entered_at" TYPE timestamp with time zone USING "entered_at" AT TIME ZONE 'UTC';

ALTER TABLE "samples"
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" SET DEFAULT now();

ALTER TABLE "signatures"
  ALTER COLUMN "timestamp" DROP DEFAULT,
  ALTER COLUMN "timestamp" TYPE timestamp with time zone USING "timestamp" AT TIME ZONE 'UTC',
  ALTER COLUMN "timestamp" SET DEFAULT now();

ALTER TABLE "system_settings"
  ALTER COLUMN "updated_at" DROP DEFAULT,
  ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE "training_records"
  ALTER COLUMN "completed_at" TYPE timestamp with time zone USING "completed_at" AT TIME ZONE 'UTC';

ALTER TABLE "users"
  ALTER COLUMN "password_changed_at" DROP DEFAULT,
  ALTER COLUMN "password_changed_at" TYPE timestamp with time zone USING "password_changed_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "password_changed_at" SET DEFAULT now(),
  ALTER COLUMN "locked_at" TYPE timestamp with time zone USING "locked_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" DROP DEFAULT,
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" SET DEFAULT now();

-- Database default zone. The application also forces UTC on every connection it opens (src/db/index.ts), so this only matters
-- for other clients (psql, reports); if the role may not change the database setting, say so loudly instead of failing the upgrade.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not set the default time zone of database % to UTC (insufficient privilege). Timestamps are unaffected; ask a database owner to run: ALTER DATABASE % SET timezone TO ''UTC''', current_database(), current_database();
END
$$;
