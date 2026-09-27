-- Row-level security for sign_in_links (0055), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE sign_in_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sign_in_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sign_in_links
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
