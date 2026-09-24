-- An external id is the identity provider's (SCIM externalId), so only SCIM users and groups
-- have one; the next migration adds users_external_id_scim and groups_external_id_scim. Before
-- it, core/identity accepted one for local users and groups too, where it meant nothing: clear
-- those, so the constraints can be added.
--
-- Forced row-level security would hide every row from these updates (no tenant is set during
-- migrations), so it stops applying to the owner for each update and is forced again at once.
-- Migrations run in one transaction, and ALTER TABLE locks the table until it commits, so no
-- other session ever sees a table without it.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE users SET external_id = NULL WHERE source <> 'scim' AND external_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE groups NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE groups SET external_id = NULL WHERE source <> 'scim' AND external_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE groups FORCE ROW LEVEL SECURITY;
