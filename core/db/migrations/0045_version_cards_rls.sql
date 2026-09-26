-- Row-level security for version_cards (T-405) and model_usage (T-404), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE version_cards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE version_cards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON version_cards
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE model_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE model_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON model_usage
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
