-- What drizzle-kit doesn't generate from schema.ts: row-level security, the triggers and their
-- functions, and the indexes on expressions. Squashed (T-1408) from migrations 0000-0071, as
-- they stood at 8ccdef5: each object here is its last version there.
--
-- Tenant isolation is forced row-level security (T-201; spike S2 validated it on PGlite and
-- native Postgres). database.ts opens every unit of work with a transaction-local tenant,
--   SELECT set_config('app.tenant_id', $1, true);
-- so each statement sees and writes one tenant's rows. Without a tenant the setting is NULL or
-- '' and matches no row: a missing tenant context fails closed. FORCE makes the policies apply
-- to the tables' owner, which is the role the application connects as. checks.ts refuses
-- superusers and BYPASSRLS roles, which skip row-level security entirely.
--
-- The policies name no role (they apply to everyone), and no migration creates a role, so
-- installations sharing a cluster share nothing: another installation's owner has no
-- privileges on these tables.
--
-- Every table added later needs the same three statements: see "Adding a table" in README.md.
-- rls.test.ts fails for any table without them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'zones', 'blobs', 'objects', 'versions', 'source_refs', 'facets', 'facet_values',
    'object_tags', 'grants', 'tag_reviews', 'users', 'user_identities', 'groups',
    'group_members', 'tenant_packs', 'principal_epochs', 'api_keys', 'activity_events',
    'sessions', 'oauth_clients', 'oauth_codes', 'oauth_grants', 'oauth_tokens', 'scim_tokens',
    'version_extracts', 'source_syncs', 'version_cards', 'model_usage', 'injection_reviews',
    'search_documents', 'version_embeddings', 'sign_in_links', 'passkeys', 'invites',
    'passkey_challenges', 'source_shares', 'source_skips', 'tenant_storage'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I'
      ' USING (tenant_id = current_setting(''app.tenant_id'', true))'
      ' WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true))
  WITH CHECK (id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- The tenant directory (T-401): scheduled maintenance must visit every tenant, and `tenants` is
-- under forced row-level security like everything else, so nothing could list them.
--
-- This second policy lets a transaction that set `app.tenant_directory` to 'on' (transaction-
-- locally) SELECT tenants rows; nothing else. It is permissive, so it widens `tenants` only, and
-- only for SELECT: inserts, updates and deletes still need the tenant_isolation policy. Every
-- other table stays closed in that transaction, since no tenant is set. Only core/db's
-- Database.tenantIds() sets it, in a read-only transaction of its own that selects ids.
--
-- It applies only where no tenant is set: inside a tenant's transaction the directory setting
-- changes nothing, so even a session-level `on` (which only raw SQL could set) can't widen a
-- tenant's view. As with app.tenant_id, raw SQL could set it: this guards against query
-- mistakes, not arbitrary SQL (see core/db README).
CREATE POLICY tenant_directory ON tenants
  FOR SELECT
  USING (
    current_setting('app.tenant_directory', true) = 'on'
    AND coalesce(current_setting('app.tenant_id', true), '') = ''
  );
--> statement-breakpoint
-- objects.updated_at follows every update, whichever code path makes it.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER objects_touch_updated_at BEFORE UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
-- The audit log is append-only (T-701). In its tenant a row can be read and inserted; nothing
-- can change or remove one:
--
-- - Forced row-level security with policies for SELECT and INSERT only. With no UPDATE or DELETE
--   policy, those statements match no rows, for the owner too.
-- - Triggers refuse UPDATE, DELETE and TRUNCATE outright, for roles that skip row-level security
--   (superusers) and for TRUNCATE, which row-level security does not cover.
-- - A trigger checks every insert is a verifiable link (below).
--
-- Neither stops someone who can run arbitrary SQL as the owner (they could drop the trigger).
-- That is what the hash chain is for: core/audit's verify detects any edit, gap or reorder.
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON audit.events FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_append ON audit.events FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE FUNCTION audit.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
-- Every insert into audit.events must be a verifiable link (T-701): the next seq, linked to the
-- head's hash (core/audit takes a lock so its appends never race; this catches anything else
-- inserting), and carrying its own proof, as core/audit/src/chain.ts computes it:
--
-- - `hash` is the SHA-256 of `event`, exactly the stored text in UTF-8;
-- - `event` is a JSON object with the chain's fields only (never the hash itself), and a
--   `detail` of plain values, if any;
-- - the event's seq, prevHash, tenantId, actor, action, decision, client, object, version and
--   at say what the columns say, `at` in the form JavaScript's toISOString() writes.
--
-- What it can't check is that the text is the canonical serialization (sorted keys, no
-- whitespace); verifyAudit does.
CREATE FUNCTION audit.check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head audit.events%ROWTYPE;
  e jsonb;
BEGIN
  SELECT * INTO head FROM audit.events
    WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(head.seq, 0) + 1
     OR NEW.prev_hash <> coalesce(head.hash, repeat('0', 64)) THEN
    RAISE EXCEPTION 'audit event % does not extend the chain', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.hash <> encode(sha256(convert_to(NEW.event, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'audit event % does not match its hash', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT pg_input_is_valid(NEW.event, 'jsonb') THEN
    RAISE EXCEPTION 'audit event % is not JSON', NEW.seq USING ERRCODE = 'check_violation';
  END IF;
  e := NEW.event::jsonb;
  IF jsonb_typeof(e) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(e) AS k
        WHERE k NOT IN ('tenantId', 'seq', 'prevHash', 'at', 'actor', 'action', 'decision',
                        'client', 'object', 'version', 'detail'))
     OR (e ? 'detail' AND (
       jsonb_typeof(e->'detail') <> 'object'
       OR EXISTS (
         SELECT 1 FROM jsonb_each(e->'detail') AS d
          WHERE jsonb_typeof(d.value) NOT IN ('string', 'number', 'boolean'))))
     OR (e->'seq') IS DISTINCT FROM to_jsonb(NEW.seq)
     OR (e->'prevHash') IS DISTINCT FROM to_jsonb(NEW.prev_hash)
     OR (e->'tenantId') IS DISTINCT FROM to_jsonb(NEW.tenant_id)
     OR (e->'actor') IS DISTINCT FROM to_jsonb(NEW.actor)
     OR (e->'action') IS DISTINCT FROM to_jsonb(NEW.action)
     OR (e->'decision') IS DISTINCT FROM to_jsonb(NEW.decision)
     OR (e->'client') IS DISTINCT FROM to_jsonb(NEW.client)
     OR (e->'object') IS DISTINCT FROM to_jsonb(NEW.object)
     OR (e->'version') IS DISTINCT FROM to_jsonb(NEW.version)
     -- Milliseconds, like a JavaScript Date, and written as toISOString() writes it.
     OR date_trunc('milliseconds', NEW.at) <> NEW.at
     OR (e->'at') IS DISTINCT FROM
        to_jsonb(to_char(NEW.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
    RAISE EXCEPTION 'audit event % disagrees with its columns', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_extend_chain BEFORE INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.check_link();
--> statement-breakpoint
-- The principal epoch (T-107): bumped in the writing transaction by every change
-- resolvePrincipal() reads, so it commits, or rolls back, with the change. core/identity's
-- principal cache drops a tenant's entries once its epoch moves. A tenant's first epoch is
-- random, so a row deleted and made again never repeats an epoch a cache still holds.
--
-- Grants and memberships bump once per statement (a SCIM batch of thousands is one bump);
-- users bump per row, on the columns that make a user active, a guest or an admin (T-106); a
-- group on a change of source, since the admin group, which the server's config names by id,
-- counts only while it is a SCIM group. A deleted group's memberships go with it by cascade.
CREATE FUNCTION bump_principal_epochs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.principal_epochs (tenant_id, epoch)
  SELECT tenants.tenant_id, 1 + floor(random() * 1e12)::bigint
    FROM (SELECT DISTINCT changed.tenant_id FROM changed) tenants
  ON CONFLICT (tenant_id) DO UPDATE SET epoch = public.principal_epochs.epoch + 1;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE FUNCTION bump_principal_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  tenant text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    tenant := OLD.tenant_id;
  ELSE
    tenant := NEW.tenant_id;
  END IF;
  INSERT INTO public.principal_epochs (tenant_id, epoch)
  VALUES (tenant, 1 + floor(random() * 1e12)::bigint)
  ON CONFLICT (tenant_id) DO UPDATE SET epoch = public.principal_epochs.epoch + 1;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_insert AFTER INSERT ON grants
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_update AFTER UPDATE ON grants
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_delete AFTER DELETE ON grants
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_insert AFTER INSERT ON group_members
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_update AFTER UPDATE ON group_members
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_delete AFTER DELETE ON group_members
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
-- Only what resolvePrincipal() reads of a user: a sign-in or a renamed user changes nothing.
CREATE TRIGGER users_principal_epoch
  AFTER UPDATE OF kind, locked_at, provider_disabled_at, retired_at, admin_at ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
CREATE TRIGGER users_principal_epoch_delete AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
CREATE TRIGGER groups_principal_epoch
  AFTER UPDATE OF source ON groups
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
-- A service account is made as one and stays one, and a person never becomes one: with the
-- api_keys foreign key on (tenant, user, kind), a key can only ever belong to a service account
-- (T-111).
CREATE FUNCTION refuse_service_kind_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (OLD.kind = 'service') <> (NEW.kind = 'service') THEN
    RAISE EXCEPTION 'a user can''t become, or stop being, a service account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER users_service_kind_fixed
  BEFORE UPDATE OF kind ON users
  FOR EACH ROW EXECUTE FUNCTION refuse_service_kind_change();
--> statement-breakpoint
-- A service account never signs in: no sign-in identity may point at one.
CREATE FUNCTION refuse_service_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id AND u.kind = 'service'
  ) THEN
    RAISE EXCEPTION 'a service account never signs in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER user_identities_not_service
  BEFORE INSERT OR UPDATE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION refuse_service_identity();
--> statement-breakpoint
-- Built-in vocabulary is the system's (T-408): `risk:injection` must stay approved, exposure
-- metadata-only and visibility unset in every tenant, or a detector's flag would stop meaning
-- "no AI gets this" (or, with visibility hidden, hide files from people too). A pack or an admin
-- trying to change it, or to remove it, is refused here with a clear error, whatever code path
-- they take; the label may change. core/catalog planPack() refuses such a pack earlier, in its
-- plan. New tenants get the vocabulary from core/db createTenant(), and the detector puts it
-- back before it flags (ensureBuiltInVocabulary()).
CREATE FUNCTION openhoard_built_in_vocabulary_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.facet = 'risk' AND OLD.value = 'injection' THEN
      RAISE EXCEPTION 'risk:injection is built-in vocabulary and can''t be removed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.facet = 'risk' AND OLD.value = 'injection'
     AND (NEW.facet <> 'risk' OR NEW.value <> 'injection') THEN
    RAISE EXCEPTION 'risk:injection is built-in vocabulary and can''t be renamed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.facet = 'risk' AND NEW.value = 'injection'
     AND (NEW.approved IS NOT TRUE OR NEW.exposure IS DISTINCT FROM 'metadata-only'
          OR NEW.visibility IS NOT NULL) THEN
    RAISE EXCEPTION 'risk:injection is built-in vocabulary: it stays approved, exposure metadata-only, no visibility'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER facet_values_built_in_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facet_values
  FOR EACH ROW EXECUTE FUNCTION openhoard_built_in_vocabulary_guard();
--> statement-breakpoint
-- Search (T-501, T-502, T-407): the triggers that keep each object's search document current,
-- and the full-text (GIN) and vector (HNSW) indexes.
--
-- Dots, underscores and slashes split words before the text parser, as the title search always
-- has: Postgres would read `Forecast.xlsx` or `q3_forecast` as one word.
CREATE FUNCTION openhoard_search_words(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN regexp_replace(coalesce(input, ''), '[._/\\]+', ' ', 'g');
--> statement-breakpoint
-- Recomputes part of one object's search document from what is stored now: `meta` (titles,
-- tags and folders), `summary` or `body` (the current version's model summary or extracted
-- text), `content` (both), or `all`. The content parts always come from the object's current
-- version, so a new version empties them until its own extract and summary arrive. The title a
-- non-reader sees follows core/catalog nonReaderTitle(): 'Document' (GENERIC_TITLE) while a
-- model's proposed display title waits for the owner. Runs as the caller, under row-level
-- security: triggers only ever refresh rows of the tenant whose row changed.
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
-- What a reader may be matched on (every column but the non-reader's, folders included) and
-- what anyone else may: core/catalog's search uses exactly these expressions, so the planner
-- can use the indexes.
CREATE INDEX search_documents_reader_gin ON search_documents
  USING gin ((title_tsv || tags_tsv || path_tsv || summary_tsv || body_tsv));
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
