-- Row-level security for principal_epochs, as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE principal_epochs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE principal_epochs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON principal_epochs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- The principal epoch (T-107): bumped in the writing transaction by every change
-- resolvePrincipal() reads, so it commits, or rolls back, with the change. core/identity's
-- principal cache drops a tenant's entries once its epoch moves. A tenant's first epoch is
-- random, so a row deleted and made again never repeats an epoch a cache still holds.
--
-- Grants and memberships bump once per statement (a SCIM batch of thousands is one bump);
-- users bump per row, on the columns that make a user active or a guest.
CREATE FUNCTION bump_principal_epochs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.principal_epochs (tenant_id, epoch)
  SELECT tenants.tenant_id, 1 + floor(random() * 1e12)::bigint
    FROM (SELECT DISTINCT changed.tenant_id FROM changed) tenants
  ON CONFLICT (tenant_id) DO UPDATE SET epoch = public.principal_epochs.epoch + 1;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE FUNCTION bump_principal_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  tenant text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    tenant := OLD.tenant_id;
  ELSE
    tenant := NEW.tenant_id;
  END IF;
  INSERT INTO public.principal_epochs (tenant_id, epoch)
  VALUES (tenant, 1 + floor(random() * 1e12)::bigint)
  ON CONFLICT (tenant_id) DO UPDATE SET epoch = public.principal_epochs.epoch + 1;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_insert AFTER INSERT ON grants
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_update AFTER UPDATE ON grants
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER grants_principal_epoch_delete AFTER DELETE ON grants
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_insert AFTER INSERT ON group_members
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_update AFTER UPDATE ON group_members
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
CREATE TRIGGER group_members_principal_epoch_delete AFTER DELETE ON group_members
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION bump_principal_epochs();
--> statement-breakpoint
-- Only what resolvePrincipal() reads of a user: a sign-in or a renamed user changes nothing.
CREATE TRIGGER users_principal_epoch
  AFTER UPDATE OF kind, locked_at, provider_disabled_at, retired_at ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
CREATE TRIGGER users_principal_epoch_delete AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
