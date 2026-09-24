-- Tenant isolation with forced row-level security (T-201; spike S2 validated it on PGlite and
-- native Postgres).
--
-- database.ts opens every unit of work with a transaction-local tenant,
--   SELECT set_config('app.tenant_id', $1, true);
-- so each statement sees and writes one tenant's rows. Without a tenant the setting is NULL or
-- '' and matches no row: a missing tenant context fails closed. FORCE makes the policies apply
-- to the tables' owner, which is the role the application connects as. checks.ts refuses
-- superusers and BYPASSRLS roles, which skip row-level security entirely.
--
-- The policies name no role (they apply to everyone), and this migration creates no role, so
-- installations sharing a cluster share nothing: another installation's owner has no
-- privileges on these tables.
--
-- Every table added later needs the same three statements: see "Adding a table" in README.md.
-- rls.test.ts fails for any table without them.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true))
  WITH CHECK (id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE zones FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON zones
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE blobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE blobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON blobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE objects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON objects
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON versions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE source_refs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_refs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON source_refs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- objects.updated_at follows every update, whichever code path makes it.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER objects_touch_updated_at BEFORE UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
