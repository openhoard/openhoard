-- Row-level security for version_extracts (T-402), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE version_extracts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE version_extracts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON version_extracts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
