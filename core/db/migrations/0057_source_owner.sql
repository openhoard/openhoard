-- The person a source's owner named on its first run, pinned (review of T-303): an owner's email
-- reused later by someone else never takes the source over.
ALTER TABLE "source_syncs" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_owner_format" CHECK (owner_id is null or owner_id ~ '^user:usr_[0-9a-hjkmnp-tv-z]{26}$');