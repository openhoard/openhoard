-- Row-level security for scim_tokens (T-103), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON scim_tokens
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
