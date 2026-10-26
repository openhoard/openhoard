CREATE TABLE "object_levels" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"visibility_trusted" smallint,
	"visibility_cap" smallint,
	"exposure_trusted" smallint,
	"exposure_cap" smallint,
	CONSTRAINT "object_levels_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "object_levels_ranks_valid" CHECK (coalesce(visibility_trusted, 0) between 0 and 2 and coalesce(visibility_cap, 0) between 0 and 2
          and coalesce(exposure_trusted, 0) between 0 and 3 and coalesce(exposure_cap, 0) between 0 and 3)
);
--> statement-breakpoint
ALTER TABLE "object_levels" ADD CONSTRAINT "object_levels_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Row-level security, as for every table (0001_rls.sql).
ALTER TABLE object_levels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE object_levels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON object_levels
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- Each object's levels as ranks (T-507), kept by triggers whatever code path changes their
-- inputs: core/catalog's search reads them instead of working the levels out per row. They
-- mirror core/catalog visibility.ts collectLevels() and core/policy resolveLevels(), less the
-- tenant defaults, which search joins once: whether the current version is processed; the most
-- restrictive trusted level tag (an approved value, not an unreviewed model guess); and the most
-- restrictive untrusted one or open review item (a primary proposal applies nothing). An
-- unknown level ranks as the most restrictive. They only narrow what search considers:
-- viewObjects() works out every level again before anything is shown.
CREATE FUNCTION openhoard_visibility_rank(level text) RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE level WHEN 'readable' THEN 2 WHEN 'discoverable' THEN 1 ELSE 0 END;
--> statement-breakpoint
CREATE FUNCTION openhoard_exposure_rank(level text) RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE level WHEN 'full' THEN 3 WHEN 'commercial-only' THEN 2 WHEN 'local-only' THEN 1
                    ELSE 0 END;
--> statement-breakpoint
-- Every object's levels, worked out from what is stored now: what the triggers and the backfill
-- write. Per object, through the indexes on (tenant, object), so asking for one object reads
-- only its rows. security_invoker: read under the caller's row-level security.
CREATE VIEW openhoard_levels WITH (security_invoker = true) AS
SELECT o.tenant_id, o.id AS object_id,
       coalesce((SELECT v.processed_at IS NOT NULL FROM versions v
                  WHERE v.tenant_id = o.tenant_id AND v.object_id = o.id
                  ORDER BY v.seq DESC LIMIT 1), false) AS processed,
       x.visibility_trusted, x.visibility_cap, x.exposure_trusted, x.exposure_cap
  FROM objects o
  CROSS JOIN LATERAL (
    SELECT min(openhoard_visibility_rank(l.visibility))
             FILTER (WHERE l.trusted AND l.visibility IS NOT NULL) AS visibility_trusted,
           min(openhoard_visibility_rank(l.visibility))
             FILTER (WHERE NOT l.trusted AND l.visibility IS NOT NULL) AS visibility_cap,
           min(openhoard_exposure_rank(l.exposure))
             FILTER (WHERE l.trusted AND l.exposure IS NOT NULL) AS exposure_trusted,
           min(openhoard_exposure_rank(l.exposure))
             FILTER (WHERE NOT l.trusted AND l.exposure IS NOT NULL) AS exposure_cap
      FROM (
        SELECT fv.visibility, fv.exposure,
               (fv.approved AND (ot.source <> 'model' OR ot.reviewed)) AS trusted
          FROM object_tags ot
          JOIN facet_values fv
            ON fv.tenant_id = ot.tenant_id AND fv.facet = ot.facet AND fv.value = ot.value
         WHERE ot.tenant_id = o.tenant_id AND ot.object_id = o.id
           AND (fv.visibility IS NOT NULL OR fv.exposure IS NOT NULL)
        UNION ALL
        SELECT fv.visibility, fv.exposure, false
          FROM tag_reviews r
          JOIN facet_values fv
            ON fv.tenant_id = r.tenant_id AND fv.facet = r.facet AND fv.value = r.value
         WHERE r.tenant_id = o.tenant_id AND r.object_id = o.id
           AND r.resolved_at IS NULL AND r.reason <> 'primary'
           AND (fv.visibility IS NOT NULL OR fv.exposure IS NOT NULL)
      ) l
  ) x;
--> statement-breakpoint
-- Recomputes the levels of objects `objs` of tenant `t`. The rows are locked first, in order,
-- and worked out in the next statement: under READ COMMITTED that statement sees what a
-- concurrent change to these objects committed while this one waited for their locks (one
-- UPDATE would recheck a changed row but compute it from its older snapshot, and could put
-- stale levels back). Unchanged rows aren't written. An object being deleted has none.
-- Planned at each call (plan_cache_mode): a plan PL/pgSQL keeps is made once, for the tables as
-- they were then, and with no statistics (PGlite never analyzes) one made while a tenant was
-- small scans whole tables ever after, which made a statement over thousands of rows quadratic.
CREATE FUNCTION openhoard_levels_refresh(t text, objs text[]) RETURNS void
  LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  INSERT INTO object_levels (tenant_id, object_id)
    SELECT o.tenant_id, o.id FROM objects o WHERE o.tenant_id = t AND o.id = ANY(objs)
    ON CONFLICT DO NOTHING;
  -- The values the objects' tags and open items name, first: a change to one of them (its
  -- level, its approval) and this refresh then wait for each other, so neither works from a
  -- state the other is changing. Values before objects, as the value trigger takes them.
  PERFORM 1 FROM facet_values fv
   WHERE fv.tenant_id = t AND (fv.facet, fv.value) IN (
           SELECT ot.facet, ot.value FROM object_tags ot
            WHERE ot.tenant_id = t AND ot.object_id = ANY(objs)
           UNION
           SELECT r.facet, r.value FROM tag_reviews r
            WHERE r.tenant_id = t AND r.object_id = ANY(objs) AND r.resolved_at IS NULL)
   ORDER BY fv.facet, fv.value FOR SHARE;
  PERFORM 1 FROM object_levels l WHERE l.tenant_id = t AND l.object_id = ANY(objs)
    ORDER BY l.object_id FOR UPDATE;
  UPDATE object_levels d SET
    processed = n.processed,
    visibility_trusted = n.visibility_trusted,
    visibility_cap = n.visibility_cap,
    exposure_trusted = n.exposure_trusted,
    exposure_cap = n.exposure_cap
  FROM openhoard_levels n
  WHERE n.tenant_id = t AND n.object_id = ANY(objs)
    AND d.tenant_id = t AND d.object_id = n.object_id
    AND (d.processed, d.visibility_trusted, d.visibility_cap, d.exposure_trusted, d.exposure_cap)
        IS DISTINCT FROM
        (n.processed, n.visibility_trusted, n.visibility_cap, n.exposure_trusted, n.exposure_cap);
END $$;
--> statement-breakpoint
-- The same for any number of objects, a thousand at a time.
CREATE FUNCTION openhoard_levels_refresh_all(t text, objs text[]) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  i int := 1;
BEGIN
  WHILE i <= coalesce(cardinality(objs), 0) LOOP
    PERFORM openhoard_levels_refresh(t, objs[i:i + 999]);
    i := i + 1000;
  END LOOP;
END $$;
--> statement-breakpoint
-- Tags, review items and versions (new, changed, removed) change their objects' levels. Once a
-- statement, over the rows it changed (its transition tables): a trigger a row would make a
-- statement over thousands of rows (a pack applied, a crawl's tags) take quadratic time.
CREATE FUNCTION openhoard_levels_on_rows() RETURNS trigger
  LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  t text;
  objs text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR t, objs IN SELECT c.tenant_id, array_agg(DISTINCT c.object_id ORDER BY c.object_id)
                     FROM changed_new c GROUP BY c.tenant_id LOOP
      PERFORM openhoard_levels_refresh_all(t, objs);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR t, objs IN SELECT c.tenant_id, array_agg(DISTINCT c.object_id ORDER BY c.object_id)
                     FROM changed_old c GROUP BY c.tenant_id LOOP
      PERFORM openhoard_levels_refresh_all(t, objs);
    END LOOP;
  ELSE
    FOR t, objs IN SELECT c.tenant_id, array_agg(DISTINCT c.object_id ORDER BY c.object_id)
                     FROM (SELECT tenant_id, object_id FROM changed_old
                           UNION ALL
                           SELECT tenant_id, object_id FROM changed_new) c
                    GROUP BY c.tenant_id LOOP
      PERFORM openhoard_levels_refresh_all(t, objs);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER object_tags_levels_insert AFTER INSERT ON object_tags
  REFERENCING NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER object_tags_levels_update AFTER UPDATE ON object_tags
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER object_tags_levels_delete AFTER DELETE ON object_tags
  REFERENCING OLD TABLE AS changed_old
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER tag_reviews_levels_insert AFTER INSERT ON tag_reviews
  REFERENCING NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER tag_reviews_levels_update AFTER UPDATE ON tag_reviews
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER tag_reviews_levels_delete AFTER DELETE ON tag_reviews
  REFERENCING OLD TABLE AS changed_old
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER versions_levels_insert AFTER INSERT ON versions
  REFERENCING NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER versions_levels_update AFTER UPDATE ON versions
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
CREATE TRIGGER versions_levels_delete AFTER DELETE ON versions
  REFERENCING OLD TABLE AS changed_old
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_rows();
--> statement-breakpoint
-- A value's level or approval changes the levels of every object carrying it or proposed it.
-- Once a statement (a pack changes many values in one), over every changed value's objects
-- together, so they are locked in one order. (A value can't be renamed or removed while
-- anything refers to it: the foreign keys.)
CREATE FUNCTION openhoard_levels_on_values() RETURNS trigger
  LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  t text;
  objs text[];
BEGIN
  FOR t, objs IN
    WITH changed AS (
      SELECT n.tenant_id, n.facet, n.value
        FROM changed_new n
        JOIN changed_old o ON o.tenant_id = n.tenant_id AND o.facet = n.facet AND o.value = n.value
       WHERE (o.visibility, o.exposure, o.approved) IS DISTINCT FROM (n.visibility, n.exposure, n.approved))
    SELECT c.tenant_id, array_agg(DISTINCT c.object_id ORDER BY c.object_id)
      FROM (SELECT ot.tenant_id, ot.object_id FROM object_tags ot
              JOIN changed v ON v.tenant_id = ot.tenant_id AND v.facet = ot.facet AND v.value = ot.value
            UNION ALL
            SELECT r.tenant_id, r.object_id FROM tag_reviews r
              JOIN changed v ON v.tenant_id = r.tenant_id AND v.facet = r.facet AND v.value = r.value
             WHERE r.resolved_at IS NULL) c
     GROUP BY c.tenant_id
  LOOP
    PERFORM openhoard_levels_refresh_all(t, objs);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER facet_values_levels AFTER UPDATE ON facet_values
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION openhoard_levels_on_values();
--> statement-breakpoint
-- Every existing object's levels, tenant by tenant (row-level security shows one at a time): the
-- tenant directory lists them, as core/db tenantIds() does, then each tenant is set in turn.
-- The table is new: one insert a tenant.
DO $$
DECLARE
  ids text[];
  t text;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_directory', 'on', true);
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM tenants;
  PERFORM set_config('app.tenant_directory', '', true);
  FOREACH t IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', t, true);
    INSERT INTO object_levels
      SELECT * FROM openhoard_levels n WHERE n.tenant_id = t
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
