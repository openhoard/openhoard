-- T-303: how each source's last scheduled sync ended, and whether its schedule is stopped for an
-- admin. And one-time sign-in links, for a server without an identity provider (loopback only).
CREATE TABLE "sign_in_links" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"session_id" text,
	CONSTRAINT "sign_in_links_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sign_in_links_id_format" CHECK (id ~ '^sil_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "sign_in_links_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sign_in_links_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
	CONSTRAINT "sign_in_links_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "sign_in_links_use_complete" CHECK ((used_at is null) = (session_id is null) and (used_at is null or used_at >= created_at))
);
--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "last_counts" jsonb;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD COLUMN "stopped_error" text;--> statement-breakpoint
ALTER TABLE "sign_in_links" ADD CONSTRAINT "sign_in_links_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_links_user_idx" ON "sign_in_links" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_last_status_valid" CHECK (last_status is null or last_status in ('done', 'partial', 'retry', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_error_format" CHECK ((last_error is null or last_error ~ '^[a-z0-9][a-z0-9-]{0,63}$') and (stopped_error is null or stopped_error ~ '^[a-z0-9][a-z0-9-]{0,63}$'));--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_last_counts_object" CHECK (last_counts is null or jsonb_typeof(last_counts) = 'object');--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_stop_complete" CHECK ((stopped_at is null) = (stopped_error is null));