-- Row-level security for the tag tables (T-202), exactly as 0001_tenant_rls.sql does for the
-- core tables: see the comments there.
ALTER TABLE facets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE facets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON facets
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE facet_values ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE facet_values FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON facet_values
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE object_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE object_tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON object_tags
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
