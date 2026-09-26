-- Reviews become version- and content-scoped (T-408 review). Object-scoped reviews recorded
-- before this (only on branches, never released) are dropped: an admin reviews again.
TRUNCATE injection_reviews;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD COLUMN "version_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD COLUMN "blob_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD CONSTRAINT "injection_reviews_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD CONSTRAINT "injection_reviews_blob_format" CHECK (blob_id ~ '^b3t:[0-9a-f]{64}$');