-- Row-level security for activity_events (T-205), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON activity_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
