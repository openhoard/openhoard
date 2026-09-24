-- Row-level security for the review inbox (T-406), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE tag_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tag_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tag_reviews
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
