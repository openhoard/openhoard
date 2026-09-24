DROP INDEX "tag_reviews_open_idx";--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit"."events" USING btree ("tenant_id","actor","seq");--> statement-breakpoint
CREATE INDEX "grants_tag_idx" ON "grants" USING btree ("tenant_id","facet","value") WHERE facet is not null;--> statement-breakpoint
CREATE INDEX "objects_owner_idx" ON "objects" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE INDEX "tag_reviews_tag_idx" ON "tag_reviews" USING btree ("tenant_id","facet","value") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "tag_reviews_object_idx" ON "tag_reviews" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "tag_reviews_open_idx" ON "tag_reviews" USING btree ("tenant_id","created_at","id") WHERE resolved_at is null;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_external_id_scim" CHECK (source = 'scim' or external_id is null);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_external_id_scim" CHECK (source = 'scim' or external_id is null);