-- T-108: passkeys for built-in accounts, the invites that make the first one, and the
-- challenges already answered.
CREATE TABLE "invites" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"passkey_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "invites_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "invites_id_format" CHECK (id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "invites_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '168 hours'),
	CONSTRAINT "invites_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "invites_passkey_id_format" CHECK (passkey_id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "invites_use_complete" CHECK ((used_at is null) = (passkey_id is null) and (used_at is null or used_at >= created_at)),
	CONSTRAINT "invites_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "invites_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system|scim):.+$'),
	CONSTRAINT "invites_one_end" CHECK (used_at is null or revoked_at is null)
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"tenant_id" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "passkey_challenges_tenant_id_challenge_hash_pk" PRIMARY KEY("tenant_id","challenge_hash"),
	CONSTRAINT "passkey_challenges_hash_format" CHECK (challenge_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"algorithm" integer NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] NOT NULL,
	"backup_eligible" boolean NOT NULL,
	"backed_up" boolean NOT NULL,
	"aaguid" text NOT NULL,
	"name" text NOT NULL,
	"invite_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkeys_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "passkeys_credential_unique" UNIQUE("tenant_id","credential_id"),
	CONSTRAINT "passkeys_id_format" CHECK (id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "passkeys_credential_id_format" CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 22 and 1364),
	CONSTRAINT "passkeys_public_key_format" CHECK (public_key ~ '^[A-Za-z0-9_-]+$' and char_length(public_key) between 40 and 4096),
	CONSTRAINT "passkeys_algorithm_valid" CHECK (algorithm in (-7, -8, -257)),
	CONSTRAINT "passkeys_sign_count_range" CHECK (sign_count between 0 and 4294967295),
	CONSTRAINT "passkeys_transports_valid" CHECK (cardinality(transports) <= 8 and array_position(transports, null) is null
        and array_to_string(transports, ',') ~ '^([a-z][a-z0-9-]{0,31}(,[a-z][a-z0-9-]{0,31})*)?$'),
	CONSTRAINT "passkeys_backup_state" CHECK (backup_eligible or not backed_up),
	CONSTRAINT "passkeys_aaguid_format" CHECK (aaguid ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "passkeys_name_length" CHECK (char_length(name) between 1 and 100),
	CONSTRAINT "passkeys_invite_id_format" CHECK (invite_id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "passkeys_last_used" CHECK (last_used_at is null or last_used_at >= created_at)
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_user_idx" ON "invites" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "passkey_challenges_expiry_idx" ON "passkey_challenges" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("tenant_id","user_id");