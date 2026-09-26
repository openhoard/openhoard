-- The admin role (T-106) is part of the principal (core/identity resolvePrincipal()), so what
-- decides it bumps the tenant's principal epoch, like everything else the principal cache holds
-- (0021_principal_epoch_triggers.sql):
--
-- - a user's own role (admin_at), besides the columns that make them active or a guest;
-- - the tenant's admin group, which the server's config names by id (never by external id, which
--   the SCIM token chooses): its members count only while it is a SCIM group, so a change of
--   source bumps too. Membership changes bump already (group_members), and a deleted group's
--   memberships go with it by cascade.
DROP TRIGGER users_principal_epoch ON users;
--> statement-breakpoint
CREATE TRIGGER users_principal_epoch
  AFTER UPDATE OF kind, locked_at, provider_disabled_at, retired_at, admin_at ON users
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
--> statement-breakpoint
CREATE TRIGGER groups_principal_epoch
  AFTER UPDATE OF source ON groups
  FOR EACH ROW EXECUTE FUNCTION bump_principal_epoch();
