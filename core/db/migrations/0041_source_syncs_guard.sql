ALTER TABLE "source_syncs" ADD COLUMN "source_identity" text;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "reconcile_held" integer;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "reconcile_confirmed" integer;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_identity_length" CHECK (source_identity is null or char_length(source_identity) between 1 and 1024);--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_reconcile_counts" CHECK ((reconcile_held is null or reconcile_held >= 0) and (reconcile_confirmed is null or reconcile_confirmed >= 0));