-- The admin role (T-106) is part of the principal (core/identity resolvePrincipal()), so what
-- decides it bumps the tenant's principal epoch, like everything else the principal cache holds
-- (0021_principal_epoch_triggers.sql):
--
-- - a user's own role (admin_at), besides the columns that make them active or a guest;
-- - which group is the tenant's admin group: the server's config names it by SCIM externalId,
--   so a group taking or losing that id changes who is an admin. Membership changes bump
--   already (group_members), and a deleted group's memberships go with it by cascade.
DROP TRIGGER users_principal_epoch ON users;
--> statement-breakpoint
CREATE TRIGGER users_principal_epoch
  AFTER UPDATE OF kind, locked_at, provider_disabled_at, retired_at, admin_at ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
CREATE TRIGGER groups_principal_epoch
  AFTER UPDATE OF external_id, source ON groups
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
