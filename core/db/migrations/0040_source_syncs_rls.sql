-- Row-level security for source_syncs (T-301), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE source_syncs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_syncs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON source_syncs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
