-- Folders in search (T-501 with migration 0066's paths): `path_tsv` holds the names of the
-- folders a file is in, from its first source reference (core/catalog sourcePathOf()'s pick:
-- by source, then external id), without the file's own name, which is the title. Readers are
-- matched on it, as a reader's card shows the folders; nobody else is (a folder's name is as
-- sensitive as a title, and there is no display path). Kept by the `meta` refresh, which a
-- change to a source reference's path now runs too.
ALTER TABLE "search_documents" ADD COLUMN "path_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL;--> statement-breakpoint
-- As in 0053, with path_tsv in `meta`.
CREATE OR REPLACE FUNCTION openhoard_search_refresh(t text, obj text, part text) RETURNS void
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
      path_tsv = setweight(to_tsvector('simple', openhoard_search_words((
        SELECT array_to_string(r.path[1:cardinality(r.path) - 1], ' ') FROM source_refs r
         WHERE r.tenant_id = t AND r.object_id = obj
         ORDER BY r.source, r.external_id LIMIT 1))), 'B'),
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
CREATE FUNCTION openhoard_search_on_source_ref() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM openhoard_search_refresh(OLD.tenant_id, OLD.object_id, 'meta');
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.object_id <> OLD.object_id) THEN
    PERFORM openhoard_search_refresh(NEW.tenant_id, NEW.object_id, 'meta');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Every crawl rewrites each reference's path, mostly unchanged: only a change refreshes.
CREATE TRIGGER source_refs_search
  AFTER INSERT OR DELETE ON source_refs
  FOR EACH ROW EXECUTE FUNCTION openhoard_search_on_source_ref();
--> statement-breakpoint
CREATE TRIGGER source_refs_search_update
  AFTER UPDATE OF path, object_id ON source_refs
  FOR EACH ROW WHEN (OLD.path IS DISTINCT FROM NEW.path OR OLD.object_id <> NEW.object_id)
  EXECUTE FUNCTION openhoard_search_on_source_ref();
--> statement-breakpoint
-- A reader is matched on the folders too: core/catalog's search uses exactly this expression.
DROP INDEX search_documents_reader_gin;
--> statement-breakpoint
CREATE INDEX search_documents_reader_gin ON search_documents
  USING gin ((title_tsv || tags_tsv || path_tsv || summary_tsv || body_tsv));
--> statement-breakpoint
-- The objects with a recorded path get their folders, tenant by tenant (as 0053 does).
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
    FOR obj IN SELECT DISTINCT r.object_id FROM source_refs r
                WHERE r.tenant_id = t AND r.path IS NOT NULL LOOP
      PERFORM openhoard_search_refresh(t, obj, 'meta');
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
