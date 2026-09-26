-- Vector search (T-407, T-502) needs pgvector in this database. pgvector doesn't mark itself a
-- trusted extension, so only a superuser can create it, and OpenHoard never connects as one
-- (core/db refuses superusers: they skip row-level security). A DBA runs, once per database,
--
--   CREATE EXTENSION vector;
--
-- (core/db README, "Server requirements"). This migration tries it anyway, in case a later
-- pgvector is trusted or the role was given the right, and otherwise stops the migrations with
-- that instruction instead of failing later on an unknown type. PGlite creates it on open.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      CREATE EXTENSION vector;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
        RAISE EXCEPTION 'pgvector is not installed in database %', current_database()
          USING ERRCODE = 'object_not_in_prerequisite_state',
                HINT = 'A superuser must run CREATE EXTENSION vector; in this database once (pgvector 0.8 or later), then start OpenHoard again. See the core/db README, "Server requirements".';
    END;
  END IF;
END $$;
