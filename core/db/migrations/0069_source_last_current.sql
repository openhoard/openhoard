-- When a run last brought the catalog up to date with its source (core/jobs syncStanding()'s
-- staleness mark). A source whose last run ended `done` was up to date then.
ALTER TABLE "source_syncs" ADD COLUMN "last_current_at" timestamp with time zone;--> statement-breakpoint
-- source_syncs has row-level security: each tenant's rows are filled in its own setting.
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
    UPDATE source_syncs SET last_current_at = last_run_at
     WHERE tenant_id = t AND last_status = 'done';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
