-- Row-level security for passkeys, invites and passkey_challenges (0058), as 0001_tenant_rls.sql
-- does for the core tables.
ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE passkeys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON passkeys
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invites
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE passkey_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE passkey_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON passkey_challenges
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
