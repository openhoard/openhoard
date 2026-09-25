-- Row-level security for api_keys (T-111), as 0001_tenant_rls.sql does for the core tables.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- A service account is made as one and stays one, and a person never becomes one: with the
-- api_keys foreign key on (tenant, user, kind), a key can only ever belong to a service account.
CREATE FUNCTION refuse_service_kind_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (OLD.kind = 'service') <> (NEW.kind = 'service') THEN
    RAISE EXCEPTION 'a user can''t become, or stop being, a service account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER users_service_kind_fixed
  BEFORE UPDATE OF kind ON users
  FOR EACH ROW EXECUTE FUNCTION refuse_service_kind_change();
--> statement-breakpoint
-- A service account never signs in: no sign-in identity may point at one.
CREATE FUNCTION refuse_service_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id AND u.kind = 'service'
  ) THEN
    RAISE EXCEPTION 'a service account never signs in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER user_identities_not_service
  BEFORE INSERT OR UPDATE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION refuse_service_identity();
