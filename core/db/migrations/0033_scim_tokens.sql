CREATE TABLE "scim_tokens" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "scim_tokens_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "scim_tokens_id_format" CHECK (id ~ '^sct_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "scim_tokens_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "scim_tokens_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scim_tokens_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '366 days'),
	CONSTRAINT "scim_tokens_last_used" CHECK (last_used_at is null or last_used_at >= created_at),
	CONSTRAINT "scim_tokens_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "scim_tokens_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "scim_tokens_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_name_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "given_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "family_name" text;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_user_name_unique" ON "users" USING btree ("tenant_id","user_name_key") WHERE user_name_key is not null and retired_at is null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_user_name_scim" CHECK (source = 'scim' or user_name is null);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_user_name_complete" CHECK ((user_name is null) = (user_name_key is null)
       and (user_name is null or char_length(user_name) between 1 and 512)
       and (user_name_key is null or char_length(user_name_key) between 1 and 512));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_name_parts_length" CHECK ((given_name is null or char_length(given_name) between 1 and 256)
       and (family_name is null or char_length(family_name) between 1 and 256));