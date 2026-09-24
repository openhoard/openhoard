-- Row-level security for grants (T-602), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON grants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
