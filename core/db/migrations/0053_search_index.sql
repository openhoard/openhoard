-- Search (T-501, T-502, T-407): row-level security for search_documents and version_embeddings,
-- the triggers that keep each object's search document current, the full-text (GIN) and vector
-- (HNSW) indexes, and the documents of the objects that exist already.
ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE search_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON search_documents
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE version_embeddings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE version_embeddings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON version_embeddings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- Dots, underscores and slashes split words before the text parser, as the title search always
-- has: Postgres would read `Forecast.xlsx` or `q3_forecast` as one word.
CREATE FUNCTION openhoard_search_words(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN regexp_replace(coalesce(input, ''), '[._/\\]+', ' ', 'g');
--> statement-breakpoint
-- Recomputes part of one object's search document from what is stored now: `meta` (titles and
-- tags), `summary` or `body` (the current version's model summary or extracted text), `content`
-- (both), or `all`. The content parts always come from the object's current version, so a new
-- version empties them until its own extract and summary arrive. The title a non-reader sees
-- follows core/catalog nonReaderTitle(): 'Document' (GENERIC_TITLE) while a model's proposed
-- display title waits for the owner. Runs as the caller, under row-level security: triggers
-- only ever refresh rows of the tenant whose row changed.
CREATE FUNCTION openhoard_search_refresh(t text, obj text, part text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  current_version text;
BEGIN
  INSERT INTO search_documents (tenant_id, object_id)
    SELECT o.tenant_id, o.id FROM objects o WHERE o.tenant_id = t AND o.id = obj
    ON CONFLICT DO NOTHING;
  IF part IN ('meta', 'all') THEN
    UPDATE search_documents d SET
      title_tsv = setweight(to_tsvector('simple', openhoard_search_words(o.title)), 'A'),
      other_title_tsv = setweight(to_tsvector('simple', openhoard_search_words(
        CASE WHEN o.display_title_by IS NULL THEN o.title
             WHEN o.display_title_by NOT LIKE 'user:%' THEN 'Document'
             ELSE coalesce(o.display_title, o.title) END)), 'A'),
      tags_tsv = setweight(to_tsvector('simple', openhoard_search_words((
        SELECT string_agg(ot.value, ' ') FROM object_tags ot
         WHERE ot.tenant_id = t AND ot.object_id = obj))), 'B'),
      trusted_tags_tsv = setweight(to_tsvector('simple', openhoard_search_words((
        SELECT string_agg(ot.value, ' ') FROM object_tags ot
         WHERE ot.tenant_id = t AND ot.object_id = obj
           AND (ot.source <> 'model' OR ot.reviewed)))), 'B'),
      public_tags_tsv = setweight(to_tsvector('simple', openhoard_search_words((
        SELECT string_agg(ot.value, ' ') FROM object_tags ot
          JOIN facets f ON f.tenant_id = ot.tenant_id AND f.key = ot.facet
         WHERE ot.tenant_id = t AND ot.object_id = obj AND f.public
           AND (ot.source <> 'model' OR ot.reviewed)))), 'B'),
      updated_at = now()
    FROM objects o
    WHERE d.tenant_id = t AND d.object_id = obj AND o.tenant_id = t AND o.id = obj;
  END IF;
  IF part IN ('summary', 'body', 'content', 'all') THEN
    SELECT v.id INTO current_version FROM versions v
     WHERE v.tenant_id = t AND v.object_id = obj ORDER BY v.seq DESC LIMIT 1;
    IF current_version IS NULL THEN
      RETURN;
    END IF;
    IF part IN ('summary', 'content', 'all') THEN
      UPDATE search_documents d SET
        version_id = current_version,
        summary_tsv = coalesce((
          SELECT setweight(to_tsvector('simple', openhoard_search_words(c.summary)), 'C')
            FROM version_cards c
           WHERE c.tenant_id = t AND c.version_id = current_version
             AND c.status = 'summarized' AND c.summary <> ''), ''::tsvector),
        summary_provider_kind = (
          SELECT c.provider_kind FROM version_cards c
           WHERE c.tenant_id = t AND c.version_id = current_version
             AND c.status = 'summarized' AND c.summary <> ''),
        updated_at = now()
      WHERE d.tenant_id = t AND d.object_id = obj;
    END IF;
    IF part IN ('body', 'content', 'all') THEN
      UPDATE search_documents d SET
        version_id = current_version,
        body_tsv = coalesce((
          SELECT setweight(to_tsvector('simple', openhoard_search_words(left(x.text, 200000))), 'D')
            FROM version_extracts x
           WHERE x.tenant_id = t AND x.version_id = current_version
             AND x.status = 'extracted'), ''::tsvector),
        updated_at = now()
      WHERE d.tenant_id = t AND d.object_id = obj;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION openhoard_search_on_object() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM openhoard_search_refresh(NEW.tenant_id, NEW.id, 'meta');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER objects_search
  AFTER INSERT OR UPDATE OF title, display_title, display_title_by ON objects
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_object();
--> statement-breakpoint
CREATE FUNCTION openhoard_search_on_tag() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM openhoard_search_refresh(OLD.tenant_id, OLD.object_id, 'meta');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.object_id <> OLD.object_id) THEN
    PERFORM openhoard_search_refresh(NEW.tenant_id, NEW.object_id, 'meta');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER object_tags_search
  AFTER INSERT OR UPDATE OR DELETE ON object_tags
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_tag();
--> statement-breakpoint
-- A facet made public (or not) changes what non-readers are matched on, for every object
-- carrying one of its tags.
CREATE FUNCTION openhoard_search_on_facet() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  obj text;
BEGIN
  FOR obj IN SELECT DISTINCT ot.object_id FROM object_tags ot
              WHERE ot.tenant_id = NEW.tenant_id AND ot.facet = NEW.key LOOP
    PERFORM openhoard_search_refresh(NEW.tenant_id, obj, 'meta');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER facets_search
  AFTER UPDATE OF public ON facets
  FOR EACH ROW WHEN (OLD.public IS DISTINCT FROM NEW.public)
  EXECUTE FUNCTION openhoard_search_on_facet();
--> statement-breakpoint
CREATE FUNCTION openhoard_search_on_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM openhoard_search_refresh(NEW.tenant_id, NEW.object_id, 'content');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER versions_search
  AFTER INSERT ON versions
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_version();
--> statement-breakpoint
CREATE FUNCTION openhoard_search_on_content() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  part text := CASE TG_TABLE_NAME WHEN 'version_cards' THEN 'summary' ELSE 'body' END;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM openhoard_search_refresh(OLD.tenant_id, OLD.object_id, part);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM openhoard_search_refresh(NEW.tenant_id, NEW.object_id, part);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER version_extracts_search
  AFTER INSERT OR UPDATE OR DELETE ON version_extracts
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_content();
--> statement-breakpoint
CREATE TRIGGER version_cards_search
  AFTER INSERT OR UPDATE OR DELETE ON version_cards
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_content();
--> statement-breakpoint
-- What a reader may be matched on (every column but the non-reader's) and what anyone else may:
-- core/catalog's search uses exactly these expressions, so the planner can use the indexes.
CREATE INDEX search_documents_reader_gin ON search_documents
  USING gin ((title_tsv || tags_tsv || summary_tsv || body_tsv));
--> statement-breakpoint
CREATE INDEX search_documents_other_gin ON search_documents
  USING gin ((other_title_tsv || public_tags_tsv));
--> statement-breakpoint
-- HNSW per common dimension (schema.ts INDEXED_DIMENSIONS), cosine distance, pgvector's default
-- build settings (m 16, ef_construction 64, as spike S1 measured). Partial, so each index holds
-- only its size's vectors and the cast never meets another size. core/catalog's vector search
-- uses them only above its exact-search threshold (spike S1's plan rule).
CREATE INDEX version_embeddings_hnsw_384 ON version_embeddings
  USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE dimensions = 384;
--> statement-breakpoint
CREATE INDEX version_embeddings_hnsw_768 ON version_embeddings
  USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE dimensions = 768;
--> statement-breakpoint
CREATE INDEX version_embeddings_hnsw_1024 ON version_embeddings
  USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE dimensions = 1024;
--> statement-breakpoint
CREATE INDEX version_embeddings_hnsw_1536 ON version_embeddings
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE dimensions = 1536;
--> statement-breakpoint
-- The objects that exist already get their documents, tenant by tenant (as 0046 does).
DO $$
DECLARE
  ids text[];
  t text;
  obj text;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_directory', 'on', true);
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM tenants;
  PERFORM set_config('app.tenant_directory', 'off', true);
  FOREACH t IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', t, true);
    FOR obj IN SELECT o.id FROM objects o WHERE o.tenant_id = t LOOP
      PERFORM openhoard_search_refresh(t, obj, 'all');
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
