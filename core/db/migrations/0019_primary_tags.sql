ALTER TABLE "tag_reviews" DROP CONSTRAINT "tag_reviews_reason_valid";--> statement-breakpoint
DROP INDEX "tag_reviews_one_open";--> statement-breakpoint
ALTER TABLE "facets" ADD COLUMN "single" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "object_tags" ADD COLUMN "primary_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "object_tags_one_primary" ON "object_tags" USING btree ("tenant_id","object_id") WHERE primary_by is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tag_reviews_one_open_primary" ON "tag_reviews" USING btree ("tenant_id","object_id") WHERE resolved_at is null and reason = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "tag_reviews_one_open" ON "tag_reviews" USING btree ("tenant_id","object_id","facet","value") WHERE resolved_at is null and reason <> 'primary';--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_primary_trusted" CHECK (primary_by is null or (primary_by ~ '^(user|rule|pack):.+$' and (source <> 'model' or reviewed)));--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_reason_valid" CHECK (reason in ('new-value', 'low-confidence', 'sensitive', 'conflict', 'primary'));