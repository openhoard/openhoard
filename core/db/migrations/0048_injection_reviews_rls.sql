-- Row-level security for injection_reviews (T-408), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE injection_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE injection_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON injection_reviews
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
