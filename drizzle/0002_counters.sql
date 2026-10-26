-- 0002_counters: gap-free counters behind nextSequence(tx, key) (src/server/core/tx.ts).
--
-- Sample numbers were COUNT(*)+1 (two concurrent registrations collided on the primary key, and the number never restarted each
-- year). The sample numbering moves to one counter row per year, key 'sample:<year>'. Installations that already hold samples
-- start each counter at the highest number in use, so the first number issued after the upgrade is unused.

CREATE TABLE "counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL
);

INSERT INTO "counters" ("key", "value")
SELECT 'sample:' || split_part("id", '-', 2), max(split_part("id", '-', 3)::bigint)
FROM "samples"
WHERE "id" ~ '^SMP-[0-9]{4}-[0-9]+$'
GROUP BY split_part("id", '-', 2);
