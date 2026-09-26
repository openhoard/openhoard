-- Built-in vocabulary for every existing tenant (T-408): the `risk` facet and `risk:injection`,
-- approved, exposure metadata-only, which OpenHoard's injection detector applies. New tenants
-- get it from core/db createTenant(), and the detector puts it back before it flags
-- (ensureBuiltInVocabulary()), so a flag never depends on an admin having applied a pack.
--
-- Tables are under forced row-level security, so the tenants are listed through the tenant
-- directory policy (0031) with no tenant set, and each tenant's rows are written with
-- app.tenant_id set to it, transaction-locally.
DO $$
DECLARE
  ids text[];
  t text;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_directory', 'on', true);
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM tenants;
  PERFORM set_config('app.tenant_directory', 'off', true);
  FOREACH t IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', t, true);
    INSERT INTO facets (tenant_id, key, label) VALUES (t, 'risk', 'Risk')
      ON CONFLICT DO NOTHING;
    INSERT INTO facet_values (tenant_id, facet, value, label, approved, exposure)
      VALUES (t, 'risk', 'injection', 'Possible prompt injection', true, 'metadata-only')
      ON CONFLICT (tenant_id, facet, value)
      DO UPDATE SET approved = true, exposure = 'metadata-only';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
