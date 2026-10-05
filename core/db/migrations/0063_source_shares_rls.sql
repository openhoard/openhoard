-- Row-level security for source_shares (0062), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE source_shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_shares FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON source_shares
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
