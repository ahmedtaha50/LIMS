-- 0280_tat: turnaround time and the business calendar (roadmap M34, r2-tat-kpi).
--
-- What this adds, and why:
--   business_calendar   one row ('default'): the weekend days (0 Sunday ... 6 Saturday) and the time zone days are counted in.
--   business_holidays   days that do not count towards a due date.
--   tat_sla_rules       the business days allowed per priority (Routine, Urgent, Critical).
--   sample_tat          1:1 with samples (the samples table is frozen: its columns feed signed hashes): priority, the clock start (the
--                       receipt), the SLA applied and the due date calculated from them.
--
-- No rows are written here: a calendar or rule that has not been saved uses the built-in default (Saturday and Sunday, UTC, no holidays;
-- Routine 10, Urgent 3, Critical 1 business days), shown as such on the screen. Cycle time is not stored; it is derived from the immutable
-- audit trail. All writes to these tables are audited by the application in the same transaction.

CREATE TABLE "business_calendar" (
	"id" text PRIMARY KEY NOT NULL,
	"weekend_days" integer[] NOT NULL,
	"time_zone" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "business_calendar_id_check" CHECK ("business_calendar"."id" = 'default'),
	CONSTRAINT "business_calendar_weekend_check" CHECK ("business_calendar"."weekend_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6] AND cardinality("business_calendar"."weekend_days") <= 6)
);

CREATE TABLE "business_holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"holiday_date" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "business_holidays_date_check" CHECK ("business_holidays"."holiday_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

CREATE TABLE "sample_tat" (
	"id" text PRIMARY KEY NOT NULL,
	"priority" text DEFAULT 'Routine' NOT NULL,
	"started_at" timestamp with time zone,
	"sla_business_days" integer,
	"due_at" timestamp with time zone,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sample_tat_priority_check" CHECK ("sample_tat"."priority" IN ('Routine', 'Urgent', 'Critical')),
	CONSTRAINT "sample_tat_clock_check" CHECK (("sample_tat"."due_at" IS NULL) = ("sample_tat"."started_at" IS NULL))
);

CREATE TABLE "tat_sla_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"business_days" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tat_sla_rules_priority_check" CHECK ("tat_sla_rules"."id" IN ('Routine', 'Urgent', 'Critical')),
	CONSTRAINT "tat_sla_rules_days_check" CHECK ("tat_sla_rules"."business_days" BETWEEN 1 AND 365)
);

ALTER TABLE "business_calendar" ADD CONSTRAINT "business_calendar_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_holidays" ADD CONSTRAINT "business_holidays_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_tat" ADD CONSTRAINT "sample_tat_id_samples_id_fk" FOREIGN KEY ("id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_tat" ADD CONSTRAINT "sample_tat_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tat_sla_rules" ADD CONSTRAINT "tat_sla_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "business_calendar_updated_by_idx" ON "business_calendar" USING btree ("updated_by");
CREATE UNIQUE INDEX "business_holidays_date_uidx" ON "business_holidays" USING btree ("holiday_date");
CREATE INDEX "business_holidays_created_by_idx" ON "business_holidays" USING btree ("created_by");
CREATE INDEX "sample_tat_due_at_idx" ON "sample_tat" USING btree ("due_at");
CREATE INDEX "sample_tat_set_by_idx" ON "sample_tat" USING btree ("set_by");
CREATE INDEX "tat_sla_rules_updated_by_idx" ON "tat_sla_rules" USING btree ("updated_by");
