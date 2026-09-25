CREATE TABLE "api_keys" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text DEFAULT 'service' NOT NULL,
	"zone_ids" text[],
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"actions" text[] NOT NULL,
	"zones" text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "api_keys_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "api_keys_service_only" CHECK (user_kind = 'service'),
	CONSTRAINT "api_keys_zone_ids_valid" CHECK (zone_ids is null or (cardinality(zone_ids) between 1 and 100
        and array_position(zone_ids, null) is null
        and array_to_string(zone_ids, ',') ~ '^(zon_[0-9a-hjkmnp-tv-z]{26})(,zon_[0-9a-hjkmnp-tv-z]{26})*$')),
	CONSTRAINT "api_keys_id_format" CHECK (id ~ '^key_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "api_keys_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "api_keys_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_actions_valid" CHECK (cardinality(actions) > 0 and actions <@ array['search', 'read', 'open', 'tag']::text[]),
	CONSTRAINT "api_keys_zones_valid" CHECK (cardinality(zones) > 0 and zones <@ array['managed', 'indexed', 'local-only', 'code']::text[]),
	CONSTRAINT "api_keys_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '366 days'),
	CONSTRAINT "api_keys_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "api_keys_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "api_keys_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_unique" UNIQUE("tenant_id","id","kind");
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_kind_valid";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_email" CHECK ((kind = 'service') = (email is null) and (email is null) = (email_key is null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_local" CHECK (kind <> 'service' or source = 'local');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_valid" CHECK (kind in ('member', 'guest', 'service'));