-- 0340_global_search: the search index behind Ctrl+K (roadmap M43, r3-search-perf).
--
-- What this adds, and why:
--   search_norm(text)   the ONE normalisation of searchable text, used on both sides of every comparison (the indexed value and the
--                       user's query), so Latin and Arabic text match whatever way it was typed: lower case; Arabic diacritics
--                       (harakat, shadda, sukun, dagger alef) and the tatweel removed; alef with hamza or madda and alef wasla -> bare alef;
--                       alef maksura -> yeh; teh marbuta -> heh; hamza on waw or yeh -> waw or yeh; Persian keheh and yeh -> Arabic kaf and
--                       yeh; Arabic-Indic and Persian digits -> 0-9. Pure SQL and IMMUTABLE, so it can be indexed.
--   *_search_trgm_idx   GIN trigram indexes on search_norm(<the searchable columns>) of samples, product batches, products,
--                       specifications, methods and documents, so that a substring search ('ibu' inside 'Ibuprofen') does not scan the
--                       table. They are created only when the pg_trgm extension is available in this PostgreSQL (the contrib package is
--                       missing from some minimal builds): without it the search still works, by a sequential scan of the normalised
--                       text, and the application tells the operator through GET /search (indexed: false).
--
-- Nothing here stores or changes a record; no data is written. A search is a read and is not audited.

CREATE FUNCTION "search_norm"(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $fn$
  -- Text that is all ASCII (ids, codes, Latin names: nearly everything stored) takes the cheap branch, which matters because the index
  -- re-checks every candidate row with this function. The second branch is ONE translate: the first 30 characters are replaced by the 30
  -- of the second list, the 13 after them (the diacritics and the tatweel) have no replacement and are deleted.
  SELECT CASE WHEN octet_length(t) = char_length(t) THEN lower(t) ELSE translate(
    lower(t),
    U&'\0623\0625\0622\0671\0649\0629\0624\0626\06A9\06CC\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0670\0640',
    U&'\0627\0627\0627\0627\064A\0647\0648\064A\0643\064A' || '01234567890123456789'
  ) END
$fn$;

DO $search$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm is not available (%): the global search runs without trigram indexes', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $q$CREATE INDEX "samples_search_trgm_idx" ON "samples" USING gin ((search_norm("id" || ' ' || "material" || ' ' || "batch")) gin_trgm_ops)$q$;
    EXECUTE $q$CREATE INDEX "product_batches_search_trgm_idx" ON "product_batches" USING gin ((search_norm("id" || ' ' || "batch_no")) gin_trgm_ops)$q$;
    EXECUTE $q$CREATE INDEX "products_search_trgm_idx" ON "products" USING gin ((search_norm("code" || ' ' || "name" || ' ' || coalesce("description", ''))) gin_trgm_ops)$q$;
    EXECUTE $q$CREATE INDEX "specifications_search_trgm_idx" ON "specifications" USING gin ((search_norm("id" || ' ' || "material")) gin_trgm_ops)$q$;
    EXECUTE $q$CREATE INDEX "methods_search_trgm_idx" ON "methods" USING gin ((search_norm("code" || ' ' || "title" || ' ' || coalesce("description", ''))) gin_trgm_ops)$q$;
    EXECUTE $q$CREATE INDEX "documents_search_trgm_idx" ON "documents" USING gin ((search_norm("code" || ' ' || "title")) gin_trgm_ops)$q$;
  END IF;
END
$search$;
