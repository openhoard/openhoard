-- Row-level security for tenant_packs (T-607), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE tenant_packs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_packs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_packs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
