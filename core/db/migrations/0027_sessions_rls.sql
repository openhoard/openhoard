-- Row-level security for sessions (T-102), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
