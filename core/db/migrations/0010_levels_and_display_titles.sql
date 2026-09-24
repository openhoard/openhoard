ALTER TABLE "facets" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "display_title" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "display_title_by" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "display_title_for" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_visibility" text DEFAULT 'hidden' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_exposure" text DEFAULT 'metadata-only' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_display_title_length" CHECK (display_title is null or char_length(display_title) between 1 and 1024);--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_display_title_by" CHECK (display_title_by is null or display_title_by ~ '^(user|model):.+$');--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_display_title_has_author" CHECK (display_title is null or display_title_by is not null);--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_display_title_decision" CHECK ((display_title_by is null) = (display_title_for is null));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_visibility_valid" CHECK (default_visibility in ('hidden', 'discoverable', 'readable'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_exposure_valid" CHECK (default_exposure in ('metadata-only', 'local-only', 'commercial-only', 'full'));--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_processed_after_creation" CHECK (processed_at is null or processed_at >= created_at);