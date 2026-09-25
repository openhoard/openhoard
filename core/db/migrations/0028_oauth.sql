CREATE TABLE "oauth_clients" (
	"tenant_id" text NOT NULL,
	"client_key" text NOT NULL,
	"kind" text NOT NULL,
	"client_ref" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trust" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_tenant_id_client_key_pk" PRIMARY KEY("tenant_id","client_key"),
	CONSTRAINT "oauth_clients_key_format" CHECK (client_key ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_clients_kind_valid" CHECK (kind in ('cimd', 'dcr')),
	CONSTRAINT "oauth_clients_ref_length" CHECK (char_length(client_ref) between 1 and 2048),
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "oauth_clients_redirects" CHECK (cardinality(redirect_uris) between 1 and 20 and array_position(redirect_uris, null) is null),
	CONSTRAINT "oauth_clients_status_valid" CHECK (status in ('pending', 'approved', 'refused')),
	CONSTRAINT "oauth_clients_trust" CHECK ((status = 'approved') = (trust is not null) and (trust is null or trust in ('local', 'commercial', 'consumer'))),
	CONSTRAINT "oauth_clients_decision" CHECK ((status = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
	CONSTRAINT "oauth_clients_requested_by" CHECK (requested_by ~ '^(user|system):.+$'),
	CONSTRAINT "oauth_clients_decided_by" CHECK (decided_by is null or decided_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text NOT NULL,
	"client_key" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"grant_id" text,
	CONSTRAINT "oauth_codes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_codes_id_format" CHECK (id ~ '^oac_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_codes_person_only" CHECK (user_kind in ('member', 'guest')),
	CONSTRAINT "oauth_codes_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_codes_redirect_length" CHECK (char_length(redirect_uri) between 1 and 2048),
	CONSTRAINT "oauth_codes_challenge_format" CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_codes_scopes" CHECK (cardinality(scopes) between 1 and 2 and scopes <@ array['files:read', 'files:tag']::text[]),
	CONSTRAINT "oauth_codes_resource_length" CHECK (char_length(resource) between 1 and 2048),
	CONSTRAINT "oauth_codes_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
	CONSTRAINT "oauth_codes_used" CHECK (used_at is null or used_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text NOT NULL,
	"client_key" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"previous_refresh_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "oauth_grants_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_grants_id_format" CHECK (id ~ '^ogr_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_grants_person_only" CHECK (user_kind in ('member', 'guest')),
	CONSTRAINT "oauth_grants_scopes" CHECK (cardinality(scopes) between 1 and 2 and scopes <@ array['files:read', 'files:tag']::text[]),
	CONSTRAINT "oauth_grants_resource_length" CHECK (char_length(resource) between 1 and 2048),
	CONSTRAINT "oauth_grants_refresh_format" CHECK (refresh_hash ~ '^[0-9a-f]{64}$' and (previous_refresh_hash is null or previous_refresh_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "oauth_grants_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '90 days'),
	CONSTRAINT "oauth_grants_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "oauth_grants_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system|scim):.+$')
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"grant_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_tokens_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_tokens_scopes" CHECK (cardinality(scopes) between 1 and 2 and scopes <@ array['files:read', 'files:tag']::text[]),
	CONSTRAINT "oauth_tokens_id_format" CHECK (id ~ '^oat_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_tokens_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_tokens_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '1 day')
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_fk" FOREIGN KEY ("tenant_id","client_key") REFERENCES "public"."oauth_clients"("tenant_id","client_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_fk" FOREIGN KEY ("tenant_id","client_key") REFERENCES "public"."oauth_clients"("tenant_id","client_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."oauth_grants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("tenant_id","grant_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" USING btree ("tenant_id","client_key");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("tenant_id","grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" USING btree ("tenant_id","expires_at");