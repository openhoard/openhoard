DROP INDEX "versions_unprocessed_idx";--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "versions_pending_idx" ON "versions" USING btree ("tenant_id","object_id","seq") WHERE processed_at is null and superseded_at is null;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_superseded_unprocessed" CHECK (superseded_at is null or (processed_at is null and superseded_at >= created_at));