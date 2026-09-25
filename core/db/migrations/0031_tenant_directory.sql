-- The tenant directory (T-401): scheduled maintenance must visit every tenant, and `tenants` is
-- under forced row-level security like everything else, so nothing could list them.
--
-- This second policy lets a transaction that set `app.tenant_directory` to 'on' (transaction-
-- locally) SELECT tenants rows; nothing else. It is permissive, so it widens `tenants` only, and
-- only for SELECT: inserts, updates and deletes still need the tenant_isolation policy. Every
-- other table stays closed in that transaction, since no tenant is set. Only core/db's
-- Database.tenantIds() sets it, in a read-only transaction of its own that selects ids.
--
-- As with app.tenant_id, raw SQL could set it too: this guards against query mistakes, not
-- arbitrary SQL (see core/db README).
CREATE POLICY tenant_directory ON tenants
  FOR SELECT
  USING (current_setting('app.tenant_directory', true) = 'on');
